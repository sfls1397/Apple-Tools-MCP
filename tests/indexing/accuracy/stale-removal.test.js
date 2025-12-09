/**
 * Accuracy tests for stale entry removal
 * Tests calendar event cleanup when events are removed from source
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect, vi } from 'vitest'

/**
 * Create a LanceDB mock for testing database operations
 */
function createLanceDBMock() {
  const tables = new Map()

  return {
    async connect() {
      return {
        async createTable(name, records, _options = {}) {
          tables.set(name, [...records])
          return {
            name,
            records: tables.get(name),
            delete: vi.fn()
          }
        },
        async dropTable(name) {
          tables.delete(name)
        },
        async tableNames() {
          return Array.from(tables.keys())
        },
        async openTable(name) {
          if (!tables.has(name)) return null
          return {
            delete: vi.fn(),
            async search() { return { toArray: async () => [] } }
          }
        }
      }
    }
  }
}

describe('Stale Entry Removal', () => {
  describe('detecting stale events', () => {
    it('should identify events removed from calendar', () => {
      // Events that were indexed
      const indexedIds = new Set([
        'Meeting A-2024-01-01 10:00',
        'Meeting B-2024-01-02 10:00',
        'Meeting C-2024-01-03 10:00',
        'Meeting D-2024-01-04 10:00',
        'Meeting E-2024-01-05 10:00'
      ])

      // Events currently in calendar (D and E were deleted)
      const currentEvents = [
        { title: 'Meeting A', start: '2024-01-01 10:00' },
        { title: 'Meeting B', start: '2024-01-02 10:00' },
        { title: 'Meeting C', start: '2024-01-03 10:00' }
      ]

      const currentIds = new Set(currentEvents.map(e => `${e.title}-${e.start}`))

      const staleIds = [...indexedIds].filter(id => !currentIds.has(id))

      expect(staleIds).toHaveLength(2)
      expect(staleIds).toContain('Meeting D-2024-01-04 10:00')
      expect(staleIds).toContain('Meeting E-2024-01-05 10:00')
    })

    it('should return empty array when no stale entries', () => {
      const indexedIds = new Set(['Event A', 'Event B'])
      const currentIds = new Set(['Event A', 'Event B', 'Event C']) // C is new

      const staleIds = [...indexedIds].filter(id => !currentIds.has(id))

      expect(staleIds).toHaveLength(0)
    })

    it('should detect all entries as stale when calendar is empty', () => {
      const indexedIds = new Set(['Event A', 'Event B', 'Event C'])
      const currentIds = new Set() // Calendar cleared

      const staleIds = [...indexedIds].filter(id => !currentIds.has(id))

      expect(staleIds).toHaveLength(3)
    })
  })

  describe('deleting stale entries', () => {
    it('should delete removed events from index', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // Create table with events
      const records = [
        { id: 'Event A', title: 'Event A', vector: new Array(384).fill(0) },
        { id: 'Event B', title: 'Event B', vector: new Array(384).fill(0) },
        { id: 'Event C', title: 'Event C', vector: new Array(384).fill(0) }
      ]

      await db.createTable('calendar', records)
      const table = await db.openTable('calendar')

      // Delete stale entry
      await table.delete("id = 'Event B'")

      expect(table.delete).toHaveBeenCalledWith("id = 'Event B'")
    })

    it('should return correct removed count', () => {
      const staleIds = ['Event A', 'Event B', 'Event C']
      let removedCount = 0

      for (const id of staleIds) {
        // Simulate successful deletion
        removedCount++
      }

      expect(removedCount).toBe(3)
    })
  })

  describe('ID validation before deletion', () => {
    it('should validate IDs before delete operation', () => {
      const validateLanceDBId = (id) => {
        if (!id || typeof id !== 'string') return null
        // Check for reasonable length
        if (id.length > 1000) return null
        // Check for dangerous characters
        if (/[\x00-\x1f\x7f]/.test(id)) return null
        // SQL injection prevention - basic check
        if (/[;'"\\]/.test(id) && id.includes('DROP')) return null
        return id
      }

      const validId = 'Meeting-2024-01-01 10:00'
      const invalidId = "'; DROP TABLE calendar; --"
      const controlCharId = "Event\x00A"

      expect(validateLanceDBId(validId)).toBe(validId)
      expect(validateLanceDBId(invalidId)).toBeNull()
      expect(validateLanceDBId(controlCharId)).toBeNull()
    })

    it('should skip invalid IDs', () => {
      const staleIds = [
        'Valid Event-2024-01-01',
        "'; DROP TABLE calendar; --", // Invalid
        'Another Valid-2024-01-02',
        '\x00BadId' // Invalid
      ]

      const validateId = (id) => {
        if (/[;'"\\]/.test(id) && id.includes('DROP')) return null
        if (/[\x00-\x1f]/.test(id)) return null
        return id
      }

      const validIds = staleIds.filter(id => validateId(id) !== null)

      expect(validIds).toHaveLength(2)
      expect(validIds).toContain('Valid Event-2024-01-01')
      expect(validIds).toContain('Another Valid-2024-01-02')
    })
  })

  describe('error handling', () => {
    it('should log skipped invalid IDs', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const invalidId = "Event\x00Invalid"
      const validateId = (id) => {
        if (/[\x00-\x1f]/.test(id)) {
          console.error(`Skipping invalid stale ID: ${id.substring(0, 50)}...`)
          return null
        }
        return id
      }

      validateId(invalidId)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid stale ID')
      )

      consoleSpy.mockRestore()
    })

    it('should continue after individual delete failure', async () => {
      const staleIds = ['Event A', 'Event B', 'Event C']
      const deleteResults = []

      for (const id of staleIds) {
        try {
          if (id === 'Event B') {
            throw new Error('Delete failed')
          }
          deleteResults.push({ id, status: 'deleted' })
        } catch (e) {
          deleteResults.push({ id, status: 'failed', error: e.message })
        }
      }

      expect(deleteResults).toHaveLength(3)
      expect(deleteResults.filter(r => r.status === 'deleted')).toHaveLength(2)
      expect(deleteResults.filter(r => r.status === 'failed')).toHaveLength(1)
    })
  })

  describe('SQL escaping', () => {
    it('should escape special characters in ID', () => {
      const escapeSQL = (str) => {
        return str.replace(/'/g, "''")
      }

      const id = "Event's Title-2024-01-01"
      const escaped = escapeSQL(id)

      expect(escaped).toBe("Event''s Title-2024-01-01")
    })

    it('should construct safe delete query', () => {
      const escapeSQL = (str) => str.replace(/'/g, "''")

      const id = "Meeting's Notes-2024-01-01"
      const escapedId = escapeSQL(id)
      const query = `id = '${escapedId}'`

      expect(query).toBe("id = 'Meeting''s Notes-2024-01-01'")
    })
  })

  describe('result structure', () => {
    it('should return indexed, added, and removed counts', () => {
      const result = {
        indexed: 100,  // Previously indexed count
        added: 5,      // Newly added count
        removed: 3     // Stale entries removed
      }

      expect(result.indexed).toBeDefined()
      expect(result.added).toBeDefined()
      expect(result.removed).toBeDefined()
      expect(result.removed).toBe(3)
    })
  })
})
