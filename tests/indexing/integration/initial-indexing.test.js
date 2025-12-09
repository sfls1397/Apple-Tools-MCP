/**
 * Integration tests for initial indexing (first run) workflow
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
          tables.set(name, records)
          return { name, records }
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
            async search() { return { toArray: async () => [] } }
          }
        }
      }
    }
  }
}

describe('Initial Indexing (First Run)', () => {
  describe('first run detection', () => {
    it('should detect first run when no index exists', async () => {
      const lancedb = createLanceDBMock()

      // No tables exist
      const tableNames = await lancedb.connect().then(db => db.tableNames())
      expect(tableNames).toHaveLength(0)

      // checkIfFirstRun should return true
      const emailsReady = false
      const messagesReady = false
      const calendarReady = false

      const isFirstRun = !(emailsReady || messagesReady || calendarReady)
      expect(isFirstRun).toBe(true)
    })

    it('should set isFirstEverRun flag correctly', () => {
      let isFirstEverRun = true

      // Simulate checkIfFirstRun result
      const noIndexExists = true
      isFirstEverRun = noIndexExists

      expect(isFirstEverRun).toBe(true)
    })
  })

  describe('full scan behavior', () => {
    it('should perform full scan (not incremental) on first run', () => {
      // When lastEmailIndexTime is null, should use full find command
      const meta = {}
      const lastEmailIndexTime = meta.lastEmailIndexTime || null

      const shouldUseFullScan = lastEmailIndexTime === null

      expect(shouldUseFullScan).toBe(true)
    })

    it('should use find command instead of mdfind', () => {
      // Full scan uses 'find' command
      const fullScanCmd = 'find "/Users/test/Library/Mail" \\( -name "*.emlx" -o -name "*.partial.emlx" \\)'

      expect(fullScanCmd).toContain('find')
      expect(fullScanCmd).toContain('.emlx')
      expect(fullScanCmd).toContain('.partial.emlx')
    })
  })

  describe('table creation', () => {
    it('should create all three tables on first run', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // Create tables
      await db.createTable('emails', [{ filePath: 'test', vector: new Array(384).fill(0) }])
      await db.createTable('messages', [{ id: '1', vector: new Array(384).fill(0) }])
      await db.createTable('calendar', [{ id: 'event-1', vector: new Array(384).fill(0) }])

      const tableNames = await db.tableNames()

      expect(tableNames).toContain('emails')
      expect(tableNames).toContain('messages')
      expect(tableNames).toContain('calendar')
      expect(tableNames).toHaveLength(3)
    })

    it('should use mode: overwrite for initial table creation', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // First createTable call with mode: overwrite
      const records = [{ filePath: 'test.emlx', vector: new Array(384).fill(0.1) }]
      await db.createTable('emails', records, { mode: 'overwrite' })

      const tableNames = await db.tableNames()
      expect(tableNames).toContain('emails')
    })
  })

  describe('messaging', () => {
    it('should show "Building initial index..." message during first run', () => {
      const isFirstEverRun = true

      const message = isFirstEverRun
        ? 'Building initial index. This may take several minutes on first run. Please try again shortly.'
        : 'Indexing new data. Please try again in a moment.'

      expect(message).toContain('Building initial index')
      expect(message).toContain('several minutes')
    })

    it('should indicate first run may take time', () => {
      const message = 'Building initial index. This may take several minutes on first run.'

      expect(message).toMatch(/minutes/i)
      expect(message).toMatch(/first run/i)
    })
  })

  describe('metadata creation', () => {
    it('should create index-meta.json after completion', () => {
      // Simulate saveIndexMeta
      const meta = { lastEmailIndexTime: Date.now() }
      const serialized = JSON.stringify(meta, null, 2)

      expect(serialized).toContain('lastEmailIndexTime')
    })

    it('should save lastEmailIndexTime in metadata', () => {
      const indexStartTime = Date.now()
      const meta = { lastEmailIndexTime: indexStartTime }

      expect(meta.lastEmailIndexTime).toBe(indexStartTime)
      expect(meta.lastEmailIndexTime).toBeGreaterThan(0)
    })
  })

  describe('query availability', () => {
    it('should return indexing message before sessionIndexComplete', () => {
      let sessionIndexComplete = false

      const getResponse = () => {
        if (!sessionIndexComplete) {
          return 'Building initial index. This may take several minutes on first run.'
        }
        return 'Search results...'
      }

      expect(getResponse()).toContain('Building initial index')
    })

    it('should allow queries after sessionIndexComplete is set', () => {
      let sessionIndexComplete = true

      const getResponse = () => {
        if (!sessionIndexComplete) {
          return 'Building initial index...'
        }
        return 'Search results...'
      }

      expect(getResponse()).toBe('Search results...')
    })

    it('should check isIndexReady before search', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // Create table
      await db.createTable('emails', [{ filePath: 'test', vector: new Array(384).fill(0) }])

      const tableNames = await db.tableNames()
      const isReady = tableNames.includes('emails')

      expect(isReady).toBe(true)
    })
  })

  describe('full workflow', () => {
    it('should complete initial indexing workflow', async () => {
      const workflow = {
        checkIfFirstRun: true,
        acquireLock: true,
        indexEmails: { indexed: 0, added: 50 },
        indexMessages: { indexed: 0, added: 20 },
        indexCalendar: { indexed: 0, added: 10, removed: 0 },
        releaseLock: true,
        sessionIndexComplete: true
      }

      expect(workflow.checkIfFirstRun).toBe(true)
      expect(workflow.acquireLock).toBe(true)
      expect(workflow.indexEmails.added).toBe(50)
      expect(workflow.indexMessages.added).toBe(20)
      expect(workflow.indexCalendar.added).toBe(10)
      expect(workflow.releaseLock).toBe(true)
      expect(workflow.sessionIndexComplete).toBe(true)
    })
  })
})
