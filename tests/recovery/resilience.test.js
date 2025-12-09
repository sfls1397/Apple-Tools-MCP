/**
 * Recovery / Resilience Testing
 *
 * Tests system ability to recover from failures:
 * - Graceful degradation
 * - Partial failures
 * - State recovery
 * - Retry mechanisms
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.env.HOME, '.apple-tools-mcp', 'lance_index')
const indexExists = fs.existsSync(DB_PATH)

describe('Recovery: Graceful Degradation', () => {
  it('should continue when one data source fails', async () => {
    // Simulate a multi-source search where one fails
    const searchEmail = () => Promise.resolve([{ text: 'email result' }])
    const searchMessages = () => Promise.reject(new Error('Messages unavailable'))
    const searchCalendar = () => Promise.resolve([{ text: 'calendar result' }])

    const results = await Promise.allSettled([
      searchEmail(),
      searchMessages(),
      searchCalendar()
    ])

    // Should have 2 successful, 1 failed
    const successful = results.filter(r => r.status === 'fulfilled')
    expect(successful.length).toBe(2)

    // Can still return partial results
    const partialResults = successful.flatMap(r => r.value)
    expect(partialResults.length).toBe(2)
  })

  it('should use fallback when primary fails', async () => {
    let primaryCalled = false
    let fallbackCalled = false

    const primary = async () => {
      primaryCalled = true
      throw new Error('Primary failed')
    }

    const fallback = async () => {
      fallbackCalled = true
      return 'fallback result'
    }

    // With fallback pattern
    let result
    try {
      result = await primary()
    } catch (e) {
      result = await fallback()
    }

    expect(primaryCalled).toBe(true)
    expect(fallbackCalled).toBe(true)
    expect(result).toBe('fallback result')
  })

  it('should return cached data when live fails', async () => {
    const cache = { data: [{ text: 'cached' }], timestamp: Date.now() }

    const fetchLive = () => Promise.reject(new Error('Network error'))

    const getDataWithCache = async () => {
      try {
        return await fetchLive()
      } catch (e) {
        // Return stale cache if available
        if (cache && cache.timestamp > Date.now() - 3600000) {
          return cache.data
        }
        throw e
      }
    }

    const result = await getDataWithCache()
    expect(result).toEqual([{ text: 'cached' }])
  })
})

describe('Recovery: Retry Mechanisms', () => {
  it('should retry on transient failures', async () => {
    let attempts = 0

    const unreliableOperation = async () => {
      attempts++
      if (attempts < 3) {
        throw new Error('Transient failure')
      }
      return 'success'
    }

    const withRetry = async (fn, maxRetries = 3) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await fn()
        } catch (e) {
          if (i === maxRetries - 1) throw e
        }
      }
    }

    const result = await withRetry(unreliableOperation)

    expect(attempts).toBe(3)
    expect(result).toBe('success')
  })

  it('should fail after max retries', async () => {
    let attempts = 0

    const alwaysFails = async () => {
      attempts++
      throw new Error('Permanent failure')
    }

    const withRetry = async (fn, maxRetries = 3) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await fn()
        } catch (e) {
          if (i === maxRetries - 1) throw e
        }
      }
    }

    try {
      await withRetry(alwaysFails, 3)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e.message).toBe('Permanent failure')
    }

    expect(attempts).toBe(3)
  })

  it('should implement exponential backoff', async () => {
    const delays = []
    let attempts = 0

    const withExponentialBackoff = async (fn, maxRetries = 4) => {
      for (let i = 0; i < maxRetries; i++) {
        try {
          return await fn()
        } catch (e) {
          if (i === maxRetries - 1) throw e
          const delay = Math.pow(2, i) * 100 // 100, 200, 400, 800...
          delays.push(delay)
          // In real code: await new Promise(r => setTimeout(r, delay))
        }
      }
    }

    const failsThrice = async () => {
      attempts++
      if (attempts <= 3) throw new Error('Not yet')
      return 'success'
    }

    const result = await withExponentialBackoff(failsThrice)

    expect(result).toBe('success')
    expect(delays).toEqual([100, 200, 400])
  })
})

describe('Recovery: Partial Results', () => {
  it('should return valid items when some fail', async () => {
    const items = [
      { id: 1, process: () => Promise.resolve({ id: 1, valid: true }) },
      { id: 2, process: () => Promise.reject(new Error('Failed')) },
      { id: 3, process: () => Promise.resolve({ id: 3, valid: true }) },
      { id: 4, process: () => Promise.reject(new Error('Failed')) },
      { id: 5, process: () => Promise.resolve({ id: 5, valid: true }) }
    ]

    const results = await Promise.allSettled(items.map(i => i.process()))
    const validResults = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)

    expect(validResults.length).toBe(3)
    expect(validResults.every(r => r.valid)).toBe(true)
  })

  it('should mark failed items for later retry', async () => {
    const failedIds = []

    const processItem = async (id) => {
      if (id % 2 === 0) throw new Error('Even numbers fail')
      return { id, processed: true }
    }

    const ids = [1, 2, 3, 4, 5, 6]
    const results = []

    for (const id of ids) {
      try {
        results.push(await processItem(id))
      } catch (e) {
        failedIds.push(id)
      }
    }

    expect(results.length).toBe(3) // Odd numbers succeed
    expect(failedIds).toEqual([2, 4, 6])
  })
})

describe('Recovery: State Consistency', () => {
  it('should maintain consistent state after failure', async () => {
    const state = { count: 0, items: [] }

    const transactionalAdd = async (item) => {
      const oldState = { ...state, items: [...state.items] }

      try {
        state.count++
        state.items.push(item)

        if (item === 'fail') {
          throw new Error('Transaction failed')
        }

        return true
      } catch (e) {
        // Rollback
        state.count = oldState.count
        state.items = oldState.items
        throw e
      }
    }

    await transactionalAdd('item1')
    await transactionalAdd('item2')

    try {
      await transactionalAdd('fail')
    } catch (e) {
      // Expected
    }

    await transactionalAdd('item3')

    expect(state.count).toBe(3)
    expect(state.items).toEqual(['item1', 'item2', 'item3'])
    expect(state.items).not.toContain('fail')
  })

  it('should recover from interrupted batch operations', async () => {
    const processedIds = new Set()

    const processBatch = async (ids) => {
      for (const id of ids) {
        if (id === 5) throw new Error('Interrupted at 5')
        processedIds.add(id)
      }
    }

    const ids = [1, 2, 3, 4, 5, 6, 7, 8]

    try {
      await processBatch(ids)
    } catch (e) {
      // Continue from where we left off
      const remainingIds = ids.filter(id => !processedIds.has(id) && id !== 5)
      for (const id of remainingIds) {
        processedIds.add(id)
      }
    }

    expect(processedIds.size).toBe(7) // All except 5
    expect(processedIds.has(5)).toBe(false)
  })
})

describe('Recovery: Error Classification', () => {
  it('should distinguish retryable from permanent errors', () => {
    const isRetryable = (error) => {
      const retryablePatterns = [
        /timeout/i,
        /network/i,
        /temporary/i,
        /ECONNRESET/,
        /ETIMEDOUT/,
        /rate limit/i
      ]
      return retryablePatterns.some(p => p.test(error.message))
    }

    const retryableErrors = [
      new Error('Connection timeout'),
      new Error('Network error'),
      new Error('Temporary unavailable'),
      new Error('Rate limit exceeded')
    ]

    const permanentErrors = [
      new Error('Invalid input'),
      new Error('Not found'),
      new Error('Permission denied'),
      new Error('Validation failed')
    ]

    for (const err of retryableErrors) {
      expect(isRetryable(err)).toBe(true)
    }

    for (const err of permanentErrors) {
      expect(isRetryable(err)).toBe(false)
    }
  })

  it('should handle different error types', () => {
    const handleError = (error) => {
      if (error instanceof TypeError) return 'type_error'
      if (error instanceof RangeError) return 'range_error'
      if (error instanceof SyntaxError) return 'syntax_error'
      if (error.code === 'ENOENT') return 'file_not_found'
      if (error.code === 'EACCES') return 'permission_denied'
      return 'unknown'
    }

    expect(handleError(new TypeError('wrong type'))).toBe('type_error')
    expect(handleError(new RangeError('out of range'))).toBe('range_error')

    const fileError = new Error('ENOENT')
    fileError.code = 'ENOENT'
    expect(handleError(fileError)).toBe('file_not_found')
  })
})

describe.skipIf(!indexExists)('Recovery: Database Reconnection', () => {
  it('should reconnect after connection loss', async () => {
    const { connect } = await import('@lancedb/lancedb')

    // First connection
    let db = await connect(DB_PATH)
    const tables1 = await db.tableNames()

    // Simulate reconnection
    db = await connect(DB_PATH)
    const tables2 = await db.tableNames()

    // Both should return same results
    expect(tables1).toEqual(tables2)
  })

  it('should handle stale connection', async () => {
    const { connect } = await import('@lancedb/lancedb')

    const db = await connect(DB_PATH)
    const tables = await db.tableNames()

    if (tables.length === 0) return

    // Open table, then "simulate" reconnection
    const tbl1 = await db.openTable(tables[0])

    // Create new connection (simulating recovery)
    const db2 = await connect(DB_PATH)
    const tbl2 = await db2.openTable(tables[0])

    // Both should work
    const results1 = await tbl1.query().limit(5).toArray()
    const results2 = await tbl2.query().limit(5).toArray()

    expect(results1.length).toBeLessThanOrEqual(5)
    expect(results2.length).toBeLessThanOrEqual(5)
  })
})

describe('Recovery: Validation Recovery', () => {
  it('should return safe defaults for invalid inputs', async () => {
    const { validateLimit, validateDaysBack, validateWeekOffset } = await import('../../lib/validators.js')

    const invalidInputs = [
      undefined, null, NaN, Infinity, -1, 'invalid', [], {}, () => {}
    ]

    for (const input of invalidInputs) {
      const limit = validateLimit(input)
      const days = validateDaysBack(input)
      const week = validateWeekOffset(input)

      // All should return valid numbers
      expect(typeof limit).toBe('number')
      expect(typeof days).toBe('number')
      expect(typeof week).toBe('number')
      expect(limit).toBeGreaterThan(0)
      expect(days).toBeGreaterThanOrEqual(0)
      expect(week).toBeGreaterThanOrEqual(0)
    }
  })

  it('should sanitize potentially dangerous strings', async () => {
    const { validateSearchQuery, escapeSQL, stripHtmlTags } = await import('../../lib/validators.js')

    const dangerous = [
      '<script>alert(1)</script>',
      "'; DROP TABLE users; --",
      '{{constructor.constructor("return this")()}}',
      '${process.env.SECRET}'
    ]

    for (const input of dangerous) {
      const sanitized = escapeSQL(stripHtmlTags(validateSearchQuery(input)))

      // stripHtmlTags should remove script tags
      expect(sanitized).not.toMatch(/<script/i)

      // escapeSQL should escape single quotes making SQL injection ineffective
      // The original "'; DROP TABLE" becomes "''; DROP TABLE" which is safe
      if (input.includes("'")) {
        expect(sanitized).toContain("''") // Quote should be escaped
      }
    }
  })
})

describe('Recovery: Memory Cleanup', () => {
  it('should not leak memory in error paths', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const initialMem = process.memoryUsage().heapUsed

    // Generate many errors
    for (let i = 0; i < 10000; i++) {
      try {
        validateSearchQuery(null)
      } catch (e) {
        // Expected
      }
    }

    // Force GC if available
    if (global.gc) global.gc()

    const finalMem = process.memoryUsage().heapUsed
    const growth = (finalMem - initialMem) / 1024 / 1024

    console.log(`  → Memory growth after 10k errors: ${growth.toFixed(1)}MB`)

    // Should not grow significantly
    expect(growth).toBeLessThan(20)
  })

  it('should release resources after failed operations', async () => {
    const resources = []

    const acquireResource = () => {
      const resource = { id: Date.now(), released: false }
      resources.push(resource)
      return resource
    }

    const releaseResource = (resource) => {
      resource.released = true
    }

    const operationWithCleanup = async (shouldFail) => {
      const resource = acquireResource()
      try {
        if (shouldFail) throw new Error('Operation failed')
        return 'success'
      } finally {
        releaseResource(resource)
      }
    }

    // Successful operation
    await operationWithCleanup(false)

    // Failed operation
    try {
      await operationWithCleanup(true)
    } catch (e) {
      // Expected
    }

    // Both resources should be released
    expect(resources.every(r => r.released)).toBe(true)
  })
})
