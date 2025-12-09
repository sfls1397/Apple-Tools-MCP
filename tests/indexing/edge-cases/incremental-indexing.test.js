/**
 * Edge case tests for incremental indexing
 * Tests timestamp boundaries, batch sizes, and ID edge cases
 */

import { describe, it, expect } from 'vitest'

// Mac Absolute Time epoch: Jan 1, 2001 00:00:00 UTC
const MAC_ABSOLUTE_EPOCH = 978307200
const ONE_HOUR_MS = 60 * 60 * 1000
const BATCH_SIZE = 32
const BATCH_DELETE_SIZE = 100

describe('Incremental Indexing Edge Cases', () => {
  describe('timestamp edge cases', () => {
    // Convert Unix ms to Mac Absolute nanoseconds (like in indexer.js)
    const unixMsToMacAbsoluteNs = (unixMs) => {
      return (unixMs / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000
    }

    // Convert Mac Absolute nanoseconds to Unix ms
    const macAbsoluteNsToUnixMs = (macNs) => {
      return (macNs / 1000000000 + MAC_ABSOLUTE_EPOCH) * 1000
    }

    it('should handle Mac Absolute Time at epoch (Jan 1, 2001 00:00:00)', () => {
      // At Mac epoch, Mac Absolute Time is 0
      const macEpochUnixMs = MAC_ABSOLUTE_EPOCH * 1000

      const macAbsoluteNs = unixMsToMacAbsoluteNs(macEpochUnixMs)
      expect(macAbsoluteNs).toBe(0)

      // Round trip
      const backToUnixMs = macAbsoluteNsToUnixMs(macAbsoluteNs)
      expect(backToUnixMs).toBe(macEpochUnixMs)
    })

    it('should handle timestamps before Mac epoch (pre-2001)', () => {
      // Year 2000 - before Mac epoch
      const year2000 = new Date('2000-06-15T12:00:00Z').getTime()

      const macAbsoluteNs = unixMsToMacAbsoluteNs(year2000)
      expect(macAbsoluteNs).toBeLessThan(0)

      // Verify this creates a valid SQL filter (negative number)
      const sqlFilter = `AND m.date >= ${macAbsoluteNs}`
      expect(sqlFilter).toContain('-')
    })

    it('should handle future timestamps (clock skew)', () => {
      // 1 year in the future
      const futureTimestamp = Date.now() + 365 * 24 * 60 * 60 * 1000

      const macAbsoluteNs = unixMsToMacAbsoluteNs(futureTimestamp)
      expect(macAbsoluteNs).toBeGreaterThan(0)

      // Should still produce valid SQL
      const sqlFilter = `AND m.date >= ${macAbsoluteNs}`
      expect(sqlFilter).not.toContain('NaN')
      expect(sqlFilter).not.toContain('Infinity')
    })

    it('should handle message timestamp exactly at buffer boundary', () => {
      // Scenario: lastIndexTime = T, buffer = 1 hour
      // Message timestamp = T - 1 hour exactly
      const lastIndexTime = Date.now()
      const effectiveTimestamp = lastIndexTime - ONE_HOUR_MS

      // Message at exact boundary
      const messageTimestamp = effectiveTimestamp

      // Should be included (>= comparison)
      const isIncluded = messageTimestamp >= effectiveTimestamp
      expect(isIncluded).toBe(true)
    })

    it('should handle message 1ms before buffer boundary', () => {
      const lastIndexTime = Date.now()
      const effectiveTimestamp = lastIndexTime - ONE_HOUR_MS

      // Message 1ms before boundary
      const messageTimestamp = effectiveTimestamp - 1

      // Should NOT be included
      const isIncluded = messageTimestamp >= effectiveTimestamp
      expect(isIncluded).toBe(false)
    })

    it('should handle Unix epoch (1970-01-01)', () => {
      const unixEpoch = 0

      const macAbsoluteNs = unixMsToMacAbsoluteNs(unixEpoch)
      // Should be negative (1970 is before 2001)
      expect(macAbsoluteNs).toBeLessThan(0)

      // Should be approximately -31 years in nanoseconds
      const expectedNs = -MAC_ABSOLUTE_EPOCH * 1000000000
      expect(macAbsoluteNs).toBe(expectedNs)
    })

    it('should handle very large timestamps (year 3000)', () => {
      const year3000 = new Date('3000-01-01T00:00:00Z').getTime()

      const macAbsoluteNs = unixMsToMacAbsoluteNs(year3000)
      expect(Number.isFinite(macAbsoluteNs)).toBe(true)

      // Verify no precision loss
      const roundTrip = macAbsoluteNsToUnixMs(macAbsoluteNs)
      expect(Math.abs(roundTrip - year3000)).toBeLessThan(1) // Within 1ms
    })
  })

  describe('batch boundary edge cases', () => {
    const createBatches = (items, batchSize) => {
      const batches = []
      for (let i = 0; i < items.length; i += batchSize) {
        batches.push(items.slice(i, i + batchSize))
      }
      return batches
    }

    it('should handle exactly BATCH_SIZE items', () => {
      const items = Array.from({ length: BATCH_SIZE }, (_, i) => ({ id: i }))
      const batches = createBatches(items, BATCH_SIZE)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(BATCH_SIZE)
    })

    it('should handle BATCH_SIZE + 1 items', () => {
      const items = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => ({ id: i }))
      const batches = createBatches(items, BATCH_SIZE)

      expect(batches).toHaveLength(2)
      expect(batches[0]).toHaveLength(BATCH_SIZE)
      expect(batches[1]).toHaveLength(1)
    })

    it('should handle exactly BATCH_DELETE_SIZE items for calendar', () => {
      const items = Array.from({ length: BATCH_DELETE_SIZE }, (_, i) => `id-${i}`)
      const batches = createBatches(items, BATCH_DELETE_SIZE)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(BATCH_DELETE_SIZE)
    })

    it('should handle 101 stale calendar entries (tests chunking)', () => {
      const items = Array.from({ length: 101 }, (_, i) => `stale-${i}`)
      const batches = createBatches(items, BATCH_DELETE_SIZE)

      expect(batches).toHaveLength(2)
      expect(batches[0]).toHaveLength(100)
      expect(batches[1]).toHaveLength(1)
    })

    it('should handle empty batch after dedup filtering', () => {
      const allItems = [{ id: 1 }, { id: 2 }, { id: 3 }]
      const indexedIds = new Set(['1', '2', '3'])

      const toIndex = allItems.filter(item => !indexedIds.has(String(item.id)))
      expect(toIndex).toHaveLength(0)

      const batches = createBatches(toIndex, BATCH_SIZE)
      expect(batches).toHaveLength(0)
    })

    it('should handle single item batch', () => {
      const items = [{ id: 1 }]
      const batches = createBatches(items, BATCH_SIZE)

      expect(batches).toHaveLength(1)
      expect(batches[0]).toHaveLength(1)
    })

    it('should handle items that fill exactly N batches', () => {
      const numBatches = 5
      const items = Array.from({ length: BATCH_SIZE * numBatches }, (_, i) => ({ id: i }))
      const batches = createBatches(items, BATCH_SIZE)

      expect(batches).toHaveLength(numBatches)
      batches.forEach(batch => {
        expect(batch).toHaveLength(BATCH_SIZE)
      })
    })
  })

  describe('ID edge cases', () => {
    // Validate ID for LanceDB (like validateLanceDBId in indexer.js)
    const validateLanceDBId = (id) => {
      if (typeof id !== 'string') return null
      if (id.length === 0 || id.length > 1000) return null

      // Only allow safe characters
      const safePattern = /^[a-zA-Z0-9._@<>:\-\/\s]+$/
      if (!safePattern.test(id)) return null

      return id
    }

    // Escape SQL string (like escapeSQL in indexer.js)
    const escapeSQL = (str) => {
      if (typeof str !== 'string') return ''
      return str.replace(/'/g, "''")
    }

    it('should handle calendar ID with hyphen in dbId', () => {
      // Calendar ID format: "${dbId}-${startTimestamp}"
      const dbId = 'abc-123-def'
      const startTimestamp = 1234567890
      const calendarId = `${dbId}-${startTimestamp}`

      // Should be valid
      const validated = validateLanceDBId(calendarId)
      expect(validated).toBe(calendarId)

      // Should parse correctly
      const lastHyphen = calendarId.lastIndexOf('-')
      const extractedDbId = calendarId.substring(0, lastHyphen)
      const extractedTimestamp = calendarId.substring(lastHyphen + 1)

      expect(extractedDbId).toBe(dbId)
      expect(extractedTimestamp).toBe(String(startTimestamp))
    })

    it('should handle very large message ROWID', () => {
      // SQLite max integer is 9223372036854775807
      const largeRowId = '9223372036854775807'

      const validated = validateLanceDBId(largeRowId)
      expect(validated).toBe(largeRowId)
    })

    it('should handle calendar event with negative startTimestamp', () => {
      // Events before 1970
      const dbId = '12345'
      const negativeTimestamp = -86400000 // 1 day before Unix epoch

      const calendarId = `${dbId}-${negativeTimestamp}`

      // Should be valid (hyphen is allowed)
      const validated = validateLanceDBId(calendarId)
      expect(validated).toBe(calendarId)
    })

    it('should reject ID with SQL injection characters', () => {
      const maliciousIds = [
        "'; DROP TABLE emails; --",
        "1' OR '1'='1",
        "id); DELETE FROM messages; --"
      ]

      for (const id of maliciousIds) {
        const validated = validateLanceDBId(id)
        // Should be rejected due to semicolon, quotes, etc.
        expect(validated).toBeNull()
      }
    })

    it('should escape single quotes in SQL', () => {
      const idWithQuote = "O'Brien"
      const escaped = escapeSQL(idWithQuote)

      expect(escaped).toBe("O''Brien")

      // Build delete condition
      const condition = `id = '${escaped}'`
      expect(condition).toBe("id = 'O''Brien'")
    })

    it('should handle empty ID', () => {
      const validated = validateLanceDBId('')
      expect(validated).toBeNull()
    })

    it('should handle ID at max length boundary', () => {
      const maxLength = 1000
      const atLimit = 'a'.repeat(maxLength)
      const overLimit = 'a'.repeat(maxLength + 1)

      expect(validateLanceDBId(atLimit)).toBe(atLimit)
      expect(validateLanceDBId(overLimit)).toBeNull()
    })

    it('should handle ID with email address format', () => {
      // Message IDs often contain email addresses
      const messageId = '<abc123.456@mail.gmail.com>'

      const validated = validateLanceDBId(messageId)
      expect(validated).toBe(messageId)
    })
  })

  describe('data size edge cases', () => {
    // Truncate text like in indexer.js
    const truncateText = (text, maxLength) => {
      if (!text || typeof text !== 'string') return ''
      return text.substring(0, maxLength)
    }

    it('should handle email body exactly at 500 char truncation boundary', () => {
      const exactlyAtLimit = 'a'.repeat(500)
      const truncated = truncateText(exactlyAtLimit, 500)

      expect(truncated).toHaveLength(500)
      expect(truncated).toBe(exactlyAtLimit)
    })

    it('should truncate email body at 501 chars', () => {
      const overLimit = 'a'.repeat(501)
      const truncated = truncateText(overLimit, 500)

      expect(truncated).toHaveLength(500)
    })

    it('should handle empty message text with valid attributedBody', () => {
      const processMessage = (msg) => {
        // If text is empty but attributedBody exists, we'd extract from attributedBody
        const text = msg.text || msg.extractedFromAttributedBody || ''
        return { id: msg.id, text, hasText: text.length > 0 }
      }

      const message = {
        id: 1,
        text: '', // Empty
        extractedFromAttributedBody: 'Hello from attributedBody!'
      }

      const result = processMessage(message)
      expect(result.hasText).toBe(true)
      expect(result.text).toBe('Hello from attributedBody!')
    })

    it('should handle calendar event with empty title', () => {
      const processEvent = (event) => {
        const title = event.title || '(No Title)'
        return { id: event.id, title, hasTitle: event.title && event.title.length > 0 }
      }

      const eventWithEmptyTitle = { id: 1, title: '' }
      const eventWithNullTitle = { id: 2, title: null }
      const eventWithUndefinedTitle = { id: 3 }

      expect(processEvent(eventWithEmptyTitle).title).toBe('(No Title)')
      expect(processEvent(eventWithNullTitle).title).toBe('(No Title)')
      expect(processEvent(eventWithUndefinedTitle).title).toBe('(No Title)')
    })

    it('should handle message with 0 attachments', () => {
      const msg = { id: 1, attachmentCount: 0 }
      expect(msg.attachmentCount).toBe(0)
      expect(msg.attachmentCount > 0).toBe(false)
    })

    it('should handle message with many attachments', () => {
      const msg = { id: 1, attachmentCount: 100 }
      expect(msg.attachmentCount).toBe(100)
      expect(msg.attachmentCount > 0).toBe(true)
    })

    it('should handle very long email subject', () => {
      const longSubject = 'Re: Fw: '.repeat(100) + 'Original Subject'
      const truncatedSubject = truncateText(longSubject, 200)

      expect(truncatedSubject.length).toBeLessThanOrEqual(200)
    })

    it('should handle null text gracefully', () => {
      expect(truncateText(null, 500)).toBe('')
      expect(truncateText(undefined, 500)).toBe('')
    })
  })

  describe('deduplication edge cases', () => {
    it('should handle duplicate IDs in same batch', () => {
      const items = [
        { id: '1', text: 'first' },
        { id: '1', text: 'duplicate' },
        { id: '2', text: 'second' }
      ]

      // Deduplicate by keeping first occurrence
      const seen = new Set()
      const unique = items.filter(item => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })

      expect(unique).toHaveLength(2)
      expect(unique[0].text).toBe('first')
    })

    it('should handle ID type coercion (number vs string)', () => {
      const indexedIds = new Set(['1', '2', '3'])

      // SQLite might return number, but we store as string
      const numericId = 1
      const stringId = '1'

      expect(indexedIds.has(numericId)).toBe(false) // Different type
      expect(indexedIds.has(String(numericId))).toBe(true)
      expect(indexedIds.has(stringId)).toBe(true)
    })

    it('should handle very large Set of indexed IDs', () => {
      // Test performance with 100k IDs (typical large mailbox)
      const largeSet = new Set()
      for (let i = 0; i < 100000; i++) {
        largeSet.add(`id-${i}`)
      }

      // Lookup should still be O(1)
      const start = performance.now()
      for (let i = 0; i < 1000; i++) {
        largeSet.has(`id-${Math.floor(Math.random() * 100000)}`)
      }
      const duration = performance.now() - start

      // 1000 lookups should be very fast (< 10ms)
      expect(duration).toBeLessThan(10)
    })
  })

  describe('concurrent indexing edge cases', () => {
    it('should handle rapid indexing requests', async () => {
      let indexingInProgress = false
      const completedIndexes = []

      const startIndexing = async (id) => {
        if (indexingInProgress) {
          return { skipped: true, reason: 'already_in_progress' }
        }

        indexingInProgress = true
        try {
          await new Promise(r => setTimeout(r, 10))
          completedIndexes.push(id)
          return { success: true, id }
        } finally {
          indexingInProgress = false
        }
      }

      // Fire multiple requests rapidly
      const results = await Promise.all([
        startIndexing(1),
        startIndexing(2),
        startIndexing(3)
      ])

      // Only one should succeed, others skipped
      const successful = results.filter(r => r.success)
      const skipped = results.filter(r => r.skipped)

      expect(successful.length).toBe(1)
      expect(skipped.length).toBe(2)
    })
  })
})
