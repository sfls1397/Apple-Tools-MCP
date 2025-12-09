/**
 * Negative tests for LanceDB failure handling
 * Tests graceful handling of table creation, write, and delete failures
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('LanceDB Failure Handling', () => {
  describe('table creation failures', () => {
    const createMockDb = (options = {}) => {
      const {
        createTableFails = false,
        tableExistsFails = false,
        errorMessage = 'Table creation failed'
      } = options

      const tables = new Map()

      return {
        tableNames: async () => {
          if (tableExistsFails) throw new Error('Failed to list tables')
          return [...tables.keys()]
        },
        createTable: async (name, data) => {
          if (createTableFails) throw new Error(errorMessage)
          tables.set(name, { data: [...data] })
          return tables.get(name)
        },
        openTable: async (name) => {
          if (!tables.has(name)) throw new Error(`Table ${name} not found`)
          return tables.get(name)
        }
      }
    }

    it('should handle table creation failure', async () => {
      const db = createMockDb({ createTableFails: true, errorMessage: 'Disk full' })

      const initTable = async () => {
        try {
          await db.createTable('emails', [])
          return { success: true }
        } catch (e) {
          return { success: false, error: e.message }
        }
      }

      const result = await initTable()
      expect(result.success).toBe(false)
      expect(result.error).toBe('Disk full')
    })

    it('should handle table listing failure', async () => {
      const db = createMockDb({ tableExistsFails: true })

      const checkTableExists = async (name) => {
        try {
          const tables = await db.tableNames()
          return { exists: tables.includes(name), error: null }
        } catch (e) {
          return { exists: false, error: e.message }
        }
      }

      const result = await checkTableExists('emails')
      expect(result.error).toBe('Failed to list tables')
    })

    it('should retry table creation on transient failure', async () => {
      let attempts = 0

      const flakyDb = {
        createTable: async (name, data) => {
          attempts++
          if (attempts < 3) throw new Error('Transient error')
          return { name, data }
        }
      }

      const createWithRetry = async (name, data, maxRetries = 3) => {
        for (let i = 0; i < maxRetries; i++) {
          try {
            return await flakyDb.createTable(name, data)
          } catch (e) {
            if (i === maxRetries - 1) throw e
            await new Promise(r => setTimeout(r, 10))
          }
        }
      }

      const result = await createWithRetry('emails', [])
      expect(result.name).toBe('emails')
      expect(attempts).toBe(3)
    })
  })

  describe('write failures', () => {
    const createMockTable = (options = {}) => {
      const {
        addFails = false,
        addFailsAfter = Infinity,
        errorMessage = 'Write failed'
      } = options

      let addCount = 0
      const data = []

      return {
        add: async (items) => {
          addCount++
          if (addFails && addCount > addFailsAfter) {
            throw new Error(errorMessage)
          }
          data.push(...items)
          return { added: items.length }
        },
        getData: () => data,
        getAddCount: () => addCount
      }
    }

    it('should handle write failure mid-batch', async () => {
      const table = createMockTable({
        addFails: true,
        addFailsAfter: 1,
        errorMessage: 'Connection lost'
      })

      const batches = [
        [{ id: 1 }, { id: 2 }],
        [{ id: 3 }, { id: 4 }],
        [{ id: 5 }, { id: 6 }]
      ]

      const writtenBatches = []
      const failedBatches = []

      for (const batch of batches) {
        try {
          await table.add(batch)
          writtenBatches.push(batch)
        } catch (e) {
          failedBatches.push({ batch, error: e.message })
        }
      }

      expect(writtenBatches).toHaveLength(1) // Only first batch succeeded
      expect(failedBatches).toHaveLength(2) // Batches 2 and 3 failed
    })

    it('should track partial batch success', async () => {
      // Simulate a table that fails on specific items
      const createPartialFailTable = () => {
        const data = []

        return {
          add: async (items) => {
            const successful = []
            const failed = []

            for (const item of items) {
              if (item.id % 3 === 0) {
                failed.push({ item, error: 'ID divisible by 3' })
              } else {
                data.push(item)
                successful.push(item)
              }
            }

            return { added: successful.length, failed }
          },
          getData: () => data
        }
      }

      const table = createPartialFailTable()
      const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }]

      const result = await table.add(items)

      expect(result.added).toBe(4) // 1, 2, 4, 5
      expect(result.failed).toHaveLength(2) // 3, 6
    })

    it('should handle vector validation failure', async () => {
      const validateAndAdd = async (table, items) => {
        const EXPECTED_DIM = 384

        const valid = []
        const invalid = []

        for (const item of items) {
          if (!item.vector || item.vector.length !== EXPECTED_DIM) {
            invalid.push({ item, reason: 'invalid_vector' })
          } else if (item.vector.some(v => !Number.isFinite(v))) {
            invalid.push({ item, reason: 'non_finite_values' })
          } else {
            valid.push(item)
          }
        }

        if (valid.length > 0) {
          await table.add(valid)
        }

        return { added: valid.length, invalid }
      }

      const mockTable = { add: async (items) => ({ added: items.length }) }

      const items = [
        { id: 1, vector: new Array(384).fill(0.1) },
        { id: 2, vector: new Array(100).fill(0.1) }, // Wrong dimension
        { id: 3, vector: new Array(384).fill(NaN) }, // Invalid values
        { id: 4, vector: new Array(384).fill(0.2) }
      ]

      const result = await validateAndAdd(mockTable, items)

      expect(result.added).toBe(2) // Items 1 and 4
      expect(result.invalid).toHaveLength(2)
    })
  })

  describe('delete failures', () => {
    const createMockTableWithDelete = (options = {}) => {
      const {
        deleteFails = false,
        deleteFailsOn = [],
        errorMessage = 'Delete failed'
      } = options

      const data = new Map()

      return {
        add: async (items) => {
          items.forEach(item => data.set(item.id, item))
        },
        delete: async (filter) => {
          if (deleteFails) throw new Error(errorMessage)

          // Parse simple filter like "id = 'value'" or "id = 'v1' OR id = 'v2'"
          const matches = filter.match(/id\s*=\s*'([^']+)'/g) || []
          const ids = matches.map(m => m.match(/'([^']+)'/)[1])

          let deleted = 0
          for (const id of ids) {
            if (deleteFailsOn.includes(id)) {
              throw new Error(`Cannot delete ${id}`)
            }
            if (data.delete(id)) deleted++
          }

          return { deleted }
        },
        getData: () => [...data.values()]
      }
    }

    it('should handle delete failure', async () => {
      const table = createMockTableWithDelete({
        deleteFails: true,
        errorMessage: 'Table locked'
      })

      await table.add([{ id: 'item1' }, { id: 'item2' }])

      const deleteWithFallback = async () => {
        try {
          await table.delete("id = 'item1'")
          return { success: true }
        } catch (e) {
          return { success: false, error: e.message }
        }
      }

      const result = await deleteWithFallback()
      expect(result.success).toBe(false)
      expect(result.error).toBe('Table locked')
    })

    it('should handle batch delete with partial failure', async () => {
      const table = createMockTableWithDelete({
        deleteFailsOn: ['item2']
      })

      await table.add([
        { id: 'item1' },
        { id: 'item2' },
        { id: 'item3' }
      ])

      const batchDelete = async (ids) => {
        const results = { deleted: [], failed: [] }

        for (const id of ids) {
          try {
            await table.delete(`id = '${id}'`)
            results.deleted.push(id)
          } catch (e) {
            results.failed.push({ id, error: e.message })
          }
        }

        return results
      }

      const result = await batchDelete(['item1', 'item2', 'item3'])

      expect(result.deleted).toContain('item1')
      expect(result.deleted).toContain('item3')
      expect(result.failed).toHaveLength(1)
      expect(result.failed[0].id).toBe('item2')
    })

    it('should continue after delete error in batch OR condition', async () => {
      // Test the actual batch delete pattern used in indexer.js
      const executeBatchDelete = async (table, ids, batchSize = 100) => {
        const results = { success: 0, failed: 0 }

        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize)
          const conditions = batch.map(id => `id = '${id}'`).join(' OR ')

          try {
            await table.delete(conditions)
            results.success += batch.length
          } catch (e) {
            // Log error but continue with next batch
            results.failed += batch.length
            console.error(`Batch delete failed: ${e.message}`)
          }
        }

        return results
      }

      let deleteAttempts = 0
      const flakyTable = {
        delete: async (filter) => {
          deleteAttempts++
          if (deleteAttempts === 2) throw new Error('Transient failure')
          return { deleted: 1 }
        }
      }

      const ids = Array.from({ length: 250 }, (_, i) => `id${i}`)
      const result = await executeBatchDelete(flakyTable, ids, 100)

      // 3 batches: batch 1 succeeds (100), batch 2 fails (100), batch 3 succeeds (50)
      expect(result.success).toBe(150)
      expect(result.failed).toBe(100)
    })
  })

  describe('connection recovery', () => {
    it('should reconnect after connection drop', async () => {
      let connectionCount = 0
      let isConnected = false

      const createConnection = async () => {
        connectionCount++
        isConnected = true
        return {
          query: async () => {
            if (!isConnected) throw new Error('Not connected')
            return []
          },
          disconnect: () => { isConnected = false }
        }
      }

      const withReconnect = async (operation, maxRetries = 3) => {
        let connection = await createConnection()

        for (let i = 0; i < maxRetries; i++) {
          try {
            return await operation(connection)
          } catch (e) {
            if (e.message === 'Not connected' && i < maxRetries - 1) {
              connection = await createConnection()
            } else {
              throw e
            }
          }
        }
      }

      // Simulate connection drop
      const result = await withReconnect(async (conn) => {
        if (connectionCount === 1) {
          conn.disconnect()
          return conn.query() // Will fail
        }
        return conn.query() // Will succeed on reconnect
      })

      expect(connectionCount).toBe(2)
      expect(result).toEqual([])
    })

    it('should handle database file moved/deleted', async () => {
      let dbExists = true

      const openDb = async (path) => {
        if (!dbExists) {
          throw new Error(`ENOENT: no such file or directory '${path}'`)
        }
        return { path, tables: [] }
      }

      const safeOpen = async (path) => {
        try {
          return { db: await openDb(path), error: null }
        } catch (e) {
          if (e.message.includes('ENOENT')) {
            return { db: null, error: 'database_not_found' }
          }
          return { db: null, error: e.message }
        }
      }

      // First open succeeds
      let result = await safeOpen('/path/to/db')
      expect(result.db).not.toBeNull()

      // Simulate deletion
      dbExists = false

      // Second open fails gracefully
      result = await safeOpen('/path/to/db')
      expect(result.db).toBeNull()
      expect(result.error).toBe('database_not_found')
    })
  })

  describe('index corruption recovery', () => {
    it('should detect and rebuild corrupted index', async () => {
      const checkIndexHealth = async (table) => {
        const tests = {
          canQuery: false,
          hasValidSchema: false,
          rowCountMatches: false
        }

        try {
          // Test 1: Can execute simple query
          await table.search('test').execute()
          tests.canQuery = true

          // Test 2: Has expected columns
          const schema = await table.schema()
          tests.hasValidSchema = schema.fields.some(f => f.name === 'vector')

          // Test 3: Row count is reasonable
          const count = await table.countRows()
          tests.rowCountMatches = count >= 0

          return { healthy: Object.values(tests).every(t => t), tests }
        } catch (e) {
          return { healthy: false, error: e.message, tests }
        }
      }

      // Simulate healthy table
      const healthyTable = {
        search: () => ({ execute: async () => [] }),
        schema: async () => ({ fields: [{ name: 'vector' }, { name: 'id' }] }),
        countRows: async () => 1000
      }

      const healthResult = await checkIndexHealth(healthyTable)
      expect(healthResult.healthy).toBe(true)

      // Simulate corrupted table
      const corruptTable = {
        search: () => ({ execute: async () => { throw new Error('Index corrupted') } }),
        schema: async () => ({ fields: [] }),
        countRows: async () => -1
      }

      const corruptResult = await checkIndexHealth(corruptTable)
      expect(corruptResult.healthy).toBe(false)
    })
  })
})
