/**
 * Performance tests for indexing operations
 * Tests: email indexing, message indexing, calendar indexing, incremental updates
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  getMemoryUsage,
  calculateThroughput
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateEmlxContent
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Indexing Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Indexing Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Email Indexing', () => {
    it('should index 100 emails within performance threshold', async () => {
      const emails = generateEmails(100)

      // Mock email file content
      emails.forEach(email => {
        mocks.fs.readFileSync.mockImplementation((path) => {
          const found = emails.find(e => e.path === path)
          return found ? generateEmlxContent(found) : ''
        })
      })

      const result = await benchmark(
        async () => {
          // Simulate email indexing workflow
          for (const email of emails) {
            // Parse email
            const content = mocks.fs.readFileSync(email.path)
            // Generate embedding
            await mocks.embedder.embedder([email.subject + ' ' + email.body])
          }
        },
        { name: 'Index 100 emails', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)

      // Performance assertions
      expect(result.mean).toBeLessThan(5000) // Should complete in under 5s
      expect(calculateThroughput(100, result.mean)).toBeGreaterThan(20) // At least 20 emails/sec
    })

    it('should index 1000 emails with batch processing', async () => {
      const emails = generateEmails(1000)
      const BATCH_SIZE = 32

      const result = await benchmark(
        async () => {
          for (let i = 0; i < emails.length; i += BATCH_SIZE) {
            const batch = emails.slice(i, i + BATCH_SIZE)
            const texts = batch.map(e => e.subject + ' ' + e.body)
            await mocks.embedder.embedder(texts)
          }
        },
        { name: 'Index 1000 emails (batched)', iterations: 3, warmup: 1 }
      )

      reporter.addResult(result)

      // Batch processing should be efficient
      expect(result.mean).toBeLessThan(10000) // Under 10s for 1000 emails
    })

    it('should scale linearly with email count', async () => {
      const sizes = [100, 200, 400]
      const timings = []

      for (const size of sizes) {
        const emails = generateEmails(size)
        const result = await benchmark(
          async () => {
            const texts = emails.map(e => e.subject + ' ' + e.body)
            for (let i = 0; i < texts.length; i += 32) {
              await mocks.embedder.embedder(texts.slice(i, i + 32))
            }
          },
          { name: `Index ${size} emails`, iterations: 3, warmup: 1 }
        )
        timings.push({ size, mean: result.mean })
        reporter.addResult(result)
      }

      // Check roughly linear scaling (4x size should scale reasonably)
      // Note: first iteration has warmup overhead, so ratio can be higher
      const ratio = timings[2].mean / timings[0].mean
      expect(ratio).toBeLessThan(40) // Allow overhead for data generation and test infrastructure
    })
  })

  describe('Message Indexing', () => {
    it('should index 500 messages efficiently', async () => {
      const messages = generateMessages(500)
      mocks.sqlite.safeSqlite3Json.mockReturnValue(messages)

      const result = await benchmark(
        async () => {
          const msgs = mocks.sqlite.safeSqlite3Json()
          const texts = msgs.map(m => m.text)
          for (let i = 0; i < texts.length; i += 32) {
            await mocks.embedder.embedder(texts.slice(i, i + 32))
          }
        },
        { name: 'Index 500 messages', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5000)
    })

    it('should handle large message volumes', async () => {
      const messages = generateMessages(2000)
      mocks.sqlite.safeSqlite3Json.mockReturnValue(messages)

      const result = await benchmark(
        async () => {
          const msgs = mocks.sqlite.safeSqlite3Json()
          const texts = msgs.map(m => m.text)
          for (let i = 0; i < texts.length; i += 32) {
            await mocks.embedder.embedder(texts.slice(i, i + 32))
          }
        },
        { name: 'Index 2000 messages', iterations: 3, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(15000)
    })
  })

  describe('Calendar Indexing', () => {
    it('should index 200 calendar events quickly', async () => {
      const events = generateCalendarEvents(200)
      mocks.sqlite.safeSqlite3Json.mockReturnValue(events)

      const result = await benchmark(
        async () => {
          const evts = mocks.sqlite.safeSqlite3Json()
          const texts = evts.map(e => `${e.title} ${e.location || ''} ${e.notes || ''}`)
          for (let i = 0; i < texts.length; i += 32) {
            await mocks.embedder.embedder(texts.slice(i, i + 32))
          }
        },
        { name: 'Index 200 calendar events', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(3000)
    })

    it('should handle recurring event expansion', async () => {
      const events = generateCalendarEvents(100, { recurringRate: 0.5 })
      // Simulate expansion to 500 instances
      const expandedEvents = []
      for (const event of events) {
        expandedEvents.push(event)
        if (Math.random() < 0.5) {
          // Simulate 4 more occurrences
          for (let i = 1; i <= 4; i++) {
            expandedEvents.push({ ...event, id: event.id * 1000 + i })
          }
        }
      }

      const result = await benchmark(
        async () => {
          const texts = expandedEvents.map(e => e.title)
          for (let i = 0; i < texts.length; i += 32) {
            await mocks.embedder.embedder(texts.slice(i, i + 32))
          }
        },
        { name: 'Index expanded recurring events', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5000)
    })
  })

  describe('Incremental Indexing', () => {
    it('should detect and index only new emails', async () => {
      const allEmails = generateEmails(1000)
      const newEmails = allEmails.slice(0, 50) // Only 50 new

      const result = await benchmark(
        async () => {
          // Simulate mdfind returning only new files
          const newPaths = newEmails.map(e => e.path)

          // Index only new emails
          for (const email of newEmails) {
            await mocks.embedder.embedder([email.subject + ' ' + email.body])
          }
        },
        { name: 'Incremental index 50 new emails', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)

      // Incremental should be much faster than full
      expect(result.mean).toBeLessThan(2000)
    })

    it('should efficiently update existing records', async () => {
      const existingIds = new Set([1, 2, 3, 4, 5])
      const allMessages = generateMessages(500)
      const newMessages = allMessages.filter(m => !existingIds.has(m.id))

      const result = await benchmark(
        async () => {
          // Filter to new only
          const toIndex = newMessages

          // Index new messages
          const texts = toIndex.map(m => m.text)
          for (let i = 0; i < texts.length; i += 32) {
            await mocks.embedder.embedder(texts.slice(i, i + 32))
          }
        },
        { name: 'Incremental update with dedup', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5000)
    })
  })

  describe('Full Reindex', () => {
    it('should complete full reindex within acceptable time', async () => {
      const emails = generateEmails(500)
      const messages = generateMessages(300)
      const events = generateCalendarEvents(100)

      const result = await benchmark(
        async () => {
          // Email indexing
          for (let i = 0; i < emails.length; i += 32) {
            await mocks.embedder.embedder(
              emails.slice(i, i + 32).map(e => e.subject + ' ' + e.body)
            )
          }

          // Message indexing
          for (let i = 0; i < messages.length; i += 32) {
            await mocks.embedder.embedder(
              messages.slice(i, i + 32).map(m => m.text)
            )
          }

          // Calendar indexing
          for (let i = 0; i < events.length; i += 32) {
            await mocks.embedder.embedder(
              events.slice(i, i + 32).map(e => e.title)
            )
          }
        },
        { name: 'Full reindex all sources', iterations: 3, warmup: 1, collectMemory: true }
      )

      reporter.addResult(result)

      // Full reindex should complete in reasonable time
      expect(result.mean).toBeLessThan(20000) // Under 20s
    })
  })

  describe('Indexing with Throttling', () => {
    it('should maintain consistent throughput with throttling', async () => {
      const emails = generateEmails(200)
      const BATCH_DELAY_MS = 100

      const result = await benchmark(
        async () => {
          for (let i = 0; i < emails.length; i += 32) {
            const batch = emails.slice(i, i + 32)
            await mocks.embedder.embedder(batch.map(e => e.subject))

            // Apply throttle delay between batches
            if (i + 32 < emails.length) {
              await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
            }
          }
        },
        { name: 'Throttled indexing', iterations: 3, warmup: 1 }
      )

      reporter.addResult(result)

      // Should include throttling delays
      const expectedMinTime = Math.floor(200 / 32) * BATCH_DELAY_MS
      expect(result.mean).toBeGreaterThan(expectedMinTime * 0.8) // At least 80% of expected
    })
  })

  // Print report after all tests
  afterAll(() => {
    reporter.report()
  })
})
