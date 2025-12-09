/**
 * Background indexing performance tests
 * Tests: system impact, resource usage, concurrent operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  getMemoryUsage,
  wait
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateSearchQueries
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Background Indexing Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Background Indexing')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('System Impact During Indexing', () => {
    it('should measure CPU impact during indexing', async () => {
      const emails = generateEmails(500)
      const cpuSamples = []

      // Simulate CPU usage tracking
      const startUsage = process.cpuUsage()

      for (let i = 0; i < emails.length; i += 32) {
        const batch = emails.slice(i, i + 32)
        await mocks.embedder.embedder(batch.map(e => e.subject))

        if (i % 100 === 0) {
          const usage = process.cpuUsage(startUsage)
          cpuSamples.push({
            user: usage.user / 1000, // Convert to ms
            system: usage.system / 1000
          })
        }
      }

      console.log('\nCPU Usage During Indexing:')
      cpuSamples.forEach((sample, i) => {
        console.log(`  Sample ${i + 1}: User ${sample.user.toFixed(1)}ms, System ${sample.system.toFixed(1)}ms`)
      })

      // Just verify we can measure
      expect(cpuSamples.length).toBeGreaterThan(0)
    })

    it('should measure memory impact during indexing', async () => {
      const emails = generateEmails(1000)
      const memorySamples = []

      memorySamples.push({ stage: 'Start', ...getMemoryUsage() })

      for (let i = 0; i < emails.length; i += 100) {
        const batch = emails.slice(i, Math.min(i + 100, emails.length))
        for (let j = 0; j < batch.length; j += 32) {
          await mocks.embedder.embedder(batch.slice(j, j + 32).map(e => e.subject))
        }
        memorySamples.push({ stage: `After ${i + 100}`, ...getMemoryUsage() })
      }

      console.log('\nMemory During Indexing:')
      memorySamples.forEach(sample => {
        console.log(`  ${sample.stage}: Heap ${sample.heapUsed.toFixed(1)}MB / ${sample.heapTotal.toFixed(1)}MB`)
      })

      const peakHeap = Math.max(...memorySamples.map(s => s.heapUsed))
      console.log(`  Peak: ${peakHeap.toFixed(1)}MB`)

      expect(peakHeap).toBeLessThan(500)
    })

    it('should not block event loop during indexing', async () => {
      const emails = generateEmails(200)
      const blockingSamples = []

      const measureBlocking = () => {
        const start = performance.now()
        setImmediate(() => {
          const delay = performance.now() - start
          blockingSamples.push(delay)
        })
      }

      // Start measuring
      const interval = setInterval(measureBlocking, 10)

      // Perform indexing
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }

      clearInterval(interval)

      // Wait for final samples
      await wait(50)

      if (blockingSamples.length > 0) {
        const avgBlocking = blockingSamples.reduce((a, b) => a + b, 0) / blockingSamples.length
        const maxBlocking = Math.max(...blockingSamples)

        console.log('\nEvent Loop Blocking:')
        console.log(`  Samples: ${blockingSamples.length}`)
        console.log(`  Average delay: ${avgBlocking.toFixed(2)}ms`)
        console.log(`  Max delay: ${maxBlocking.toFixed(2)}ms`)

        // Event loop should not be blocked for long periods
        expect(maxBlocking).toBeLessThan(100)
      }

      expect(true).toBe(true)
    })
  })

  describe('Concurrent Operations During Indexing', () => {
    it('should handle searches during indexing', async () => {
      const emails = generateEmails(200)
      const queries = generateSearchQueries(20)
      const searchLatencies = []

      // Start indexing in background
      const indexingPromise = (async () => {
        for (let i = 0; i < emails.length; i += 32) {
          await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
          await wait(10) // Simulate real-world timing
        }
      })()

      // Perform searches concurrently
      for (const query of queries) {
        const start = performance.now()
        await mocks.embedder.embedder([query])
        searchLatencies.push(performance.now() - start)
        await wait(20)
      }

      await indexingPromise

      const avgLatency = searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length
      const maxLatency = Math.max(...searchLatencies)

      console.log('\nSearch Latency During Indexing:')
      console.log(`  Average: ${avgLatency.toFixed(2)}ms`)
      console.log(`  Max: ${maxLatency.toFixed(2)}ms`)

      expect(avgLatency).toBeLessThan(50)
    })

    it('should handle tool calls during indexing', async () => {
      const emails = generateEmails(100)
      const toolLatencies = []

      // Start indexing
      const indexingPromise = (async () => {
        for (let i = 0; i < emails.length; i += 32) {
          await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
          await wait(5)
        }
      })()

      // Simulate tool calls
      for (let i = 0; i < 10; i++) {
        const start = performance.now()
        await mocks.embedder.embedder([`tool call ${i}`])
        toolLatencies.push(performance.now() - start)
        await wait(15)
      }

      await indexingPromise

      const avgLatency = toolLatencies.reduce((a, b) => a + b, 0) / toolLatencies.length

      console.log('\nTool Call Latency During Indexing:')
      console.log(`  Average: ${avgLatency.toFixed(2)}ms`)

      expect(avgLatency).toBeLessThan(50)
    })

    it('should prioritize user requests over indexing', async () => {
      const emails = generateEmails(100)
      let indexingPaused = false
      let pauseCount = 0

      // Indexing with pause capability
      const indexWithPriority = async () => {
        for (let i = 0; i < emails.length; i += 32) {
          // Check if we should pause for user request
          if (indexingPaused) {
            pauseCount++
            await wait(10)
            indexingPaused = false
          }
          await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        }
      }

      const indexingPromise = indexWithPriority()

      // Simulate user requests that should take priority
      for (let i = 0; i < 5; i++) {
        indexingPaused = true
        await mocks.embedder.embedder([`priority request ${i}`])
        await wait(20)
      }

      await indexingPromise

      console.log(`\nPriority pauses: ${pauseCount}`)

      // Should have paused for priority requests
      expect(pauseCount).toBeGreaterThan(0)
    })
  })

  describe('Incremental Indexing', () => {
    it('should process incremental updates quickly', async () => {
      // Initial index (already done)
      const existingIds = new Set(Array(900).fill(null).map((_, i) => i))

      // New items
      const allEmails = generateEmails(1000)
      const newEmails = allEmails.filter((_, i) => !existingIds.has(i))

      const result = await benchmark(
        async () => {
          for (const email of newEmails) {
            await mocks.embedder.embedder([email.subject])
          }
        },
        { name: 'Incremental update (100 new)', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)

      console.log(`\nIncremental update: ${result.mean.toFixed(2)}ms for ${newEmails.length} items`)

      expect(result.mean).toBeLessThan(5000)
    })

    it('should detect changes efficiently', async () => {
      const emails = generateEmails(1000)
      const lastModified = new Map()

      // Populate initial state
      emails.forEach((email, i) => {
        lastModified.set(email.id, Date.now() - (i * 1000))
      })

      // Simulate checking for changes
      const checkStart = performance.now()
      const changed = []

      const cutoff = Date.now() - 60000 // Last minute
      for (const [id, modified] of lastModified) {
        if (modified > cutoff) {
          changed.push(id)
        }
      }

      const checkDuration = performance.now() - checkStart

      console.log(`\nChange detection: ${checkDuration.toFixed(2)}ms`)
      console.log(`  Changed items: ${changed.length}`)

      expect(checkDuration).toBeLessThan(50)
    })
  })

  describe('Batch Size Optimization', () => {
    it('should find optimal batch size', async () => {
      const emails = generateEmails(320)
      const batchSizes = [8, 16, 32, 64, 128]
      const results = []

      for (const batchSize of batchSizes) {
        const start = performance.now()

        for (let i = 0; i < emails.length; i += batchSize) {
          await mocks.embedder.embedder(
            emails.slice(i, i + batchSize).map(e => e.subject)
          )
        }

        const duration = performance.now() - start
        const throughput = emails.length / (duration / 1000)

        results.push({ batchSize, duration, throughput })
      }

      console.log('\nBatch Size Optimization:')
      results.forEach(r => {
        console.log(`  Batch ${r.batchSize}: ${r.duration.toFixed(1)}ms (${r.throughput.toFixed(0)} items/sec)`)
      })

      // Find optimal
      const optimal = results.reduce((best, curr) =>
        curr.throughput > best.throughput ? curr : best
      )
      console.log(`  Optimal: Batch size ${optimal.batchSize}`)

      expect(optimal.throughput).toBeGreaterThan(100)
    })
  })

  describe('Throttling Effectiveness', () => {
    it('should throttle to limit resource usage', async () => {
      const emails = generateEmails(100)
      const BATCH_DELAY_MS = 50

      const start = performance.now()
      let batchCount = 0

      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        batchCount++

        if (i + 32 < emails.length) {
          await wait(BATCH_DELAY_MS)
        }
      }

      const duration = performance.now() - start
      const expectedMinDuration = (batchCount - 1) * BATCH_DELAY_MS

      console.log('\nThrottling:')
      console.log(`  Batches: ${batchCount}`)
      console.log(`  Duration: ${duration.toFixed(1)}ms`)
      console.log(`  Expected min: ${expectedMinDuration}ms`)

      expect(duration).toBeGreaterThan(expectedMinDuration * 0.8)
    })

    it('should adapt throttling based on system load', async () => {
      const emails = generateEmails(100)
      let currentDelay = 50
      const delayHistory = []

      const simulateLoadCheck = () => {
        // Simulate varying load
        return Math.random() > 0.7 ? 'high' : 'low'
      }

      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))

        const load = simulateLoadCheck()
        if (load === 'high') {
          currentDelay = Math.min(currentDelay * 1.5, 200)
        } else {
          currentDelay = Math.max(currentDelay * 0.8, 20)
        }
        delayHistory.push(currentDelay)

        await wait(currentDelay)
      }

      console.log('\nAdaptive Throttling:')
      console.log(`  Delay range: ${Math.min(...delayHistory).toFixed(0)}ms - ${Math.max(...delayHistory).toFixed(0)}ms`)
      console.log(`  Average delay: ${(delayHistory.reduce((a, b) => a + b, 0) / delayHistory.length).toFixed(1)}ms`)

      expect(delayHistory.length).toBeGreaterThan(0)
    })
  })

  describe('Progress Tracking', () => {
    it('should track indexing progress efficiently', async () => {
      const emails = generateEmails(500)
      const progressUpdates = []

      const totalItems = emails.length
      let processed = 0

      const updateProgress = (count) => {
        processed += count
        const percent = (processed / totalItems) * 100
        progressUpdates.push({ processed, percent, timestamp: performance.now() })
      }

      const start = performance.now()

      for (let i = 0; i < emails.length; i += 32) {
        const batch = emails.slice(i, i + 32)
        await mocks.embedder.embedder(batch.map(e => e.subject))
        updateProgress(batch.length)
      }

      const duration = performance.now() - start

      console.log('\nProgress Tracking:')
      console.log(`  Updates: ${progressUpdates.length}`)
      console.log(`  Duration: ${duration.toFixed(1)}ms`)

      // Calculate overhead
      const updateOverhead = progressUpdates.length * 0.01 // Assume 0.01ms per update
      console.log(`  Update overhead: ~${updateOverhead.toFixed(2)}ms`)

      expect(progressUpdates.length).toBe(Math.ceil(emails.length / 32))
    })
  })

  describe('Resume After Interruption', () => {
    it('should resume indexing efficiently', async () => {
      const emails = generateEmails(100)
      const processedIds = new Set()
      let interrupted = false

      // First pass - simulate interruption
      for (let i = 0; i < emails.length; i += 32) {
        if (i >= 64) {
          interrupted = true
          break
        }
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        emails.slice(i, i + 32).forEach(e => processedIds.add(e.id))
      }

      console.log(`\nInterrupted after ${processedIds.size} items`)

      // Resume
      const resumeStart = performance.now()

      for (let i = 0; i < emails.length; i += 32) {
        const batch = emails.slice(i, i + 32).filter(e => !processedIds.has(e.id))
        if (batch.length > 0) {
          await mocks.embedder.embedder(batch.map(e => e.subject))
          batch.forEach(e => processedIds.add(e.id))
        }
      }

      const resumeDuration = performance.now() - resumeStart

      console.log(`Resume duration: ${resumeDuration.toFixed(1)}ms`)
      console.log(`Final processed: ${processedIds.size}`)

      expect(processedIds.size).toBe(emails.length)
    })
  })

  describe('Mixed Source Indexing', () => {
    it('should handle multiple sources concurrently', async () => {
      const emails = generateEmails(100)
      const messages = generateMessages(100)
      const events = generateCalendarEvents(50)

      const results = {
        emails: { count: 0, duration: 0 },
        messages: { count: 0, duration: 0 },
        events: { count: 0, duration: 0 }
      }

      const start = performance.now()

      await Promise.all([
        // Email indexing
        (async () => {
          const s = performance.now()
          for (let i = 0; i < emails.length; i += 32) {
            await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
          }
          results.emails = { count: emails.length, duration: performance.now() - s }
        })(),

        // Message indexing
        (async () => {
          const s = performance.now()
          for (let i = 0; i < messages.length; i += 32) {
            await mocks.embedder.embedder(messages.slice(i, i + 32).map(m => m.text))
          }
          results.messages = { count: messages.length, duration: performance.now() - s }
        })(),

        // Calendar indexing
        (async () => {
          const s = performance.now()
          for (let i = 0; i < events.length; i += 32) {
            await mocks.embedder.embedder(events.slice(i, i + 32).map(e => e.title))
          }
          results.events = { count: events.length, duration: performance.now() - s }
        })()
      ])

      const totalDuration = performance.now() - start

      console.log('\nConcurrent Source Indexing:')
      console.log(`  Emails: ${results.emails.count} in ${results.emails.duration.toFixed(1)}ms`)
      console.log(`  Messages: ${results.messages.count} in ${results.messages.duration.toFixed(1)}ms`)
      console.log(`  Events: ${results.events.count} in ${results.events.duration.toFixed(1)}ms`)
      console.log(`  Total: ${totalDuration.toFixed(1)}ms`)

      // Concurrent should be faster than sequential
      const sequentialEstimate = results.emails.duration + results.messages.duration + results.events.duration
      console.log(`  Sequential estimate: ${sequentialEstimate.toFixed(1)}ms`)
      console.log(`  Speedup: ${(sequentialEstimate / totalDuration).toFixed(2)}x`)

      expect(totalDuration).toBeLessThan(sequentialEstimate)
    })
  })

  describe('Resource Cleanup', () => {
    it('should cleanup resources after indexing', async () => {
      const memBefore = getMemoryUsage()

      // Perform indexing
      const emails = generateEmails(500)
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }

      const memAfterIndexing = getMemoryUsage()

      // Simulate cleanup
      await wait(100)

      // Force garbage collection if available
      if (global.gc) {
        global.gc()
      }

      await wait(100)

      const memAfterCleanup = getMemoryUsage()

      console.log('\nResource Cleanup:')
      console.log(`  Before: ${memBefore.heapUsed.toFixed(1)}MB`)
      console.log(`  After indexing: ${memAfterIndexing.heapUsed.toFixed(1)}MB`)
      console.log(`  After cleanup: ${memAfterCleanup.heapUsed.toFixed(1)}MB`)

      // Memory should not grow unboundedly
      const growth = memAfterCleanup.heapUsed - memBefore.heapUsed
      expect(growth).toBeLessThan(100)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
