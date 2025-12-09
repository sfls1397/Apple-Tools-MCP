/**
 * Performance tests for memory and resource usage
 * Tests: memory limits, leak detection, GC behavior, resource cleanup
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  getMemoryUsage,
  forceGC,
  wait
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateEmbeddingTexts,
  generateMockEmbeddings
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Memory Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Memory Performance')
    forceGC() // Start with clean heap if possible
  })

  afterEach(() => {
    vi.restoreAllMocks()
    forceGC()
  })

  describe('Memory Bounds', () => {
    it('should stay within heap limits during indexing', async () => {
      const memSamples = []
      const emails = generateEmails(1000)

      memSamples.push(getMemoryUsage())

      // Simulate indexing in batches
      for (let i = 0; i < emails.length; i += 32) {
        const batch = emails.slice(i, i + 32)
        await mocks.embedder.embedder(batch.map(e => e.subject))

        if (i % 100 === 0) {
          memSamples.push(getMemoryUsage())
        }
      }

      memSamples.push(getMemoryUsage())

      console.log('\nMemory during indexing:')
      memSamples.forEach((m, i) => {
        console.log(`  Sample ${i}: ${m.heapUsed.toFixed(2)}MB heap, ${m.rss.toFixed(2)}MB RSS`)
      })

      const maxHeap = Math.max(...memSamples.map(m => m.heapUsed))
      console.log(`Peak heap: ${maxHeap.toFixed(2)}MB`)

      // Should not exceed reasonable limits (varies by environment/Node version)
      expect(maxHeap).toBeLessThan(800) // 800MB max
    })

    it('should handle large result sets within memory limits', async () => {
      const memBefore = getMemoryUsage()

      // Large result set
      const results = generateEmails(5000)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory for 5000 results: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(100) // Should be < 100MB
    })

    it('should limit vector storage memory', async () => {
      const memBefore = getMemoryUsage()

      // Generate many embeddings
      const embeddings = generateMockEmbeddings(10000, 384)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      // 10000 × 384 × 4 bytes = ~15MB for vectors
      console.log(`\nMemory for 10000 vectors: ${growth.toFixed(2)}MB`)
      console.log(`Expected: ~15MB`)

      expect(growth).toBeLessThan(50) // Allow overhead
    })
  })

  describe('Memory Leak Detection', () => {
    it('should not leak memory during repeated searches', async () => {
      const iterations = 20
      const memSamples = []

      for (let i = 0; i < iterations; i++) {
        await mocks.embedder.embedder([`search query ${i}`])
        generateEmails(50) // Create temporary results

        if (i % 5 === 0) {
          forceGC()
          await wait(10)
          memSamples.push(getMemoryUsage().heapUsed)
        }
      }

      console.log('\nMemory samples during searches:')
      console.log(`  ${memSamples.map(m => m.toFixed(2)).join('MB → ')}MB`)

      // Check for linear growth (potential leak)
      const firstHalf = memSamples.slice(0, Math.floor(memSamples.length / 2))
      const secondHalf = memSamples.slice(Math.floor(memSamples.length / 2))

      const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
      const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

      console.log(`  First half avg: ${avgFirst.toFixed(2)}MB`)
      console.log(`  Second half avg: ${avgSecond.toFixed(2)}MB`)

      // Memory should not grow significantly
      expect(avgSecond - avgFirst).toBeLessThan(20)
    })

    it('should not leak memory during repeated tool calls', async () => {
      const memBefore = getMemoryUsage()

      for (let i = 0; i < 100; i++) {
        // Simulate tool call
        await mocks.embedder.embedder(['query'])
        const results = generateEmails(20)
        const formatted = results.map(r => JSON.stringify(r))
        // Results should be garbage collected
      }

      forceGC()
      await wait(50)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory growth after 100 tool calls: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(30)
    })

    it('should release batch memory after processing', async () => {
      const memBefore = getMemoryUsage()

      for (let batch = 0; batch < 10; batch++) {
        const texts = generateEmbeddingTexts(100)
        await mocks.embedder.embedder(texts)
        // texts should be eligible for GC
      }

      forceGC()
      await wait(50)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory growth after 10 batches: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(20)
    })
  })

  describe('Cache Memory', () => {
    it('should limit embedding cache size', async () => {
      const cache = new Map()
      const MAX_CACHE_SIZE = 1000

      const memBefore = getMemoryUsage()

      // Fill cache
      for (let i = 0; i < 2000; i++) {
        const text = `text ${i}`
        const embedding = generateMockEmbeddings(1, 384)[0]

        if (cache.size >= MAX_CACHE_SIZE) {
          // LRU-style eviction (simple: remove first)
          const firstKey = cache.keys().next().value
          cache.delete(firstKey)
        }

        cache.set(text, embedding)
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nCache size: ${cache.size}`)
      console.log(`Memory for bounded cache: ${growth.toFixed(2)}MB`)

      expect(cache.size).toBe(MAX_CACHE_SIZE)
      expect(growth).toBeLessThan(30)
    })

    it('should handle cache TTL correctly', async () => {
      const cache = new Map()
      const TTL_MS = 100 // Short TTL for testing

      // Add entries with timestamps
      for (let i = 0; i < 100; i++) {
        cache.set(`key${i}`, { value: i, timestamp: Date.now() })
      }

      await wait(TTL_MS + 50)

      // Cleanup expired entries
      const now = Date.now()
      for (const [key, entry] of cache) {
        if (now - entry.timestamp > TTL_MS) {
          cache.delete(key)
        }
      }

      expect(cache.size).toBe(0)
    })
  })

  describe('Resource Cleanup', () => {
    it('should cleanup after indexing', async () => {
      const memBefore = getMemoryUsage()

      // Simulate full indexing
      const emails = generateEmails(500)
      const messages = generateMessages(300)
      const events = generateCalendarEvents(100)

      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }

      // Clear references
      const emailCount = emails.length // Keep just the count

      forceGC()
      await wait(100)

      const memAfter = getMemoryUsage()
      console.log(`\nBefore indexing: ${memBefore.heapUsed.toFixed(2)}MB`)
      console.log(`After indexing: ${memAfter.heapUsed.toFixed(2)}MB`)

      // Memory should return close to baseline
      const retained = memAfter.heapUsed - memBefore.heapUsed
      expect(retained).toBeLessThan(50)
    })

    it('should handle table cleanup', async () => {
      const db = mocks.lancedb
      const connection = await db.connect('/tmp/test-db')

      // Create and populate tables
      await connection.createTable('emails', generateEmails(100))
      await connection.createTable('messages', generateMessages(100))
      await connection.createTable('calendar', generateCalendarEvents(50))

      expect(db.tables.size).toBe(3)

      // Drop tables
      await connection.dropTable('emails')
      await connection.dropTable('messages')
      await connection.dropTable('calendar')

      expect(db.tables.size).toBe(0)
    })
  })

  describe('Concurrent Memory Usage', () => {
    it('should handle concurrent operations within limits', async () => {
      const memBefore = getMemoryUsage()

      // Simulate concurrent tool calls
      await Promise.all([
        mocks.embedder.embedder(generateEmbeddingTexts(50)),
        mocks.embedder.embedder(generateEmbeddingTexts(50)),
        mocks.embedder.embedder(generateEmbeddingTexts(50)),
        mocks.embedder.embedder(generateEmbeddingTexts(50)),
        mocks.embedder.embedder(generateEmbeddingTexts(50))
      ])

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory for 5 concurrent embeddings: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(50)
    })
  })

  describe('Array Buffer Management', () => {
    it('should manage Float32Array allocations', async () => {
      const memBefore = getMemoryUsage()

      for (let i = 0; i < 1000; i++) {
        const vector = new Float32Array(384)
        vector.fill(Math.random())
        // Vector should be GC'd after iteration
      }

      forceGC()
      await wait(50)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory after 1000 vector allocations: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(10)
    })

    it('should handle large batch allocations', async () => {
      const memBefore = getMemoryUsage()

      // Simulate batch embedding output
      const batchSize = 32
      const iterations = 100

      for (let i = 0; i < iterations; i++) {
        const output = new Float32Array(batchSize * 384)
        // Process and discard
      }

      forceGC()
      await wait(50)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory after ${iterations} batch allocations: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(10)
    })
  })

  describe('String Memory', () => {
    it('should handle large text processing', async () => {
      const memBefore = getMemoryUsage()

      for (let i = 0; i < 100; i++) {
        const largeText = 'word '.repeat(1000) // ~5KB per text
        const processed = largeText.toLowerCase().split(' ')
        // Should be GC'd
      }

      forceGC()
      await wait(50)

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory after processing 100 large texts: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(20)
    })
  })

  describe('Memory Efficiency Report', () => {
    it('should report memory efficiency metrics', async () => {
      const metrics = {
        indexing: { before: 0, after: 0, peak: 0 },
        searching: { before: 0, after: 0, peak: 0 },
        tools: { before: 0, after: 0, peak: 0 }
      }

      // Indexing
      forceGC()
      metrics.indexing.before = getMemoryUsage().heapUsed

      const emails = generateEmails(500)
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        const current = getMemoryUsage().heapUsed
        metrics.indexing.peak = Math.max(metrics.indexing.peak, current)
      }

      forceGC()
      await wait(50)
      metrics.indexing.after = getMemoryUsage().heapUsed

      // Searching
      metrics.searching.before = getMemoryUsage().heapUsed

      for (let i = 0; i < 50; i++) {
        await mocks.embedder.embedder([`query ${i}`])
        const current = getMemoryUsage().heapUsed
        metrics.searching.peak = Math.max(metrics.searching.peak, current)
      }

      forceGC()
      await wait(50)
      metrics.searching.after = getMemoryUsage().heapUsed

      // Tools
      metrics.tools.before = getMemoryUsage().heapUsed

      for (let i = 0; i < 20; i++) {
        const results = generateEmails(50)
        JSON.stringify(results)
        const current = getMemoryUsage().heapUsed
        metrics.tools.peak = Math.max(metrics.tools.peak, current)
      }

      forceGC()
      await wait(50)
      metrics.tools.after = getMemoryUsage().heapUsed

      console.log('\n=== Memory Efficiency Report ===')
      for (const [operation, data] of Object.entries(metrics)) {
        console.log(`\n${operation.toUpperCase()}:`)
        console.log(`  Before: ${data.before.toFixed(2)}MB`)
        console.log(`  Peak:   ${data.peak.toFixed(2)}MB`)
        console.log(`  After:  ${data.after.toFixed(2)}MB`)
        console.log(`  Retained: ${(data.after - data.before).toFixed(2)}MB`)
      }

      // All operations should clean up properly
      for (const data of Object.values(metrics)) {
        expect(data.after - data.before).toBeLessThan(20)
      }
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
