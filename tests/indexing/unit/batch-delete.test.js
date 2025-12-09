/**
 * Unit tests for batch delete functionality
 * Tests OR condition generation, chunking, and SQL escaping
 */

import { describe, it, expect } from 'vitest'

const BATCH_DELETE_SIZE = 100

describe('Batch Delete', () => {
  // Validate ID for LanceDB (matches indexer.js logic)
  const validateLanceDBId = (id) => {
    if (typeof id !== 'string') return null
    if (id.length === 0 || id.length > 1000) return null

    // Only allow safe characters
    const safePattern = /^[a-zA-Z0-9._@<>:\-\/\s]+$/
    if (!safePattern.test(id)) return null

    return id
  }

  // Escape SQL string (matches indexer.js logic)
  const escapeSQL = (str) => {
    if (typeof str !== 'string') return ''
    return str.replace(/'/g, "''")
  }

  describe('OR condition generation', () => {
    const buildDeleteCondition = (ids) => {
      if (ids.length === 0) return null
      return ids.map(id => `id = '${id}'`).join(' OR ')
    }

    it('should generate single condition for one ID', () => {
      const condition = buildDeleteCondition(['item-1'])
      expect(condition).toBe("id = 'item-1'")
    })

    it('should generate OR conditions for multiple IDs', () => {
      const condition = buildDeleteCondition(['item-1', 'item-2', 'item-3'])
      expect(condition).toBe("id = 'item-1' OR id = 'item-2' OR id = 'item-3'")
    })

    it('should return null for empty array', () => {
      const condition = buildDeleteCondition([])
      expect(condition).toBeNull()
    })

    it('should handle IDs with hyphens (calendar format)', () => {
      const calendarIds = ['12345-1699123456000', '67890-1699123457000']
      const condition = buildDeleteCondition(calendarIds)

      expect(condition).toBe(
        "id = '12345-1699123456000' OR id = '67890-1699123457000'"
      )
    })

    it('should handle IDs with special characters', () => {
      const messageIds = ['<abc@mail.com>', 'msg:12345']
      const condition = buildDeleteCondition(messageIds)

      expect(condition).toBe("id = '<abc@mail.com>' OR id = 'msg:12345'")
    })
  })

  describe('chunking at BATCH_DELETE_SIZE (100)', () => {
    const chunkArray = (array, size) => {
      const chunks = []
      for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size))
      }
      return chunks
    }

    it('should create single chunk for 100 items', () => {
      const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`)
      const chunks = chunkArray(ids, BATCH_DELETE_SIZE)

      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toHaveLength(100)
    })

    it('should create two chunks for 101 items', () => {
      const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`)
      const chunks = chunkArray(ids, BATCH_DELETE_SIZE)

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toHaveLength(100)
      expect(chunks[1]).toHaveLength(1)
    })

    it('should create correct chunks for 250 items', () => {
      const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
      const chunks = chunkArray(ids, BATCH_DELETE_SIZE)

      expect(chunks).toHaveLength(3)
      expect(chunks[0]).toHaveLength(100)
      expect(chunks[1]).toHaveLength(100)
      expect(chunks[2]).toHaveLength(50)
    })

    it('should handle empty array', () => {
      const chunks = chunkArray([], BATCH_DELETE_SIZE)
      expect(chunks).toHaveLength(0)
    })

    it('should handle less than chunk size', () => {
      const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`)
      const chunks = chunkArray(ids, BATCH_DELETE_SIZE)

      expect(chunks).toHaveLength(1)
      expect(chunks[0]).toHaveLength(50)
    })
  })

  describe('SQL escaping in delete conditions', () => {
    const buildSafeDeleteCondition = (ids) => {
      const escapedIds = ids.map(id => escapeSQL(id))
      return escapedIds.map(id => `id = '${id}'`).join(' OR ')
    }

    it('should escape single quotes', () => {
      const ids = ["O'Brien", "McDonald's"]
      const condition = buildSafeDeleteCondition(ids)

      expect(condition).toBe("id = 'O''Brien' OR id = 'McDonald''s'")
    })

    it('should handle IDs without special characters', () => {
      const ids = ['simple-id', 'another-id']
      const condition = buildSafeDeleteCondition(ids)

      expect(condition).toBe("id = 'simple-id' OR id = 'another-id'")
    })

    it('should handle empty string ID', () => {
      const escaped = escapeSQL('')
      expect(escaped).toBe('')
    })

    it('should handle multiple single quotes', () => {
      const escaped = escapeSQL("It's John's car")
      expect(escaped).toBe("It''s John''s car")
    })
  })

  describe('empty stale IDs array', () => {
    const executeBatchDelete = async (table, staleIds) => {
      if (staleIds.length === 0) {
        return { deleted: 0, skipped: true }
      }

      // Would normally call table.delete()
      return { deleted: staleIds.length, skipped: false }
    }

    it('should skip delete when no stale IDs', async () => {
      const mockTable = { delete: async () => {} }
      const result = await executeBatchDelete(mockTable, [])

      expect(result.deleted).toBe(0)
      expect(result.skipped).toBe(true)
    })

    it('should proceed with delete when stale IDs exist', async () => {
      const mockTable = { delete: async () => {} }
      const result = await executeBatchDelete(mockTable, ['id-1', 'id-2'])

      expect(result.deleted).toBe(2)
      expect(result.skipped).toBe(false)
    })
  })

  describe('ID validation failures', () => {
    const filterValidIds = (ids) => {
      const valid = []
      const invalid = []

      for (const id of ids) {
        const validated = validateLanceDBId(id)
        if (validated) {
          valid.push(validated)
        } else {
          invalid.push(id)
        }
      }

      return { valid, invalid }
    }

    it('should filter out all invalid IDs', () => {
      const maliciousIds = [
        "'; DROP TABLE --",
        "id; DELETE FROM messages",
        "1' OR '1'='1"
      ]

      const { valid, invalid } = filterValidIds(maliciousIds)

      expect(valid).toHaveLength(0)
      expect(invalid).toHaveLength(3)
    })

    it('should keep valid IDs and filter invalid', () => {
      const mixedIds = [
        'valid-id-123',
        "invalid'; DROP --",
        'another-valid-456',
        '' // Empty string - invalid
      ]

      const { valid, invalid } = filterValidIds(mixedIds)

      expect(valid).toEqual(['valid-id-123', 'another-valid-456'])
      expect(invalid).toHaveLength(2)
    })

    it('should handle mixed valid/invalid IDs with correct logging', () => {
      const ids = [
        '12345-1699123456000', // Valid calendar ID
        'abc@mail.com', // Valid email format
        "'; DROP TABLE", // Invalid - contains semicolon
        '<valid-message-id>', // Valid
        null, // Invalid - not string
        undefined, // Invalid - not string
      ]

      const logs = []
      const validIds = []

      for (const id of ids) {
        const validated = validateLanceDBId(id)
        if (validated) {
          validIds.push(validated)
        } else {
          logs.push(`Skipping invalid ID: ${String(id).substring(0, 20)}`)
        }
      }

      expect(validIds).toHaveLength(3)
      expect(logs).toHaveLength(3)
    })
  })

  describe('full batch delete workflow', () => {
    // Simulate the complete batch delete as in indexer.js
    const executeBatchDeleteWorkflow = async (table, staleIds) => {
      const results = {
        totalStale: staleIds.length,
        validated: 0,
        skippedInvalid: 0,
        deletedBatches: 0,
        failedBatches: 0,
        totalDeleted: 0
      }

      if (staleIds.length === 0) {
        return results
      }

      // Validate all IDs first
      const validIds = []
      for (const staleId of staleIds) {
        const validatedId = validateLanceDBId(staleId)
        if (!validatedId) {
          results.skippedInvalid++
          continue
        }
        validIds.push(escapeSQL(validatedId))
      }
      results.validated = validIds.length

      // Batch delete in chunks of 100
      for (let i = 0; i < validIds.length; i += BATCH_DELETE_SIZE) {
        const batch = validIds.slice(i, i + BATCH_DELETE_SIZE)
        if (batch.length > 0) {
          try {
            const conditions = batch.map(id => `id = '${id}'`).join(' OR ')
            await table.delete(conditions)
            results.deletedBatches++
            results.totalDeleted += batch.length
          } catch (e) {
            results.failedBatches++
          }
        }
      }

      return results
    }

    it('should process complete workflow successfully', async () => {
      const deletedConditions = []
      const mockTable = {
        delete: async (condition) => {
          deletedConditions.push(condition)
        }
      }

      const staleIds = Array.from({ length: 150 }, (_, i) => `stale-${i}`)
      const results = await executeBatchDeleteWorkflow(mockTable, staleIds)

      expect(results.totalStale).toBe(150)
      expect(results.validated).toBe(150)
      expect(results.skippedInvalid).toBe(0)
      expect(results.deletedBatches).toBe(2)
      expect(results.totalDeleted).toBe(150)
      expect(deletedConditions).toHaveLength(2)
    })

    it('should handle mixed valid/invalid IDs', async () => {
      const mockTable = { delete: async () => {} }

      const staleIds = [
        'valid-1',
        "invalid'; DROP",
        'valid-2',
        '',
        'valid-3'
      ]

      const results = await executeBatchDeleteWorkflow(mockTable, staleIds)

      expect(results.validated).toBe(3)
      expect(results.skippedInvalid).toBe(2)
      expect(results.totalDeleted).toBe(3)
    })

    it('should handle delete failures gracefully', async () => {
      let callCount = 0
      const mockTable = {
        delete: async () => {
          callCount++
          if (callCount === 2) throw new Error('Delete failed')
        }
      }

      const staleIds = Array.from({ length: 250 }, (_, i) => `stale-${i}`)
      const results = await executeBatchDeleteWorkflow(mockTable, staleIds)

      expect(results.deletedBatches).toBe(2) // Batches 1 and 3 succeed
      expect(results.failedBatches).toBe(1) // Batch 2 fails
      expect(results.totalDeleted).toBe(150) // 100 + 50 from successful batches
    })
  })

  describe('OR condition query size limits', () => {
    it('should not exceed reasonable query size', () => {
      // Build OR condition for 100 items
      const ids = Array.from({ length: 100 }, (_, i) => `calendar-event-${i}-1699123456000`)
      const condition = ids.map(id => `id = '${id}'`).join(' OR ')

      // Each condition is roughly "id = 'calendar-event-XX-1699123456000' OR "
      // ~45 chars per condition, 100 conditions = ~4500 chars
      // This should be well under any reasonable SQL query limit
      expect(condition.length).toBeLessThan(10000)
    })

    it('should handle maximum length IDs at batch size', () => {
      // IDs at max allowed length (1000 chars)
      const maxLengthId = 'a'.repeat(1000)
      const ids = Array.from({ length: 100 }, () => maxLengthId)
      const condition = ids.map(id => `id = '${id}'`).join(' OR ')

      // 100 * (1000 + "id = ''" + " OR ") = ~100,700 chars
      // This is getting large but should still work
      expect(condition.length).toBeLessThan(110000)
    })
  })
})
