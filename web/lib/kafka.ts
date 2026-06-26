/**
 * Kafka producer — singleton for Next.js server.
 * Produces CiD envelopes to aria.requests.
 * Initialised once on first use, reused across requests.
 */
import { Kafka, logLevel } from 'kafkajs'

const KAFKA_BOOTSTRAP = process.env.KAFKA_BOOTSTRAP || 'aria-kafka:9092'
const TOPIC_REQUESTS  = 'aria.requests'
const TOPIC_DLQ       = 'aria.dlq'

let producer: any = null

async function getProducer() {
  if (producer) return producer

  const kafka = new Kafka({
    clientId: 'aria-web',
    brokers:  [KAFKA_BOOTSTRAP],
    logLevel: logLevel.WARN,
    retry:    { retries: 5, initialRetryTime: 300 },
  })

  producer = kafka.producer({
    allowAutoTopicCreation: true,
    idempotent:             true,
  })

  await producer.connect()
  return producer
}

export interface KafkaEnvelope {
  cid:      string
  task_id:  string
  payload:  Record<string, unknown>
}

/**
 * Produce one message to aria.requests.
 * Returns true on ACK — UI shows delivered.
 * Returns false on failure — UI shows error.
 */
export async function produceRequest(envelope: KafkaEnvelope): Promise<boolean> {
  try {
    const p = await getProducer()
    await p.send({
      topic:    TOPIC_REQUESTS,
      messages: [{
        key:   envelope.cid,
        value: JSON.stringify({
          cid:      envelope.cid,
          task_id:  envelope.task_id,
          topic:    TOPIC_REQUESTS,
          ts:       new Date().toISOString(),
          retry:    0,
          payload:  envelope.payload,
        }),
      }],
    })
    return true
  } catch {
    return false
  }
}
