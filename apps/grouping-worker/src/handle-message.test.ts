import { createDb } from '@flare/db'
import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { handleErrorMessage } from './handle-message'
import { createQueueProducer } from './queue/producer'

const db = createDb(process.env.DATABASE_URL ?? 'postgres://flare:flare@localhost:5432/flare')
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379')
const queueConnection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
const producer = createQueueProducer(queueConnection)

afterAll(async () => {
  await producer.close()
  await db.destroy()
  redis.disconnect()
  queueConnection.disconnect()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handleErrorMessage', () => {
  it('resolves the environment, groups, and persists the event from a job payload', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Handle Msg Test', slug: `handle-msg-${Date.now()}`, public_key: `pk-handle-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const message = {
      projectId: project.id,
      event: {
        event_id: `evt-handle-${Date.now()}`,
        environment: 'staging',
        exception: { values: [{ type: 'TypeError', value: 'boom', stacktrace: { frames: [{ filename: 'app.js', function: 'main', in_app: true }] } }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message)

    const environment = await db
      .selectFrom('environment')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('name', '=', 'staging')
      .executeTakeFirstOrThrow()

    const issues = await db.selectFrom('issue').selectAll().where('project_id', '=', project.id).execute()
    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('TypeError')

    const issueEnv = await db
      .selectFrom('issue_environment')
      .selectAll()
      .where('issue_id', '=', issues[0].id)
      .where('environment_id', '=', environment.id)
      .executeTakeFirstOrThrow()
    expect(issueEnv.times_seen).toBe(1)
  })

  it('publishes to work.symbolication when the event carries a release', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Symbolication Trigger Test', slug: `symtrigger-${Date.now()}`, public_key: `pk-symtrigger-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    let resolveData!: (data: unknown) => void
    const dataPromise = new Promise<unknown>((resolve) => {
      resolveData = resolve
    })
    const worker = new Worker(
      'work.symbolication',
      async (job) => {
        resolveData(job.data)
      },
      { connection: queueConnection }
    )

    const eventId = `evt-sym-${Date.now()}`
    const message = {
      projectId: project.id,
      event: {
        event_id: eventId,
        environment: 'production',
        release: '1.0.0-symtrigger',
        exception: { values: [{ type: 'TypeError', value: 'boom' }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message)
    const published = (await dataPromise) as { projectId: string; eventId: string; releaseId: string }
    await worker.close()

    expect(published.projectId).toBe(project.id)
    expect(published.releaseId).toBeTruthy()

    const event = await db
      .selectFrom('event')
      .selectAll()
      .where('project_id', '=', project.id)
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(event.release_id).toBe(published.releaseId)
    expect(event.id).toBe(published.eventId)
  })

  it('sends a Slack alert for a brand-new issue when a webhook is configured', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Alert New Issue Test', slug: `alert-new-${Date.now()}`, public_key: `pk-alert-new-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const message = {
      projectId: project.id,
      event: {
        event_id: `evt-alert-new-${Date.now()}`,
        environment: 'production',
        exception: { values: [{ type: 'TypeError', value: 'alert boom' }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message, {
      webhookUrl: 'https://hooks.slack.test/alert',
      frequencyThreshold: 100,
      sendEmail: null,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, options] = fetchMock.mock.calls[0]
    expect(JSON.parse(options.body).text).toContain('New issue')
  })

  it('sends an email alert for a brand-new issue when email is configured', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Alert Email New Issue Test', slug: `alert-email-new-${Date.now()}`, public_key: `pk-alert-email-new-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const sendEmail = vi.fn().mockResolvedValue(undefined)

    const message = {
      projectId: project.id,
      event: {
        event_id: `evt-alert-email-new-${Date.now()}`,
        environment: 'production',
        exception: { values: [{ type: 'TypeError', value: 'email alert boom' }] },
      },
    }

    await handleErrorMessage(db, redis, producer, message, {
      webhookUrl: null,
      frequencyThreshold: 100,
      sendEmail,
    })

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const [subject, text] = sendEmail.mock.calls[0]
    expect(subject).toBe('Flare: new issue')
    expect(text).toContain('New issue')
  })

  it('fires both Slack and email when both are configured', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Alert Both Channels Test', slug: `alert-both-${Date.now()}`, public_key: `pk-alert-both-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const sendEmail = vi.fn().mockResolvedValue(undefined)

    await handleErrorMessage(
      db,
      redis,
      producer,
      {
        projectId: project.id,
        event: {
          event_id: `evt-alert-both-${Date.now()}`,
          environment: 'production',
          exception: { values: [{ type: 'TypeError', value: 'both channels boom' }] },
        },
      },
      { webhookUrl: 'https://hooks.slack.test/alert', frequencyThreshold: 100, sendEmail }
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sendEmail).toHaveBeenCalledTimes(1)
  })

  it('sends a Slack alert exactly once when times_seen crosses the configured threshold', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Alert Threshold Test', slug: `alert-threshold-${Date.now()}`, public_key: `pk-alert-threshold-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const alerting = { webhookUrl: 'https://hooks.slack.test/alert', frequencyThreshold: 2, sendEmail: null }
    const fingerprint = `evt-alert-threshold-${Date.now()}`
    const makeMessage = (n: number) => ({
      projectId: project.id,
      event: {
        event_id: `${fingerprint}-${n}`,
        environment: 'production',
        exception: { values: [{ type: 'TypeError', value: fingerprint }] },
      },
    })

    await handleErrorMessage(db, redis, producer, makeMessage(1), alerting) // times_seen -> 1, below threshold
    await handleErrorMessage(db, redis, producer, makeMessage(2), alerting) // times_seen -> 2, crosses threshold
    await handleErrorMessage(db, redis, producer, makeMessage(3), alerting) // times_seen -> 3, past threshold, no re-fire

    const thresholdCalls = fetchMock.mock.calls.filter(([, options]) => JSON.parse(options.body).text.includes('occurred'))
    expect(thresholdCalls).toHaveLength(1)
  })

  it('never calls the webhook when none is configured', async () => {
    const project = await db
      .insertInto('project')
      .values({ name: 'Alert Disabled Test', slug: `alert-disabled-${Date.now()}`, public_key: `pk-alert-disabled-${Date.now()}` })
      .returningAll()
      .executeTakeFirstOrThrow()

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleErrorMessage(db, redis, producer, {
      projectId: project.id,
      event: {
        event_id: `evt-alert-disabled-${Date.now()}`,
        environment: 'production',
        exception: { values: [{ type: 'TypeError', value: 'no alert' }] },
      },
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
