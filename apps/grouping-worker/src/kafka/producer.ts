import { Kafka } from 'kafkajs'

export interface EventProducer {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(topic: string, key: string, value: Buffer | string): Promise<void>
}

export function createKafkaProducer(brokers: string[]): EventProducer {
  const kafka = new Kafka({ clientId: 'grouping-worker', brokers })
  const producer = kafka.producer()

  return {
    connect: () => producer.connect(),
    disconnect: () => producer.disconnect(),
    send: async (topic, key, value) => {
      await producer.send({ topic, messages: [{ key, value }] })
    },
  }
}
