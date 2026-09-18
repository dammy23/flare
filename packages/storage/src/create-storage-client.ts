import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
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
  }
}
