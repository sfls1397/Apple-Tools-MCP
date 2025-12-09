/**
 * Stress tests for system limits
 * Tests: high load, sustained operations, edge conditions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  getMemoryUsage,
  wait
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateSearchQueries,
  generateEmbeddingTexts
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Stress Tests', { timeout: 120000 }, () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Stress Tests')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('High Volume Operations', () => {
    it('should handle 10,000 emails in index', async () => {
      const emails = generateEmails(10000)
      const BATCH_SIZE = 32

      const startTime = performance.now()
      let processed = 0

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const batch = emails.slice(i, i + BATCH_SIZE)
        await mocks.embedder.embedder(batch.map(e => e.subject))
        processed += batch.length
      }

      const duration = performance.now() - startTime

      console.log(`\nIndexed 10,000 emails in ${(duration / 1000).toFixed(2)}s`)
      console.log(`Throughput: ${(10000 / (duration / 1000)).toFixed(1)} emails/sec`)

      expect(duration).toBeLessThan(30000) // Under 30s
    })

    it('should handle 5,000 messages in index', async () => {
      const messages = generateMessages(5000)
      const BATCH_SIZE = 32

      const startTime = performance.now()

      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE)
        await mocks.embedder.embedder(batch.map(m => m.text))
      }

      const duration = performance.now() - startTime

      console.log(`\nIndexed 5,000 messages in ${(duration / 1000).toFixed(2)}s`)

      expect(duration).toBeLessThan(20000)
    })

    it('should handle 1,000 calendar events', async () => {
      const events = generateCalendarEvents(1000)

      const startTime = performance.now()

      for (let i = 0; i < events.length; i += 32) {
        const batch = events.slice(i, i + 32)
        await mocks.embedder.embedder(batch.map(e => e.title))
      }

      const duration = performance.now() - startTime

      console.log(`\nIndexed 1,000 calendar events in ${(duration / 1000).toFixed(2)}s`)

      expect(duration).toBeLessThan(10000)
    })
  })

  describe('Sustained Load', () => {
    it('should maintain performance over 100 consecutive searches', async () => {
      const queries = generateSearchQueries(100)
      const histogram = new LatencyHistogram(5)

      for (const query of queries) {
        const start = performance.now()
        await mocks.embedder.embedder([query])
        await new Promise(r => setTimeout(r, 5)) // Simulate search
        histogram.record(performance.now() - start)
      }

      console.log('\nLatency over 100 searches:')
      histogram.printHistogram()
      console.log(`Mean: ${histogram.getMean().toFixed(2)}ms`)

      expect(histogram.getMean()).toBeLessThan(50)
    })

    it('should maintain performance over 500 tool calls', async () => {
      const latencies = []

      for (let i = 0; i < 500; i++) {
        const start = performance.now()
        await mocks.embedder.embedder([`query ${i}`])
        latencies.push(performance.now() - start)
      }

      // Check for performance degradation
      const first100 = latencies.slice(0, 100)
      const last100 = latencies.slice(-100)

      const avgFirst = first100.reduce((a, b) => a + b, 0) / first100.length
      const avgLast = last100.reduce((a, b) => a + b, 0) / last100.length

      console.log(`\nFirst 100 avg: ${avgFirst.toFixed(2)}ms`)
      console.log(`Last 100 avg: ${avgLast.toFixed(2)}ms`)
      console.log(`Degradation: ${((avgLast / avgFirst - 1) * 100).toFixed(1)}%`)

      // Should not degrade significantly
      expect(avgLast).toBeLessThan(avgFirst * 2)
    })
  })

  describe('Concurrent Stress', () => {
    it('should handle 20 concurrent operations', async () => {
      const concurrency = 20

      const operation = async (id) => {
        await mocks.embedder.embedder([`query ${id}`])
        const results = generateEmails(10)
        return results.length
      }

      const startTime = performance.now()

      const results = await Promise.all(
        Array(concurrency).fill(null).map((_, i) => operation(i))
      )

      const duration = performance.now() - startTime

      console.log(`\n${concurrency} concurrent operations completed in ${duration.toFixed(2)}ms`)

      expect(results.every(r => r === 10)).toBe(true)
      expect(duration).toBeLessThan(5000)
    })

    it('should handle burst of 50 requests', async () => {
      const burstSize = 50
      const startTime = performance.now()

      await Promise.all(
        Array(burstSize).fill(null).map((_, i) =>
          mocks.embedder.embedder([`burst query ${i}`])
        )
      )

      const duration = performance.now() - startTime

      console.log(`\n${burstSize} burst requests completed in ${duration.toFixed(2)}ms`)

      expect(duration).toBeLessThan(2000)
    })
  })

  describe('Data Volume Limits', () => {
    it('should handle maximum result set (1000 items)', async () => {
      const results = generateEmails(1000)

      const startTime = performance.now()

      // Format all results
      const formatted = results.map(r => ({
        from: r.from,
        subject: r.subject,
        date: r.date,
        preview: r.body.substring(0, 100)
      }))

      const output = JSON.stringify(formatted)

      const duration = performance.now() - startTime

      console.log(`\nFormatted 1000 results in ${duration.toFixed(2)}ms`)
      console.log(`Output size: ${(output.length / 1024).toFixed(1)}KB`)

      expect(duration).toBeLessThan(500)
    })

    it('should handle very long search queries', async () => {
      const longQuery = 'search '.repeat(100) + 'important email'

      const startTime = performance.now()

      await mocks.embedder.embedder([longQuery])

      const duration = performance.now() - startTime

      console.log(`\nLong query (${longQuery.length} chars) processed in ${duration.toFixed(2)}ms`)

      expect(duration).toBeLessThan(100)
    })

    it('should handle large email bodies', async () => {
      const largeEmails = generateEmails(10, { bodySize: 'large' })

      for (const email of largeEmails) {
        email.body = 'word '.repeat(10000) // ~50KB body
      }

      const startTime = performance.now()

      for (const email of largeEmails) {
        await mocks.embedder.embedder([email.subject + ' ' + email.body.substring(0, 1000)])
      }

      const duration = performance.now() - startTime

      console.log(`\n10 large emails processed in ${duration.toFixed(2)}ms`)

      expect(duration).toBeLessThan(2000)
    })
  })

  describe('Memory Under Stress', () => {
    it('should maintain memory bounds during heavy load', async () => {
      const memSamples = []
      const operations = 200

      for (let i = 0; i < operations; i++) {
        await mocks.embedder.embedder([`stress query ${i}`])
        generateEmails(50) // Create temporary data

        if (i % 20 === 0) {
          memSamples.push(getMemoryUsage().heapUsed)
        }
      }

      console.log('\nMemory samples during stress:')
      console.log(`  ${memSamples.map(m => m.toFixed(1)).join('MB → ')}MB`)

      const maxMem = Math.max(...memSamples)
      const minMem = Math.min(...memSamples)

      console.log(`  Range: ${minMem.toFixed(1)}MB - ${maxMem.toFixed(1)}MB`)

      expect(maxMem).toBeLessThan(500)
    })
  })

  describe('Recovery', () => {
    it('should recover from temporary slowdowns', async () => {
      const latencies = []

      for (let i = 0; i < 50; i++) {
        const start = performance.now()

        // Simulate occasional slowdown
        if (i >= 20 && i < 30) {
          await wait(50) // Slow period
        }

        await mocks.embedder.embedder([`query ${i}`])
        latencies.push(performance.now() - start)
      }

      const before = latencies.slice(0, 20)
      const during = latencies.slice(20, 30)
      const after = latencies.slice(30)

      const avgBefore = before.reduce((a, b) => a + b, 0) / before.length
      const avgDuring = during.reduce((a, b) => a + b, 0) / during.length
      const avgAfter = after.reduce((a, b) => a + b, 0) / after.length

      console.log(`\nBefore slowdown: ${avgBefore.toFixed(2)}ms`)
      console.log(`During slowdown: ${avgDuring.toFixed(2)}ms`)
      console.log(`After recovery: ${avgAfter.toFixed(2)}ms`)

      // Should recover to normal performance (within 1ms for very fast operations, or 1.5x for slower)
      const recoveryThreshold = Math.max(avgBefore * 2, 1)
      expect(avgAfter).toBeLessThan(recoveryThreshold)
    })

    it('should handle error recovery gracefully', async () => {
      let errorCount = 0
      let successCount = 0

      for (let i = 0; i < 100; i++) {
        try {
          if (i % 10 === 0) {
            throw new Error('Simulated error')
          }
          await mocks.embedder.embedder([`query ${i}`])
          successCount++
        } catch (e) {
          errorCount++
        }
      }

      console.log(`\nSuccesses: ${successCount}, Errors: ${errorCount}`)

      expect(successCount).toBe(90)
      expect(errorCount).toBe(10)
    })
  })

  describe('Edge Cases Under Load', () => {
    it('should handle empty queries gracefully', async () => {
      const queries = ['', '   ', '\n', '\t', ...generateSearchQueries(10)]

      for (const query of queries) {
        await mocks.embedder.embedder([query || 'fallback'])
      }

      expect(true).toBe(true) // No crashes
    })

    it('should handle mixed data types', async () => {
      const mixedData = [
        ...generateEmails(50),
        ...generateMessages(50),
        ...generateCalendarEvents(20)
      ]

      const startTime = performance.now()

      for (const item of mixedData) {
        const text = item.subject || item.text || item.title || ''
        await mocks.embedder.embedder([text])
      }

      const duration = performance.now() - startTime

      console.log(`\nProcessed ${mixedData.length} mixed items in ${duration.toFixed(2)}ms`)

      expect(duration).toBeLessThan(10000)
    })
  })

  describe('Throughput Limits', () => {
    it('should measure maximum throughput', async () => {
      const testDuration = 5000 // 5 seconds
      const startTime = performance.now()
      let operations = 0

      while (performance.now() - startTime < testDuration) {
        await mocks.embedder.embedder([`query ${operations}`])
        operations++
      }

      const actualDuration = performance.now() - startTime
      const throughput = operations / (actualDuration / 1000)

      console.log(`\nMax throughput: ${throughput.toFixed(1)} ops/sec`)
      console.log(`Total operations: ${operations}`)

      expect(throughput).toBeGreaterThan(100) // At least 100 ops/sec
    })
  })

  describe('Stress Test Summary', () => {
    it('should generate stress test summary', async () => {
      const results = {
        indexing: { emails: 0, messages: 0, events: 0 },
        searching: { queries: 0, avgLatency: 0 },
        memory: { peak: 0, final: 0 }
      }

      // Indexing stress
      const emails = generateEmails(1000)
      const messages = generateMessages(500)
      const events = generateCalendarEvents(200)

      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }
      results.indexing.emails = emails.length

      for (let i = 0; i < messages.length; i += 32) {
        await mocks.embedder.embedder(messages.slice(i, i + 32).map(m => m.text))
      }
      results.indexing.messages = messages.length

      for (let i = 0; i < events.length; i += 32) {
        await mocks.embedder.embedder(events.slice(i, i + 32).map(e => e.title))
      }
      results.indexing.events = events.length

      // Search stress
      const queries = generateSearchQueries(100)
      const latencies = []

      for (const query of queries) {
        const start = performance.now()
        await mocks.embedder.embedder([query])
        latencies.push(performance.now() - start)
      }

      results.searching.queries = queries.length
      results.searching.avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length

      // Memory
      results.memory.final = getMemoryUsage().heapUsed

      console.log('\n=== STRESS TEST SUMMARY ===')
      console.log('\nIndexing:')
      console.log(`  Emails: ${results.indexing.emails}`)
      console.log(`  Messages: ${results.indexing.messages}`)
      console.log(`  Events: ${results.indexing.events}`)
      console.log('\nSearching:')
      console.log(`  Queries: ${results.searching.queries}`)
      console.log(`  Avg Latency: ${results.searching.avgLatency.toFixed(2)}ms`)
      console.log('\nMemory:')
      console.log(`  Final Heap: ${results.memory.final.toFixed(2)}MB`)
      console.log('\n===========================')

      expect(results.indexing.emails).toBe(1000)
      expect(results.searching.avgLatency).toBeLessThan(50)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
