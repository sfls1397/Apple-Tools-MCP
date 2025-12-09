/**
 * Accuracy tests for deduplication logic
 * Tests prevention of duplicate entries in indexes
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'

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
          return { name, records: tables.get(name) }
        },
        async dropTable(name) {
          tables.delete(name)
        },
        async tableNames() {
          return Array.from(tables.keys())
        },
        async openTable(name) {
          if (!tables.has(name)) return null
          const tableRecords = tables.get(name)
          return {
            query() {
              return {
                async toArray() {
                  return tableRecords
                }
              }
            },
            async search() { return { toArray: async () => [] } }
          }
        }
      }
    }
  }
}

/**
 * Generate test calendar events
 */
function generateCalendarEvents(count) {
  const events = []
  const now = Date.now()

  for (let i = 0; i < count; i++) {
    const startTime = now + (i * 24 * 60 * 60 * 1000)
    events.push({
      title: `Event ${i + 1}`,
      start: new Date(startTime).toLocaleString()
    })
  }

  return events
}

describe('Email Deduplication', () => {
  describe('filePath uniqueness', () => {
    it('should not re-index already indexed emails', async () => {
      const indexed = new Set([
        '/path/1.emlx',
        '/path/2.emlx',
        '/path/3.emlx'
      ])

      const allFiles = [
        '/path/1.emlx',
        '/path/2.emlx',
        '/path/3.emlx',
        '/path/4.emlx',
        '/path/5.emlx'
      ]

      const toIndex = allFiles.filter(f => !indexed.has(f))

      expect(toIndex).toEqual(['/path/4.emlx', '/path/5.emlx'])
      expect(toIndex.length).toBe(2)
    })

    it('should detect duplicates by filePath', async () => {
      const records = [
        { filePath: '/path/1.emlx', subject: 'Email 1' },
        { filePath: '/path/2.emlx', subject: 'Email 2' },
        { filePath: '/path/1.emlx', subject: 'Duplicate' } // Duplicate
      ]

      const uniquePaths = new Set(records.map(r => r.filePath))

      expect(uniquePaths.size).toBe(2)
      expect(records.length).toBe(3)
      // There IS a duplicate
      expect(uniquePaths.size).toBeLessThan(records.length)
    })

    it('should maintain unique filePaths after indexing', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      const records = [
        { filePath: '/path/1.emlx', vector: new Array(384).fill(0) },
        { filePath: '/path/2.emlx', vector: new Array(384).fill(0) },
        { filePath: '/path/3.emlx', vector: new Array(384).fill(0) }
      ]

      await db.createTable('emails', records)

      const table = await db.openTable('emails')
      const results = await table.query().toArray()

      const paths = results.map(r => r.filePath)
      const uniquePaths = new Set(paths)

      expect(uniquePaths.size).toBe(paths.length)
    })

    it('should skip file if path already in index', () => {
      const indexed = new Set(['/mail/existing.emlx'])
      const newFile = '/mail/existing.emlx'

      const shouldIndex = !indexed.has(newFile)

      expect(shouldIndex).toBe(false)
    })
  })

  describe('incremental indexing', () => {
    it('should only index new files', () => {
      const existingCount = 100
      const newFilesCount = 25

      const allFiles = Array.from({ length: existingCount + newFilesCount }, (_, i) =>
        `/path/${i + 1}.emlx`
      )

      const indexed = new Set(allFiles.slice(0, existingCount))

      const toIndex = allFiles.filter(f => !indexed.has(f))

      expect(toIndex.length).toBe(newFilesCount)
    })
  })
})

describe('Message Deduplication', () => {
  describe('id uniqueness', () => {
    it('should detect message duplicates by id', () => {
      const messages = [
        { id: '1', text: 'Hello' },
        { id: '2', text: 'Hi' },
        { id: '1', text: 'Duplicate Hello' } // Duplicate
      ]

      const uniqueIds = new Set(messages.map(m => m.id))

      expect(uniqueIds.size).toBe(2)
      expect(uniqueIds.has('1')).toBe(true)
      expect(uniqueIds.has('2')).toBe(true)
    })

    it('should skip messages with already indexed id', () => {
      const indexed = new Set(['1', '2', '3'])

      const messages = [
        { id: '1' },
        { id: '4' }, // New
        { id: '2' },
        { id: '5' }  // New
      ]

      const toIndex = messages.filter(m => !indexed.has(String(m.id)))

      expect(toIndex.length).toBe(2)
      expect(toIndex.map(m => m.id)).toEqual(['4', '5'])
    })

    it('should convert id to string for comparison', () => {
      const indexed = new Set(['1', '2', '3'])

      // SQLite may return numeric id
      const message = { id: 2 }

      const isIndexed = indexed.has(String(message.id))

      expect(isIndexed).toBe(true)
    })
  })

  describe('unique ids in table', () => {
    it('should maintain unique ids in messages table', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      const records = [
        { id: '1', text: 'Msg 1', vector: new Array(384).fill(0) },
        { id: '2', text: 'Msg 2', vector: new Array(384).fill(0) },
        { id: '3', text: 'Msg 3', vector: new Array(384).fill(0) }
      ]

      await db.createTable('messages', records)

      const table = await db.openTable('messages')
      const results = await table.query().toArray()

      const ids = results.map(r => r.id)
      const uniqueIds = new Set(ids)

      expect(uniqueIds.size).toBe(ids.length)
    })
  })
})

describe('Calendar Deduplication', () => {
  describe('ID collision handling', () => {
    it('should create unique IDs from title-start combination', () => {
      const events = [
        { title: 'Meeting', start: '2024-01-01 10:00' },
        { title: 'Meeting', start: '2024-01-02 10:00' }, // Different time
        { title: 'Call', start: '2024-01-01 10:00' }     // Different title
      ]

      const ids = events.map(e => `${e.title}-${e.start}`)

      expect(ids[0]).toBe('Meeting-2024-01-01 10:00')
      expect(ids[1]).toBe('Meeting-2024-01-02 10:00')
      expect(ids[2]).toBe('Call-2024-01-01 10:00')

      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(3)
    })

    it('should handle same-title same-time collision', () => {
      // Two events with identical title and start time
      const events = [
        { title: 'Meeting', start: '2024-01-01 10:00', calendar: 'Work' },
        { title: 'Meeting', start: '2024-01-01 10:00', calendar: 'Personal' } // Same ID!
      ]

      const ids = events.map(e => `${e.title}-${e.start}`)

      // These would collide
      expect(ids[0]).toBe(ids[1])

      // In practice, the second would overwrite or be skipped
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(1)
    })

    it('should skip already indexed events by ID', () => {
      const indexed = new Set([
        'Meeting A-2024-01-01 10:00',
        'Meeting B-2024-01-02 10:00'
      ])

      const events = [
        { title: 'Meeting A', start: '2024-01-01 10:00' }, // Already indexed
        { title: 'Meeting C', start: '2024-01-03 10:00' }  // New
      ]

      const toIndex = events.filter(e => {
        const eventId = `${e.title}-${e.start}`
        return !indexed.has(eventId)
      })

      expect(toIndex.length).toBe(1)
      expect(toIndex[0].title).toBe('Meeting C')
    })
  })

  describe('stale entry tracking', () => {
    it('should build set of current event IDs', () => {
      const events = generateCalendarEvents(5)

      const currentIds = new Set(events.map(e => `${e.title}-${e.start}`))

      expect(currentIds.size).toBe(5)
    })

    it('should identify indexed IDs not in current', () => {
      const indexedIds = new Set([
        'Event A-2024-01-01',
        'Event B-2024-01-02',
        'Event C-2024-01-03',
        'Event D-2024-01-04' // Removed from calendar
      ])

      const currentIds = new Set([
        'Event A-2024-01-01',
        'Event B-2024-01-02',
        'Event C-2024-01-03'
      ])

      const staleIds = [...indexedIds].filter(id => !currentIds.has(id))

      expect(staleIds).toEqual(['Event D-2024-01-04'])
    })
  })
})

describe('Cross-Source Deduplication', () => {
  it('should allow same content in different sources', () => {
    // It's valid to have "Meeting" in both email and calendar
    const emailRecord = { filePath: '/mail/1.emlx', subject: 'Meeting' }
    const calendarRecord = { id: 'Meeting-2024-01-01', title: 'Meeting' }

    // These are in different tables, so not duplicates
    expect(emailRecord.subject).toBe(calendarRecord.title)
    expect(emailRecord.filePath).not.toBe(calendarRecord.id)
  })
})
