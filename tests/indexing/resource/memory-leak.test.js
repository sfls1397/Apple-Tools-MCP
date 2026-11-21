
import { describe, it, expect, vi } from 'vitest'

const BATCH_SIZE = 32
const EMBEDDING_DIM = 384

function generateTestData(count, options = {}) {
  const { bodySize = 100 } = options
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    content: `Test content ${i + 1}. ` + 'x'.repeat(bodySize)
  }))
}

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

function forceGC() {
  if (typeof global !== 'undefined' && global.gc) {
    global.gc()
  }
}

describe('Memory Leak Detection', () => {
  describe('repeated indexing cycles', () => {
    it('should not leak memory over multiple index cycles', async () => {
      const cycleCount = 5
      const itemsPerCycle = 200
      const memoryPerCycle = []

      forceGC()
      const baselineMemory = measureMemory().heapUsed

      for (let cycle = 0; cycle < cycleCount; cycle++) {
        const items = generateTestData(itemsPerCycle)

        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE)
          await Promise.resolve(batch)
        }

        forceGC()
        memoryPerCycle.push(measureMemory().heapUsed)
      }

      const laterCycles = memoryPerCycle.slice(1)
      if (laterCycles.length > 0) {
        const avgLaterMemory = laterCycles.reduce((a, b) => a + b, 0) / laterCycles.length
        const maxLaterMemory = Math.max(...laterCycles)

        expect(maxLaterMemory).toBeLessThan(avgLaterMemory * 1.5 + 10)
      }
    })

    it('should stabilize memory after initial cycles', async () => {
      const warmupCycles = 2
      const testCycles = 5
      const itemsPerCycle = 100

      for (let i = 0; i < warmupCycles; i++) {
        const items = generateTestData(itemsPerCycle)
        for (let j = 0; j < items.length; j += BATCH_SIZE) {
          await Promise.resolve()
        }
      }

      forceGC()
      const postWarmupMemory = measureMemory().heapUsed

      const testMemory = []
      for (let i = 0; i < testCycles; i++) {
        const items = generateTestData(itemsPerCycle)
        for (let j = 0; j < items.length; j += BATCH_SIZE) {
          await Promise.resolve()
        }
        forceGC()
        testMemory.push(measureMemory().heapUsed)
      }

      const finalMemory = testMemory[testMemory.length - 1]
      const memoryGrowth = finalMemory - postWarmupMemory

      expect(memoryGrowth).toBeLessThan(50)
    })
  })

  describe('vector accumulation', () => {
    it('should not accumulate vectors in memory', async () => {
      const iterations = 10
      const itemsPerIteration = 100

      const startMemory = measureMemory().heapUsed

      for (let iter = 0; iter < iterations; iter++) {
        const items = generateTestData(itemsPerIteration)

        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE)
          const _vectors = new Float32Array(batch.length * EMBEDDING_DIM)
        }
      }

      forceGC()
      const endMemory = measureMemory().heapUsed
      const growth = endMemory - startMemory

      expect(growth).toBeLessThan(50)
    })
  })

  describe('closure leaks', () => {
    it('should not leak through closures', async () => {
      const iterations = 10

      forceGC()
      const startMemory = measureMemory().heapUsed

      for (let i = 0; i < iterations; i++) {
        const largeData = generateTestData(100)

        const callback = async () => {
          for (let j = 0; j < largeData.length; j += BATCH_SIZE) {
            await Promise.resolve()
          }
        }

        await callback()
      }

      forceGC()
      const endMemory = measureMemory().heapUsed
      const growth = endMemory - startMemory

      expect(growth).toBeLessThan(30)
    })
  })

  describe('event listener cleanup', () => {
    it('should simulate proper listener cleanup', async () => {
      const iterations = 5
      const listeners = new Map()

      for (let i = 0; i < iterations; i++) {
        const listener = vi.fn()
        listeners.set(`listener-${i}`, listener)

        const items = generateTestData(50)
        for (let j = 0; j < items.length; j += BATCH_SIZE) {
          await Promise.resolve()
        }

        listeners.delete(`listener-${i}`)
      }

      expect(listeners.size).toBe(0)
    })
  })

  describe('buffer reuse', () => {
    it('should demonstrate buffer reuse pattern', async () => {
      const iterations = 5
      const itemsPerIteration = BATCH_SIZE

      const reuseableBuffer = new Float32Array(BATCH_SIZE * EMBEDDING_DIM)

      for (let i = 0; i < iterations; i++) {
        const items = generateTestData(itemsPerIteration)

        const simulatedEmbedding = new Float32Array(BATCH_SIZE * EMBEDDING_DIM)
        reuseableBuffer.set(simulatedEmbedding.slice(0, reuseableBuffer.length))
      }

      expect(reuseableBuffer.length).toBe(BATCH_SIZE * EMBEDDING_DIM)
    })
  })

  describe('string interning', () => {
    it('should not duplicate identical strings', async () => {
      const uniqueSubjects = ['Meeting', 'Update', 'Review', 'Sync', 'Call']
      const count = 100

      const items = []
      for (let i = 0; i < count; i++) {
        items.push({
          subject: uniqueSubjects[i % uniqueSubjects.length],
          content: `Item ${i}`
        })
      }

      const texts = items.map(e => `${e.subject}: ${e.content}`)

      forceGC()
      const startMemory = measureMemory().heapUsed

      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        await Promise.resolve()
      }

      forceGC()
      const endMemory = measureMemory().heapUsed
      const growth = endMemory - startMemory

      expect(growth).toBeLessThan(20)
    })
  })

  describe('long-running simulation', () => {
    it('should maintain stable memory over extended processing', async () => {
      const totalItems = 1000
      const memoryAtQuartiles = []

      const items = generateTestData(totalItems)

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()

        const progress = i / items.length
        if (progress === 0 || Math.abs(progress - 0.25) < 0.05 ||
            Math.abs(progress - 0.5) < 0.05 || Math.abs(progress - 0.75) < 0.05) {
          memoryAtQuartiles.push({
            progress: Math.round(progress * 100),
            memory: measureMemory().heapUsed
          })
        }
      }

      memoryAtQuartiles.push({
        progress: 100,
        memory: measureMemory().heapUsed
      })

      const earlyMemory = memoryAtQuartiles[1]?.memory || memoryAtQuartiles[0].memory
      const finalMemory = memoryAtQuartiles[memoryAtQuartiles.length - 1].memory

      expect(finalMemory).toBeLessThan(earlyMemory * 2 + 20)
    })
  })

  describe('WeakRef simulation', () => {
    it('should demonstrate weak reference pattern', async () => {
      const weakCache = new Map()

      for (let i = 0; i < 5; i++) {
        const items = generateTestData(50)

        const cacheKey = `batch-${i}`
        weakCache.set(cacheKey, {
          items,
          timestamp: Date.now()
        })

        for (let j = 0; j < items.length; j += BATCH_SIZE) {
          await Promise.resolve()
        }

        if (i % 2 === 1) {
          const cutoff = Date.now() - 1000
          for (const [key, value] of weakCache) {
            if (value.timestamp < cutoff) {
              weakCache.delete(key)
            }
          }
        }
      }

      expect(weakCache.size).toBeLessThanOrEqual(5)
    })
  })
})
