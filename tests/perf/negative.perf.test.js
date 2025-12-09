/**
 * Negative/Failure Path Performance Tests
 * Tests: error handling speed, invalid inputs, missing data, resource exhaustion
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
  generateCalendarEvents
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Negative Performance Tests', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Negative Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Error Path Performance', () => {
    it('should handle errors quickly without blocking', async () => {
      const errorFn = async () => {
        throw new Error('Simulated error')
      }

      const result = await benchmark(
        async () => {
          try {
            await errorFn()
          } catch (e) {
            // Error handled
          }
        },
        { name: 'Error handling', iterations: 100, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1) // Error handling should be < 1ms
    })

    it('should not leak memory during repeated errors', async () => {
      const memBefore = getMemoryUsage()

      for (let i = 0; i < 1000; i++) {
        try {
          throw new Error(`Error ${i}`)
        } catch (e) {
          // Handle error
        }
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory growth after 1000 errors: ${growth.toFixed(2)}MB`)
      expect(growth).toBeLessThan(10)
    })

    it('should handle async rejection efficiently', async () => {
      const rejectingFn = () => Promise.reject(new Error('Async error'))

      const result = await benchmark(
        async () => {
          try {
            await rejectingFn()
          } catch (e) {
            // Handled
          }
        },
        { name: 'Async rejection handling', iterations: 100, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle error with stack trace creation efficiently', async () => {
      const result = await benchmark(
        async () => {
          try {
            const error = new Error('Error with stack')
            error.stack // Access stack trace
            throw error
          } catch (e) {
            const stack = e.stack // Use stack trace
          }
        },
        { name: 'Error with stack trace', iterations: 100, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Invalid Input Handling', () => {
    it('should handle null/undefined queries quickly', async () => {
      const invalidQueries = [null, undefined, '', '   ', '\n\t']

      const result = await benchmark(
        async () => {
          for (const query of invalidQueries) {
            try {
              if (!query || !query.trim()) {
                throw new Error('Invalid query')
              }
              await mocks.embedder.embedder([query])
            } catch (e) {
              // Handled
            }
          }
        },
        { name: 'Invalid query handling', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle very long queries without hanging', async () => {
      const veryLongQuery = 'word '.repeat(10000) // ~50KB query

      const result = await benchmark(
        async () => {
          // Truncate to reasonable length
          const truncated = veryLongQuery.substring(0, 1000)
          await mocks.embedder.embedder([truncated])
        },
        { name: 'Long query handling', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should handle special characters in queries', async () => {
      const specialQueries = [
        '!@#$%^&*()',
        '<script>alert("xss")</script>',
        'SELECT * FROM users; DROP TABLE users;--',
        '../../etc/passwd',
        '\x00\x01\x02\x03',
        '🎉🎊🎈🎁',
        'Ä Ö Ü ß',
        '中文测试',
        'العربية'
      ]

      const result = await benchmark(
        async () => {
          for (const query of specialQueries) {
            await mocks.embedder.embedder([query])
          }
        },
        { name: 'Special character queries', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should handle invalid limit values', async () => {
      const invalidLimits = [-1, 0, Infinity, NaN, 1000000]

      const result = await benchmark(
        async () => {
          for (const limit of invalidLimits) {
            const sanitized = Math.max(1, Math.min(isFinite(limit) ? limit : 100, 1000))
            // Use sanitized limit
          }
        },
        { name: 'Invalid limit handling', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle invalid date inputs', async () => {
      const invalidDates = [
        'not a date',
        '2024-13-45', // Invalid month/day
        '99999-01-01',
        '',
        null,
        undefined,
        NaN,
        Infinity
      ]

      const result = await benchmark(
        async () => {
          for (const dateInput of invalidDates) {
            try {
              const parsed = new Date(dateInput)
              if (isNaN(parsed.getTime())) {
                throw new Error('Invalid date')
              }
            } catch (e) {
              // Use default date
            }
          }
        },
        { name: 'Invalid date handling', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Missing/Corrupted Data', () => {
    it('should handle missing email files gracefully', async () => {
      mocks.fs.existsSync.mockReturnValue(false)
      mocks.fs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file')
      })

      const result = await benchmark(
        async () => {
          for (let i = 0; i < 100; i++) {
            try {
              mocks.fs.readFileSync(`/missing/path/${i}.emlx`)
            } catch (e) {
              // File not found - handled
            }
          }
        },
        { name: 'Missing file handling', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle corrupted email content', async () => {
      const corruptedContents = [
        '', // Empty
        'garbage data without headers',
        'From: \nTo: \nSubject: \n\n', // Missing values
        '\x00\x01\x02\x03\x04\x05', // Binary garbage
        'From: test@test.com\n'.repeat(1000), // Malformed
      ]

      const result = await benchmark(
        async () => {
          for (const content of corruptedContents) {
            try {
              // Attempt to parse
              const lines = content.split('\n')
              const headers = {}
              for (const line of lines) {
                if (!line.includes(':')) continue
                const [key, value] = line.split(':')
                headers[key?.trim()?.toLowerCase()] = value?.trim() || ''
              }
            } catch (e) {
              // Parse error handled
            }
          }
        },
        { name: 'Corrupted content parsing', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle SQLite database errors', async () => {
      mocks.sqlite.safeSqlite3Json.mockImplementation(() => {
        throw new Error('SQLITE_BUSY: database is locked')
      })

      const result = await benchmark(
        async () => {
          try {
            mocks.sqlite.safeSqlite3Json('test.db', 'SELECT * FROM test')
          } catch (e) {
            // Database error handled
          }
        },
        { name: 'SQLite error handling', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle empty database results', async () => {
      mocks.sqlite.safeSqlite3Json.mockReturnValue([])

      const result = await benchmark(
        async () => {
          const results = mocks.sqlite.safeSqlite3Json('test.db', 'SELECT * FROM test')
          if (results.length === 0) {
            // Handle empty results
            return { message: 'No results found', results: [] }
          }
        },
        { name: 'Empty result handling', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle missing LanceDB tables', async () => {
      const db = await mocks.lancedb.connect('/tmp/test')
      db.openTable.mockRejectedValue(new Error('Table not found'))

      const result = await benchmark(
        async () => {
          try {
            await db.openTable('nonexistent')
          } catch (e) {
            // Table not found - create or skip
          }
        },
        { name: 'Missing table handling', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })
  })

  describe('Resource Exhaustion', () => {
    it('should handle memory pressure gracefully', async () => {
      const largeArrays = []
      const memBefore = getMemoryUsage()

      const result = await benchmark(
        async () => {
          // Create and discard large objects
          for (let i = 0; i < 10; i++) {
            const arr = new Array(10000).fill({ data: 'x'.repeat(100) })
            // Let it be garbage collected
          }
        },
        { name: 'Memory pressure handling', iterations: 10, warmup: 2, collectMemory: true }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })

    it('should handle rapid successive operations', async () => {
      const result = await benchmark(
        async () => {
          const promises = []
          for (let i = 0; i < 100; i++) {
            promises.push(mocks.embedder.embedder([`query${i}`]))
          }
          await Promise.all(promises)
        },
        { name: 'Rapid operations', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })

    it('should handle lock contention simulation', async () => {
      let lockHolder = null

      const acquireLock = async (id) => {
        const maxRetries = 5
        for (let i = 0; i < maxRetries; i++) {
          if (lockHolder === null) {
            lockHolder = id
            return true
          }
          await wait(1)
        }
        return false
      }

      const releaseLock = (id) => {
        if (lockHolder === id) {
          lockHolder = null
        }
      }

      const result = await benchmark(
        async () => {
          const acquired = await acquireLock('test')
          if (acquired) {
            // Do work
            await wait(1)
            releaseLock('test')
          }
        },
        { name: 'Lock contention', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Timeout Behavior', () => {
    it('should handle slow operations with timeout', async () => {
      const withTimeout = async (fn, timeoutMs) => {
        return Promise.race([
          fn(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), timeoutMs)
          )
        ])
      }

      const result = await benchmark(
        async () => {
          try {
            await withTimeout(
              () => new Promise(resolve => setTimeout(resolve, 5)),
              100
            )
          } catch (e) {
            // Timeout handled
          }
        },
        { name: 'Timeout handling (success)', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should abort long-running operations quickly', async () => {
      const abortController = { aborted: false }

      const abortableOperation = async (controller) => {
        for (let i = 0; i < 100; i++) {
          if (controller.aborted) {
            throw new Error('Aborted')
          }
          await wait(1)
        }
      }

      const result = await benchmark(
        async () => {
          const controller = { aborted: false }

          // Abort after 10ms
          setTimeout(() => { controller.aborted = true }, 10)

          try {
            await abortableOperation(controller)
          } catch (e) {
            // Aborted as expected
          }
        },
        { name: 'Abort handling', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Graceful Degradation', () => {
    it('should degrade gracefully with partial data', async () => {
      const emails = generateEmails(100)
      // Remove some fields to simulate partial data
      emails.forEach((e, i) => {
        if (i % 3 === 0) delete e.subject
        if (i % 4 === 0) delete e.body
        if (i % 5 === 0) delete e.from
      })

      const result = await benchmark(
        async () => {
          for (const email of emails) {
            const text = [
              email.subject || '',
              email.body || '',
              email.from || ''
            ].filter(Boolean).join(' ')

            if (text.trim()) {
              await mocks.embedder.embedder([text])
            }
          }
        },
        { name: 'Partial data handling', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(200)
    })

    it('should continue after individual item failures', async () => {
      const items = Array(100).fill(null).map((_, i) => ({
        id: i,
        shouldFail: i % 10 === 0
      }))

      let successCount = 0
      let failCount = 0

      const result = await benchmark(
        async () => {
          successCount = 0
          failCount = 0

          for (const item of items) {
            try {
              if (item.shouldFail) {
                throw new Error('Item failed')
              }
              successCount++
            } catch (e) {
              failCount++
            }
          }
        },
        { name: 'Continue after failures', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
      expect(failCount).toBe(10)
      expect(successCount).toBe(90)
    })

    it('should fall back to simpler processing on complex failures', async () => {
      const complexProcess = async (text) => {
        if (text.length > 100) {
          throw new Error('Text too complex')
        }
        await mocks.embedder.embedder([text])
        return { type: 'complex', result: 'processed' }
      }

      const simpleProcess = (text) => {
        return { type: 'simple', result: text.substring(0, 50) }
      }

      const texts = [
        'short text',
        'a'.repeat(200),
        'another short',
        'b'.repeat(150),
        'final short'
      ]

      const result = await benchmark(
        async () => {
          for (const text of texts) {
            try {
              await complexProcess(text)
            } catch (e) {
              simpleProcess(text)
            }
          }
        },
        { name: 'Fallback processing', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })
  })

  describe('Error Logging Performance', () => {
    it('should log errors without significant overhead', async () => {
      const errorLog = []

      const logError = (error, context) => {
        errorLog.push({
          timestamp: Date.now(),
          message: error.message,
          stack: error.stack,
          context
        })
      }

      const result = await benchmark(
        async () => {
          errorLog.length = 0
          for (let i = 0; i < 100; i++) {
            try {
              throw new Error(`Error ${i}`)
            } catch (e) {
              logError(e, { iteration: i })
            }
          }
        },
        { name: 'Error logging', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Cleanup After Errors', () => {
    it('should cleanup resources after errors', async () => {
      const resources = []

      const acquireResource = () => {
        const resource = { id: Date.now(), active: true }
        resources.push(resource)
        return resource
      }

      const releaseResource = (resource) => {
        resource.active = false
      }

      const result = await benchmark(
        async () => {
          const resource = acquireResource()
          try {
            throw new Error('Operation failed')
          } catch (e) {
            // Error handled
          } finally {
            releaseResource(resource)
          }
        },
        { name: 'Resource cleanup', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)

      // All resources should be released
      expect(resources.every(r => !r.active)).toBe(true)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
