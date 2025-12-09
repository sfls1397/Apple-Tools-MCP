/**
 * Concurrency Testing
 *
 * Tests parallel execution scenarios:
 * - Concurrent database queries
 * - Race conditions
 * - Resource contention
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { connect } from '@lancedb/lancedb'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.env.HOME, '.apple-tools-mcp', 'lance_index')
const indexExists = fs.existsSync(DB_PATH)

let db = null

describe.skipIf(!indexExists)('Concurrency: Parallel Queries', () => {
  beforeAll(async () => {
    if (indexExists) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 10 parallel queries to same table', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return
    }

    const tbl = await db.openTable('emails')
    const start = performance.now()

    const promises = Array(10).fill(null).map(() =>
      tbl.query().limit(50).toArray()
    )

    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  → 10 parallel queries in ${duration.toFixed(0)}ms`)

    // All should succeed
    expect(results.every(r => Array.isArray(r))).toBe(true)
    expect(results.every(r => r.length <= 50)).toBe(true)
  })

  it('should handle parallel queries to different tables', async () => {
    const tables = await db.tableNames()
    const availableTables = ['emails', 'messages', 'calendar'].filter(t => tables.includes(t))

    if (availableTables.length < 2) {
      console.log('  → Skipped: need at least 2 tables')
      return
    }

    const start = performance.now()

    const promises = availableTables.map(async (tableName) => {
      const tbl = await db.openTable(tableName)
      return tbl.query().limit(50).toArray()
    })

    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  → ${availableTables.length} parallel table queries in ${duration.toFixed(0)}ms`)

    expect(results.every(r => Array.isArray(r))).toBe(true)
  })

  it('should handle interleaved reads', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      return
    }

    const tbl = await db.openTable('messages')
    const results = []

    // Start multiple queries without waiting
    const p1 = tbl.query().limit(10).toArray()
    const p2 = tbl.query().limit(20).toArray()
    const p3 = tbl.query().limit(30).toArray()

    // Wait in different order than started
    results.push(await p3)
    results.push(await p1)
    results.push(await p2)

    expect(results[0].length).toBeLessThanOrEqual(30)
    expect(results[1].length).toBeLessThanOrEqual(10)
    expect(results[2].length).toBeLessThanOrEqual(20)
  })

  it('should handle high concurrency (50 parallel)', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return
    }

    const tbl = await db.openTable('emails')
    const start = performance.now()

    const promises = Array(50).fill(null).map(() =>
      tbl.query().limit(10).toArray()
    )

    const results = await Promise.allSettled(promises)
    const duration = performance.now() - start

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed = results.filter(r => r.status === 'rejected').length

    console.log(`  → 50 parallel: ${succeeded} succeeded, ${failed} failed in ${duration.toFixed(0)}ms`)

    // All should succeed (LanceDB handles concurrency)
    expect(succeeded).toBe(50)
  })
})

describe.skipIf(!indexExists)('Concurrency: Multiple Connections', () => {
  it('should handle multiple db connections', async () => {
    // Open multiple connections
    const connections = await Promise.all([
      connect(DB_PATH),
      connect(DB_PATH),
      connect(DB_PATH)
    ])

    const results = await Promise.all(connections.map(async (conn) => {
      const tables = await conn.tableNames()
      return tables.length
    }))

    // All should see the same tables
    expect(results[0]).toBe(results[1])
    expect(results[1]).toBe(results[2])

    console.log(`  → 3 connections, each sees ${results[0]} tables`)
  })

  it('should handle queries across multiple connections', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return
    }

    const conn1 = await connect(DB_PATH)
    const conn2 = await connect(DB_PATH)

    const [tbl1, tbl2] = await Promise.all([
      conn1.openTable('emails'),
      conn2.openTable('emails')
    ])

    const [results1, results2] = await Promise.all([
      tbl1.query().limit(10).toArray(),
      tbl2.query().limit(10).toArray()
    ])

    // Both should return valid results
    expect(results1.length).toBeLessThanOrEqual(10)
    expect(results2.length).toBeLessThanOrEqual(10)
  })
})

describe('Concurrency: Async Function Safety', () => {
  it('should handle concurrent validator calls', async () => {
    const { validateSearchQuery, validateLimit, escapeSQL } = await import('../../lib/validators.js')

    const promises = Array(100).fill(null).map((_, i) =>
      Promise.resolve().then(() => {
        validateSearchQuery(`query ${i}`)
        validateLimit(i % 100)
        escapeSQL(`text ${i}`)
        return i
      })
    )

    const results = await Promise.all(promises)
    expect(results.length).toBe(100)
  })

  it('should handle concurrent date parsing', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const dates = ['today', 'yesterday', 'last week', '2024-01-15', 'next Monday']

    const promises = Array(50).fill(null).map((_, i) =>
      Promise.resolve().then(() => parseNaturalDate(dates[i % dates.length]))
    )

    const results = await Promise.all(promises)
    expect(results.every(r => r === null || typeof r === 'number')).toBe(true)
  })

  it('should handle concurrent keyword extraction', async () => {
    const { extractKeywords, expandQuery } = await import('../../search.js')

    const queries = [
      'meeting with team',
      'budget report',
      'flight booking',
      'doctor appointment',
      'project deadline'
    ]

    const promises = Array(50).fill(null).map((_, i) =>
      Promise.resolve().then(() => ({
        keywords: extractKeywords(queries[i % queries.length]),
        expanded: expandQuery(queries[i % queries.length])
      }))
    )

    const results = await Promise.all(promises)

    expect(results.every(r => Array.isArray(r.keywords))).toBe(true)
    expect(results.every(r => Array.isArray(r.expanded))).toBe(true)
  })
})

describe('Concurrency: Promise Patterns', () => {
  it('should handle Promise.race correctly', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const promises = [
      new Promise(resolve => setTimeout(() => resolve(validateSearchQuery('slow query')), 100)),
      new Promise(resolve => setTimeout(() => resolve(validateSearchQuery('fast query')), 10)),
      new Promise(resolve => setTimeout(() => resolve(validateSearchQuery('medium query')), 50))
    ]

    const result = await Promise.race(promises)
    expect(result).toBe('fast query')
  })

  it('should handle Promise.allSettled with mixed results', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const promises = [
      Promise.resolve(validateSearchQuery('valid')),
      Promise.reject(new Error('intentional error')),
      Promise.resolve(validateSearchQuery('also valid'))
    ]

    const results = await Promise.allSettled(promises)

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(results[2].status).toBe('fulfilled')
  })

  it('should handle sequential async operations', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const queries = ['first', 'second', 'third', 'fourth', 'fifth']
    const results = []

    for (const query of queries) {
      const validated = await Promise.resolve(validateSearchQuery(query))
      results.push(validated)
    }

    expect(results).toEqual(queries)
  })
})

describe.skipIf(!indexExists)('Concurrency: Table Operations', () => {
  it('should handle concurrent table opens', async () => {
    const tables = await db.tableNames()
    const availableTables = ['emails', 'messages', 'calendar'].filter(t => tables.includes(t))

    if (availableTables.length === 0) {
      return
    }

    // Open same table multiple times concurrently
    const promises = Array(10).fill(null).map(() =>
      db.openTable(availableTables[0])
    )

    const openedTables = await Promise.all(promises)

    // All should succeed
    expect(openedTables.length).toBe(10)
  })

  it('should handle mixed table operations', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails') || !tables.includes('messages')) {
      return
    }

    // Mix of different operations
    const operations = [
      db.openTable('emails').then(t => t.query().limit(5).toArray()),
      db.openTable('messages').then(t => t.query().limit(5).toArray()),
      db.openTable('emails').then(t => t.query().limit(10).toArray()),
      db.openTable('messages').then(t => t.query().limit(10).toArray())
    ]

    const results = await Promise.all(operations)

    expect(results.every(r => Array.isArray(r))).toBe(true)
  })
})
