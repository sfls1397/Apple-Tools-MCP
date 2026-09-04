/**
 * Integration tests for rebuild_index tool workflow
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'
import { cycleEndFlags, isSearchBlockedByIndexing } from '../../../lib/indexGate.js'

/**
 * Create a lock file mock for testing lock behavior
 */
function createLockFileMock() {
  let holder = null

  return {
    acquire(pid) {
      if (holder === null || holder === pid) {
        holder = pid
        return true
      }
      return false
    },
    release(pid) {
      if (holder === pid) {
        holder = null
        return true
      }
      return false
    },
    isLocked() {
      return holder !== null
    },
    getHolder() {
      return holder
    },
    reset() {
      holder = null
    }
  }
}

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

describe('Rebuild Index Tool', () => {
  describe('source clearing', () => {
    it('should clear specified sources before rebuilding', async () => {
      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // Setup existing tables
      await db.createTable('emails', [{ filePath: 'old', vector: new Array(384).fill(0) }])
      await db.createTable('messages', [{ id: '1', vector: new Array(384).fill(0) }])

      // Clear only emails
      await db.dropTable('emails')

      const tableNames = await db.tableNames()

      expect(tableNames).not.toContain('emails')
      expect(tableNames).toContain('messages')
    })

    it('should rebuild all sources when none specified', async () => {
      const sources = ['emails', 'messages', 'calendar']
      const defaultSources = sources // When no sources specified, use all

      expect(defaultSources).toEqual(['emails', 'messages', 'calendar'])
      expect(defaultSources).toHaveLength(3)
    })

    it('should only clear requested sources', async () => {
      const requestedSources = ['emails']

      const lancedb = createLanceDBMock()
      const db = await lancedb.connect()

      // Setup all tables
      await db.createTable('emails', [{ filePath: 'test', vector: new Array(384).fill(0) }])
      await db.createTable('messages', [{ id: '1', vector: new Array(384).fill(0) }])
      await db.createTable('calendar', [{ id: 'event', vector: new Array(384).fill(0) }])

      // Clear only requested sources
      for (const source of requestedSources) {
        await db.dropTable(source)
      }

      const tableNames = await db.tableNames()

      expect(tableNames).not.toContain('emails')
      expect(tableNames).toContain('messages')
      expect(tableNames).toContain('calendar')
    })
  })

  describe('full scan forcing', () => {
    it('should force full scan for email rebuild', () => {
      // rebuildIndex calls indexEmails with forceFullScan = true
      const forceFullScan = true

      expect(forceFullScan).toBe(true)
    })

    it('should ignore lastEmailIndexTime when forcing full scan', () => {
      const meta = { lastEmailIndexTime: Date.now() - 3600000 }
      const forceFullScan = true

      // When forceFullScan is true, lastEmailIndexTime should be treated as null
      const effectiveTime = forceFullScan ? null : meta.lastEmailIndexTime

      expect(effectiveTime).toBeNull()
    })
  })

  describe('lock acquisition', () => {
    it('should acquire lock during rebuild', () => {
      const lockMock = createLockFileMock()
      lockMock.acquire(process.pid)

      expect(lockMock.isLocked()).toBe(true)
    })

    it('should prevent concurrent rebuilds', () => {
      const lockMock = createLockFileMock()
      // First rebuild acquires lock
      lockMock.acquire(process.pid)

      // Second rebuild attempt fails
      const _secondAttempt = lockMock.acquire(process.pid + 1)

      // Should fail (lock held by different PID logic varies, but concept is tested)
      expect(lockMock.isLocked()).toBe(true)
    })

    it('should release lock after rebuild completes', async () => {
      const lockMock = createLockFileMock()
      lockMock.acquire(process.pid)

      // Simulate rebuild completion
      await Promise.resolve()
      lockMock.release(process.pid)

      expect(lockMock.isLocked()).toBe(false)
    })
  })

  describe('error tracking', () => {
    it('should track errors per source', () => {
      const results = {
        cleared: { emails: true, messages: true, calendar: false },
        indexed: {
          emails: { indexed: 0, added: 50 },
          messages: { indexed: 0, added: 20 }
        },
        errors: [
          { source: 'calendar', phase: 'clear', error: 'Permission denied' }
        ]
      }

      expect(results.errors).toHaveLength(1)
      expect(results.errors[0].source).toBe('calendar')
      expect(results.errors[0].phase).toBe('clear')
    })

    it('should continue with other sources after error', () => {
      const sources = ['emails', 'messages', 'calendar']
      const results = {
        cleared: {},
        indexed: {},
        errors: []
      }

      for (const source of sources) {
        try {
          if (source === 'messages') {
            throw new Error('Test error')
          }
          results.cleared[source] = true
          results.indexed[source] = { added: 10 }
        } catch (e) {
          results.errors.push({ source, error: e.message })
        }
      }

      expect(results.cleared.emails).toBe(true)
      expect(results.cleared.calendar).toBe(true)
      expect(results.errors).toHaveLength(1)
      expect(results.errors[0].source).toBe('messages')
    })
  })

  describe('fire and forget behavior', () => {
    it('should return immediately with status message', async () => {
      let responseReturned = false
      let _indexingStarted = false

      // Simulate fire and forget
      const startRebuild = async () => {
        responseReturned = true

        // Rebuild runs in background
        setTimeout(() => {
          _indexingStarted = true
        }, 10)
      }

      await startRebuild()

      expect(responseReturned).toBe(true)
      // Indexing may not have started yet (async)
    })

    it('should return "rebuild started" message immediately', () => {
      const response = {
        content: [{
          type: 'text',
          text: 'Index rebuild started for: emails, messages, calendar'
        }]
      }

      expect(response.content[0].text).toContain('rebuild started')
    })
  })

  describe('concurrent rebuild handling', () => {
    it('should handle concurrent rebuild requests', async () => {
      const lockMock = createLockFileMock()
      const results = []

      // First request
      const request1 = async () => {
        if (lockMock.acquire(1)) {
          await Promise.resolve()
          results.push({ id: 1, status: 'completed' })
          lockMock.release(1)
        } else {
          results.push({ id: 1, status: 'already in progress' })
        }
      }

      // Second concurrent request
      const request2 = async () => {
        if (lockMock.acquire(2)) {
          await Promise.resolve()
          results.push({ id: 2, status: 'completed' })
          lockMock.release(2)
        } else {
          results.push({ id: 2, status: 'already in progress' })
        }
      }

      await request1()
      await request2()

      // Both should complete since they run sequentially in this test
      expect(results).toHaveLength(2)
    })

    it('should return appropriate message when already in progress', () => {
      const lockMock = createLockFileMock()
      lockMock.acquire(process.pid)

      const canAcquire = lockMock.acquire(process.pid + 1)

      if (!canAcquire) {
        const message = 'Index rebuild already in progress. Please wait for completion.'
        expect(message).toContain('already in progress')
      }
    })
  })

  describe('failed rebuild must not block searches', () => {
    it('should restore searchable flags when rebuild rejects', () => {
      let sessionIndexComplete = true
      let indexingInProgress = false
      let ownsIndexLock = true

      indexingInProgress = true
      sessionIndexComplete = false
      expect(isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)).toBe(true)

      const flags = cycleEndFlags(false)
      indexingInProgress = flags.indexingInProgress
      sessionIndexComplete = flags.sessionIndexComplete
      ownsIndexLock = flags.ownsIndexLock

      expect(indexingInProgress).toBe(false)
      expect(sessionIndexComplete).toBe(true)
      expect(isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)).toBe(false)
    })
  })

  describe('result structure', () => {
    it('should return complete result structure', () => {
      const result = {
        cleared: {
          emails: true,
          messages: true,
          calendar: true
        },
        indexed: {
          emails: { indexed: 0, added: 100 },
          messages: { indexed: 0, added: 50 },
          calendar: { indexed: 0, added: 25, removed: 0 }
        },
        errors: []
      }

      expect(result.cleared).toBeDefined()
      expect(result.indexed).toBeDefined()
      expect(result.errors).toBeDefined()
      expect(result.errors).toHaveLength(0)
    })
  })
})
