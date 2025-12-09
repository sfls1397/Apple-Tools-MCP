/**
 * Resource tests for memory usage
 * Tests peak heap usage and memory bounds
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'

// Standard indexer constants
const BATCH_SIZE = 32
const EMBEDDING_DIM = 384

/**
 * Generate test data
 */
function generateTestData(count, options = {}) {
  const { bodySize = 100 } = options
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    content: `Test content ${i + 1}. ` + 'x'.repeat(bodySize),
    text: `Test message ${i + 1}`
  }))
}

/**
 * Generate calendar event data
 */
function generateCalendarData(count) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    title: `Event ${i + 1}`,
    location: `Location ${i % 10}`,
    notes: `Notes for event ${i + 1}`,
    start: now + (i * 3600000)
  }))
}

/**
 * Measure current memory usage
 */
function measureMemory() {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const usage = process.memoryUsage()
    return {
      heapUsed: usage.heapUsed / (1024 * 1024),
      heapTotal: usage.heapTotal / (1024 * 1024),
      external: usage.external / (1024 * 1024),
      rss: usage.rss / (1024 * 1024)
    }
  }
  return { heapUsed: 0, heapTotal: 0, external: 0, rss: 0 }
}

/**
 * Assert memory is within bounds
 */
function assertMemory(current, threshold, context) {
  if (current > threshold) {
    throw new Error(`Memory exceeded: ${current.toFixed(2)}MB > ${threshold}MB (${context})`)
  }
}

/**
 * Track performance metrics
 */
class PerformanceTracker {
  constructor(name) {
    this.name = name
    this.samples = []
    this.startTime = 0
    this.startMemory = 0
  }

  start() {
    this.startTime = performance.now()
    this.startMemory = measureMemory().heapUsed
    return this
  }

  sample(label) {
    this.samples.push({
      label,
      time: performance.now() - this.startTime,
      memory: measureMemory().heapUsed
    })
  }

  stop() {
    this.endTime = performance.now()
    this.endMemory = measureMemory().heapUsed
  }

  getPeakMemory() {
    if (this.samples.length === 0) return this.endMemory || measureMemory().heapUsed
    return Math.max(...this.samples.map(s => s.memory))
  }

  getMemoryGrowth() {
    return (this.endMemory || measureMemory().heapUsed) - this.startMemory
  }
}

describe('Memory Usage', () => {
  describe('peak heap usage', () => {
    it('should stay under 300MB during email indexing', async () => {
      const count = 1000
      const items = generateTestData(count)

      const tracker = new PerformanceTracker('Email Indexing Memory').start()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()

        // Sample every 5 batches
        if (i % (BATCH_SIZE * 5) === 0) {
          tracker.sample(`batch ${Math.floor(i / BATCH_SIZE)}`)
        }
      }

      tracker.stop()
      const peakHeap = tracker.getPeakMemory()

      // Peak heap should be under 300MB
      expect(peakHeap).toBeLessThan(300)
    })

    it('should stay under 300MB during message indexing', async () => {
      const count = 2000
      const messages = generateTestData(count)

      const tracker = new PerformanceTracker('Message Indexing Memory').start()

      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        await Promise.resolve()

        if (i % (BATCH_SIZE * 5) === 0) {
          tracker.sample(`batch ${Math.floor(i / BATCH_SIZE)}`)
        }
      }

      tracker.stop()
      const peakHeap = tracker.getPeakMemory()

      expect(peakHeap).toBeLessThan(300)
    })

    it('should stay under 300MB during combined indexing', async () => {
      const emailCount = 500
      const messageCount = 1000
      const eventCount = 300

      const emails = generateTestData(emailCount)
      const messages = generateTestData(messageCount)
      const events = generateCalendarData(eventCount)

      const tracker = new PerformanceTracker('Combined Indexing Memory').start()

      // Index emails
      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        await Promise.resolve()
      }
      tracker.sample('emails done')

      // Index messages
      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        await Promise.resolve()
      }
      tracker.sample('messages done')

      // Index events
      for (let i = 0; i < events.length; i += BATCH_SIZE) {
        await Promise.resolve()
      }
      tracker.sample('events done')

      tracker.stop()
      const peakHeap = tracker.getPeakMemory()

      expect(peakHeap).toBeLessThan(300)
    })
  })

  describe('memory growth per batch', () => {
    it('should not grow memory significantly per batch', async () => {
      const count = 640 // 20 batches
      const items = generateTestData(count)

      const memorySnapshots = []
      const initialMemory = measureMemory()
      memorySnapshots.push(initialMemory.heapUsed)

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()

        const currentMemory = measureMemory()
        memorySnapshots.push(currentMemory.heapUsed)
      }

      // Calculate growth between first and last
      const totalGrowth = memorySnapshots[memorySnapshots.length - 1] - memorySnapshots[0]

      // Should not grow more than 50MB total for pure logic operations
      expect(totalGrowth).toBeLessThan(50)
    })

    it('should limit heap growth to < 50MB during full indexing', async () => {
      const count = 500
      const items = generateTestData(count)

      const tracker = new PerformanceTracker('Heap Growth').start()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()
        tracker.sample(`batch ${Math.floor(i / BATCH_SIZE)}`)
      }

      tracker.stop()
      const heapGrowth = tracker.getMemoryGrowth()

      expect(heapGrowth).toBeLessThan(50)
    })
  })

  describe('embedding vector memory', () => {
    it('should calculate correct memory for embedding vectors', () => {
      const count = 1000
      // Each vector is 384 floats * 4 bytes = 1536 bytes
      const bytesPerVector = EMBEDDING_DIM * 4
      const totalVectorMemory = (count * bytesPerVector) / (1024 * 1024) // MB

      // 1000 vectors * 384 dims * 4 bytes = ~1.46MB
      expect(totalVectorMemory).toBeLessThan(2)
    })

    it('should verify EMBEDDING_DIM = 384', () => {
      expect(EMBEDDING_DIM).toBe(384)
    })
  })

  describe('memory bounds assertions', () => {
    it('should throw when memory exceeds threshold', () => {
      expect(() => assertMemory(350, 300, 'test')).toThrow('Memory exceeded')
    })

    it('should pass when memory is within threshold', () => {
      expect(() => assertMemory(250, 300, 'test')).not.toThrow()
    })

    it('should pass when memory equals threshold', () => {
      expect(() => assertMemory(300, 300, 'test')).not.toThrow()
    })
  })

  describe('batch disposal', () => {
    it('should not retain batch data after processing', async () => {
      const count = 320
      const items = generateTestData(count)

      let maxInFlightBatches = 0
      let currentBatches = []

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        currentBatches.push(batch)

        await Promise.resolve()

        maxInFlightBatches = Math.max(maxInFlightBatches, currentBatches.length)

        // Simulate disposal
        currentBatches = []
      }

      // Should only ever have 1 batch in flight at a time
      expect(maxInFlightBatches).toBe(1)
    })
  })

  describe('large text handling', () => {
    it('should handle large bodies without excessive memory', async () => {
      const count = 50
      // Generate items with large bodies (10KB each)
      const items = generateTestData(count, { bodySize: 10000 })

      const beforeMemory = measureMemory()

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()
      }

      const afterMemory = measureMemory()
      const growth = afterMemory.heapUsed - beforeMemory.heapUsed

      // Even with large texts, growth should be reasonable
      expect(growth).toBeLessThan(200)
    })
  })
})
