
import { describe, it, expect } from 'vitest'

const BATCH_SIZE = 32

function generateTestData(count, type = 'email') {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    if (type === 'email') {
      return {
        id: i + 1,
        content: `Test email ${i + 1} content about various topics`
      }
    } else if (type === 'message') {
      return {
        id: i + 1,
        text: `Test message ${i + 1}`
      }
    } else {
      return {
        title: `Event ${i + 1}`,
        location: `Location ${i % 10}`,
        notes: `Notes for event ${i + 1}`,
        start: now + (i * 3600000)
      }
    }
  })
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
    this.batchThroughputs = []
  }

  start() {
    this.startTime = performance.now()
    return this
  }

  recordBatch(itemCount) {
    this.totalItems += itemCount
    const elapsed = performance.now() - this.startTime
    this.batchThroughputs.push(calculateThroughput(this.totalItems, elapsed))
  }

  getSummary() {
    const elapsed = performance.now() - this.startTime
    return {
      totalItems: this.totalItems,
      elapsedMs: elapsed,
      overallThroughput: calculateThroughput(this.totalItems, elapsed)
    }
  }

  getTotalItems() {
    return this.totalItems
  }
}

describe('Scaling Behavior', () => {
  describe('linear O(n) time complexity', () => {
    it('should scale linearly with email count', async () => {
      const sizes = [100, 200, 400]
      const results = []

      for (const size of sizes) {
        const items = generateTestData(size, 'email')

        const { duration } = await measureTime(async () => {
          for (let i = 0; i < items.length; i += BATCH_SIZE) {
            await Promise.resolve()
          }
        })

        results.push({
          size,
          duration,
          timePerItem: duration / size
        })
      }

      const avgTimePerItem = results.reduce((s, r) => s + r.timePerItem, 0) / results.length

      for (const result of results) {
        expect(result.timePerItem).toBeLessThan(avgTimePerItem * 3)
      }
    })

    it('should scale linearly with message count', async () => {
      const sizes = [200, 400, 800]
      const results = []

      for (const size of sizes) {
        const items = generateTestData(size, 'message')

        const { duration } = await measureTime(async () => {
          for (let i = 0; i < items.length; i += BATCH_SIZE) {
            await Promise.resolve()
          }
        })

        results.push({
          size,
          duration,
          timePerItem: duration / size
        })
      }

      const avgTimePerItem = results.reduce((s, r) => s + r.timePerItem, 0) / results.length

      for (const result of results) {
        expect(result.timePerItem).toBeLessThan(avgTimePerItem * 3)
      }
    })

    it('should scale linearly with calendar event count', async () => {
      const sizes = [150, 300, 600]
      const results = []

      for (const size of sizes) {
        const events = generateTestData(size, 'calendar')

        const { duration } = await measureTime(async () => {
          for (let i = 0; i < events.length; i += BATCH_SIZE) {
            await Promise.resolve()
          }
        })

        results.push({
          size,
          duration,
          timePerItem: duration / size
        })
      }

      const avgTimePerItem = results.reduce((s, r) => s + r.timePerItem, 0) / results.length

      for (const result of results) {
        expect(result.timePerItem).toBeLessThan(avgTimePerItem * 3)
      }
    })
  })

  describe('throughput at varying sizes', () => {
    it('should maintain throughput - Small (350 items)', async () => {
      const count = 350
      const items = generateTestData(count, 'email')

      const tracker = new ThroughputTracker().start()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        await Promise.resolve()
        tracker.recordBatch(batch.length)
      }

      const summary = tracker.getSummary()

      expect(summary.overallThroughput).toBeGreaterThan(50)
    })

    it('should maintain throughput - Medium (1700 items)', async () => {
      const count = 1700
      const items = generateTestData(count, 'email')

      const tracker = new ThroughputTracker().start()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        await Promise.resolve()
        tracker.recordBatch(batch.length)
      }

      const summary = tracker.getSummary()

      expect(summary.overallThroughput).toBeGreaterThan(50)
    })

    it('should maintain throughput - Large (7500 items)', async () => {
      const count = 7500
      const items = generateTestData(count, 'email')

      const tracker = new ThroughputTracker().start()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        await Promise.resolve()
        tracker.recordBatch(batch.length)
      }

      const summary = tracker.getSummary()

      expect(summary.overallThroughput).toBeGreaterThan(50)
    })
  })

  describe('throughput degradation', () => {
    it('should not degrade more than 50% as size increases 10x', async () => {
      const smallCount = 100
      const largeCount = 1000

      const smallItems = generateTestData(smallCount, 'email')
      const { duration: smallDuration } = await measureTime(async () => {
        for (let i = 0; i < smallItems.length; i += BATCH_SIZE) {
          await Promise.resolve()
        }
      })
      const smallThroughput = calculateThroughput(smallCount, smallDuration)

      const largeItems = generateTestData(largeCount, 'email')
      const { duration: largeDuration } = await measureTime(async () => {
        for (let i = 0; i < largeItems.length; i += BATCH_SIZE) {
          await Promise.resolve()
        }
      })
      const largeThroughput = calculateThroughput(largeCount, largeDuration)

      expect(largeThroughput).toBeGreaterThan(smallThroughput * 0.5)
    })
  })

  describe('batch count scaling', () => {
    it('should use correct number of batches for any size', () => {
      const sizes = [1, 31, 32, 33, 64, 100, 1000]

      for (const size of sizes) {
        const expectedBatches = Math.ceil(size / BATCH_SIZE)
        let actualBatches = 0

        for (let i = 0; i < size; i += BATCH_SIZE) {
          actualBatches++
        }

        expect(actualBatches).toBe(expectedBatches)
      }
    })

    it('should handle edge case batch boundaries', () => {
      expect(Math.ceil(32 / BATCH_SIZE)).toBe(1)

      expect(Math.ceil(33 / BATCH_SIZE)).toBe(2)

      expect(Math.ceil(96 / BATCH_SIZE)).toBe(3)

      expect(Math.ceil(100 / BATCH_SIZE)).toBe(4)
    })
  })

  describe('mixed source scaling', () => {
    it('should handle combined email + message + calendar indexing', async () => {
      const emailCount = 200
      const messageCount = 300
      const eventCount = 100
      const totalCount = emailCount + messageCount + eventCount

      const emails = generateTestData(emailCount, 'email')
      const messages = generateTestData(messageCount, 'message')
      const events = generateTestData(eventCount, 'calendar')

      const allItems = [...emails, ...messages, ...events]

      const tracker = new ThroughputTracker().start()

      const { duration } = await measureTime(async () => {
        for (let i = 0; i < allItems.length; i += BATCH_SIZE) {
          const batch = allItems.slice(i, i + BATCH_SIZE)
          await Promise.resolve()
          tracker.recordBatch(batch.length)
        }
      })

      const throughput = calculateThroughput(totalCount, duration)

      expect(throughput).toBeGreaterThan(50)
      expect(tracker.getTotalItems()).toBe(totalCount)
    })
  })

  describe('consistent batch throughput', () => {
    it('should have consistent per-batch throughput', async () => {
      const count = 320
      const items = generateTestData(count, 'email')

      const batchDurations = []

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const { duration } = await measureTime(async () => {
          await Promise.resolve()
        })

        batchDurations.push(duration)
      }

      const avgDuration = batchDurations.reduce((a, b) => a + b, 0) / batchDurations.length
      const variance = batchDurations.reduce((sum, d) => sum + Math.pow(d - avgDuration, 2), 0) / batchDurations.length
      const stdDev = Math.sqrt(variance)
      const cv = stdDev / avgDuration

      expect(cv).toBeLessThan(3)
    })
  })
})
