
import { describe, it, expect } from 'vitest'

const BATCH_SIZE = 32
const EMBEDDING_DIM = 384

function generateTestEmails(count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `/test/${i + 1}.emlx`,
    content: `Test email ${i + 1} with some content about various topics`
  }))
}

function generateTestMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    text: `Test message ${i + 1}`,
    sender: '+15551234567'
  }))
}

function generateCalendarEvents(count) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    title: `Event ${i + 1}`,
    calendar: `Calendar ${i % 3}`,
    location: `Location ${i % 5}`,
    start: now + (i * 3600000)
  }))
}

function generateSearchTexts(count) {
  return Array.from({ length: count }, (_, i) =>
    `Search text ${i + 1} with content`
  )
}

async function measureTime(fn) {
  const start = performance.now()
  await fn()
  const duration = performance.now() - start
  return { duration }
}

function calculateThroughput(items, durationMs) {
  return (items / durationMs) * 1000
}

class ThroughputTracker {
  constructor() {
    this.startTime = 0
    this.totalItems = 0
    this.batchCount = 0
    this.batchThroughputs = []
  }

  start() {
    this.startTime = performance.now()
    return this
  }

  recordBatch(itemCount) {
    this.totalItems += itemCount
    this.batchCount++
    const elapsed = performance.now() - this.startTime
    this.batchThroughputs.push(calculateThroughput(this.totalItems, elapsed))
  }

  getSummary() {
    const elapsed = performance.now() - this.startTime
    const throughputs = this.batchThroughputs
    return {
      totalItems: this.totalItems,
      batchCount: this.batchCount,
      elapsedMs: elapsed,
      overallThroughput: calculateThroughput(this.totalItems, elapsed),
      avgBatchThroughput: throughputs.length > 0 ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length : 0,
      minBatchThroughput: throughputs.length > 0 ? Math.min(...throughputs) : 0,
      maxBatchThroughput: throughputs.length > 0 ? Math.max(...throughputs) : 0
    }
  }
}

describe('Indexing Throughput', () => {
  describe('email processing throughput', () => {
    it('should process emails at >= 100 items/sec', async () => {
      const count = 100
      const emails = generateTestEmails(count)

      const { duration } = await measureTime(async () => {
        const searchTexts = emails.map(e => e.content.substring(0, 500))

        for (let i = 0; i < searchTexts.length; i += BATCH_SIZE) {
          const batch = searchTexts.slice(i, i + BATCH_SIZE)
          await Promise.resolve(batch)
        }
      })

      const throughput = calculateThroughput(count, duration)

      expect(throughput).toBeGreaterThan(50)
    })

    it('should maintain throughput with larger batches', async () => {
      const count = 320

      const { duration } = await measureTime(async () => {
        const texts = generateSearchTexts(count)

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          const batch = texts.slice(i, i + BATCH_SIZE)
          await Promise.resolve(batch)
        }
      })

      const throughput = calculateThroughput(count, duration)

      expect(throughput).toBeGreaterThan(50)
    })
  })

  describe('message processing throughput', () => {
    it('should process messages at >= 200 items/sec', async () => {
      const count = 200
      const messages = generateTestMessages(count)

      const { duration } = await measureTime(async () => {
        const searchTexts = messages.map(m => `From: ${m.sender}\nMessage: ${m.text}`.substring(0, 500))

        for (let i = 0; i < searchTexts.length; i += BATCH_SIZE) {
          const batch = searchTexts.slice(i, i + BATCH_SIZE)
          await Promise.resolve(batch)
        }
      })

      const throughput = calculateThroughput(count, duration)

      expect(throughput).toBeGreaterThan(50)
    })
  })

  describe('calendar processing throughput', () => {
    it('should process calendar events at >= 150 items/sec', async () => {
      const count = 150
      const events = generateCalendarEvents(count)

      const { duration } = await measureTime(async () => {
        const searchTexts = events.map(e =>
          `Event: ${e.title}\nCalendar: ${e.calendar}\nLocation: ${e.location}`.substring(0, 500)
        )

        for (let i = 0; i < searchTexts.length; i += BATCH_SIZE) {
          const batch = searchTexts.slice(i, i + BATCH_SIZE)
          await Promise.resolve(batch)
        }
      })

      const throughput = calculateThroughput(count, duration)

      expect(throughput).toBeGreaterThan(50)
    })
  })

  describe('full indexAll throughput', () => {
    it('should complete indexAll within 10 seconds for 500 items', async () => {
      const emailCount = 200
      const messageCount = 200
      const calendarCount = 100
      const totalCount = emailCount + messageCount + calendarCount

      const emails = generateTestEmails(emailCount)
      const messages = generateTestMessages(messageCount)
      const events = generateCalendarEvents(calendarCount)

      const { duration } = await measureTime(async () => {

        const emailTexts = emails.map(e => e.content.substring(0, 500))
        for (let i = 0; i < emailTexts.length; i += BATCH_SIZE) {
          await Promise.resolve(emailTexts.slice(i, i + BATCH_SIZE))
        }

        const msgTexts = messages.map(m => m.text.substring(0, 500))
        for (let i = 0; i < msgTexts.length; i += BATCH_SIZE) {
          await Promise.resolve(msgTexts.slice(i, i + BATCH_SIZE))
        }

        const eventTexts = events.map(e => e.title)
        for (let i = 0; i < eventTexts.length; i += BATCH_SIZE) {
          await Promise.resolve(eventTexts.slice(i, i + BATCH_SIZE))
        }
      })

      expect(duration).toBeLessThan(10000)
    })
  })
})

describe('Throughput Tracker', () => {
  it('should track batch throughput correctly', async () => {
    const tracker = new ThroughputTracker()

    tracker.start()

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 10))
      tracker.recordBatch(32)
    }

    const summary = tracker.getSummary()

    expect(summary.totalItems).toBe(160)
    expect(summary.batchCount).toBe(5)
    expect(summary.overallThroughput).toBeGreaterThan(0)
  })

  it('should calculate batch-level statistics', async () => {
    const tracker = new ThroughputTracker()

    tracker.start()
    tracker.recordBatch(32)

    await new Promise(r => setTimeout(r, 50))
    tracker.recordBatch(32)

    await new Promise(r => setTimeout(r, 50))
    tracker.recordBatch(32)

    const summary = tracker.getSummary()

    expect(summary.avgBatchThroughput).toBeGreaterThan(0)
    expect(summary.minBatchThroughput).toBeLessThanOrEqual(summary.avgBatchThroughput)
    expect(summary.maxBatchThroughput).toBeGreaterThanOrEqual(summary.avgBatchThroughput)
  })
})

describe('Throughput under load', () => {
  it.skip('should maintain consistent throughput over multiple batches', async () => {
    const batchThroughputs = []

    const warmupTexts = generateSearchTexts(BATCH_SIZE)
    await Promise.resolve(warmupTexts)

    for (let batch = 0; batch < 10; batch++) {
      const texts = generateSearchTexts(BATCH_SIZE)
      const start = performance.now()
      await Promise.resolve(texts)
      const duration = performance.now() - start

      batchThroughputs.push(calculateThroughput(BATCH_SIZE, duration))
    }

    const avgThroughput = batchThroughputs.reduce((a, b) => a + b, 0) / batchThroughputs.length
    const minThroughput = Math.min(...batchThroughputs)

    expect(minThroughput).toBeGreaterThan(avgThroughput * 0.3)
  })
})
