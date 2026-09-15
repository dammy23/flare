import { Kafka } from 'kafkajs'
import { describe, expect, it } from 'vitest'
import { startConsumer } from './consumer'

const brokers = [process.env.KAFKA_BROKERS ?? 'localhost:9092']

describe('startConsumer', () => {
  it('invokes onMessage for each message produced to the topic', async () => {
    const topic = `grouping-worker-test-${Date.now()}`
    const kafka = new Kafka({ clientId: 'test-producer', brokers })
    const producer = kafka.producer()
    await producer.connect()

    const received: string[] = []
    const stop = await startConsumer(brokers, `test-group-${Date.now()}`, topic, async (value) => {
      received.push(value.toString('utf8'))
    })

    await producer.send({ topic, messages: [{ value: 'hello-from-test' }] })

    await new Promise((resolve) => setTimeout(resolve, 2000))

    expect(received).toContain('hello-from-test')

    await producer.disconnect()
    await stop()
  })
})
