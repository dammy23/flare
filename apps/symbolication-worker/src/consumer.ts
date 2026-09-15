import { Kafka } from 'kafkajs'

export type MessageHandler = (value: Buffer) => Promise<void>

export async function startConsumer(
  brokers: string[],
  groupId: string,
  topic: string,
  onMessage: MessageHandler
): Promise<() => Promise<void>> {
  const kafka = new Kafka({ clientId: 'symbolication-worker', brokers })
  const consumer = kafka.consumer({ groupId })

  await consumer.connect()
  await consumer.subscribe({ topic, fromBeginning: true })

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) await onMessage(message.value)
    },
  })

  return () => consumer.disconnect()
}
