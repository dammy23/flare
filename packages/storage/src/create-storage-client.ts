import {
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface StorageClientConfig {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

export interface StorageClient {
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>
  getObject(key: string): Promise<Buffer>
  getPresignedDownloadUrl(key: string, expirySeconds?: number): Promise<string>
  applyLifecycleRule(ruleId: string, keyPrefix: string, expirationDays: number): Promise<void>
}

export function createStorageClient(config: StorageClientConfig): StorageClient {
  const s3 = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
  })

  return {
    putObject: async (key, body, contentType) => {
      await s3.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType })
      )
    },
    getObject: async (key) => {
      const result = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
      const chunks: Uint8Array[] = []
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) chunks.push(chunk)
      return Buffer.concat(chunks)
    },
    getPresignedDownloadUrl: (key, expirySeconds = 300) =>
      getSignedUrl(s3, new GetObjectCommand({ Bucket: config.bucket, Key: key }), { expiresIn: expirySeconds }),
    // PutBucketLifecycleConfiguration replaces the bucket's entire rule
    // set on every call -- calling this for two different prefixes needs
    // both rules passed together in one call, not two separate calls.
    // Only one prefix is configured today, so this doesn't matter yet.
    applyLifecycleRule: async (ruleId, keyPrefix, expirationDays) => {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: config.bucket,
          LifecycleConfiguration: {
            Rules: [
              {
                ID: ruleId,
                Status: 'Enabled',
                Filter: { Prefix: keyPrefix },
                Expiration: { Days: expirationDays },
              },
            ],
          },
        })
      )
    },
  }
}
