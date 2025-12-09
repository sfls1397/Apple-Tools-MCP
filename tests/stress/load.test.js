/**
 * Stress/Load Testing
 *
 * Tests system behavior under high load:
 * - Large result sets
 * - Rapid sequential queries
 * - Memory pressure
 * - Resource exhaustion
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { connect } from '@lancedb/lancedb'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.env.HOME, '.apple-tools-mcp', 'lance_index')
const indexExists = fs.existsSync(DB_PATH)

let db = null

describe.skipIf(!indexExists)('Stress: Large Result Sets', () => {
  beforeAll(async () => {
    if (indexExists) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 1000 result limit', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      return // Skip if no data
    }

    const tbl = await db.openTable('messages')
    const results = await tbl.query().limit(1000).toArray()

    expect(results.length).toBeLessThanOrEqual(1000)
    // Each result should have expected structure
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('text')
    }
  })

  it('should handle maximum limit without memory issues', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return
    }

    const beforeMem = process.memoryUsage().heapUsed

    const tbl = await db.openTable('emails')
    const results = await tbl.query().limit(5000).toArray()

    const afterMem = process.memoryUsage().heapUsed
    const memGrowth = (afterMem - beforeMem) / 1024 / 1024

    console.log(`  → Retrieved ${results.length} emails, memory growth: ${memGrowth.toFixed(1)}MB`)

    // Should not use more than 500MB for results
    expect(memGrowth).toBeLessThan(500)
  })

  it('should efficiently iterate large result sets', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      return
    }

    const tbl = await db.openTable('messages')
    const start = performance.now()

    let count = 0
    const results = await tbl.query().limit(2000).toArray()
    for (const row of results) {
      count++
      // Simulate processing each row
      const _ = row.text?.length || 0
    }

    const duration = performance.now() - start
    console.log(`  → Processed ${count} rows in ${duration.toFixed(0)}ms`)

    // Should process 2000 rows in under 2 seconds
    expect(duration).toBeLessThan(2000)
  })
})

describe.skipIf(!indexExists)('Stress: Rapid Sequential Queries', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 100 rapid queries', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return
    }

    const tbl = await db.openTable('emails')
    const start = performance.now()
    const errors = []

    for (let i = 0; i < 100; i++) {
      try {
        await tbl.query().limit(10).toArray()
      } catch (e) {
        errors.push(e.message)
      }
    }

    const duration = performance.now() - start
    console.log(`  → 100 queries in ${duration.toFixed(0)}ms (${errors.length} errors)`)

    expect(errors.length).toBe(0)
    expect(duration).toBeLessThan(10000) // 10 seconds max
  })

  it('should maintain consistent performance over 50 iterations', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      return
    }

    const tbl = await db.openTable('messages')
    const latencies = []

    for (let i = 0; i < 50; i++) {
      const start = performance.now()
      await tbl.query().limit(20).toArray()
      latencies.push(performance.now() - start)
    }

    // Calculate statistics
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const sorted = [...latencies].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    const p99 = sorted[Math.floor(sorted.length * 0.99)]

    console.log(`  → Latency: avg=${avg.toFixed(1)}ms, p50=${p50.toFixed(1)}ms, p95=${p95.toFixed(1)}ms, p99=${p99.toFixed(1)}ms`)

    // p99 should not be more than 10x average
    expect(p99).toBeLessThan(avg * 10)
  })

  it('should handle burst of queries', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('calendar')) {
      return
    }

    const tbl = await db.openTable('calendar')

    // Burst of 20 queries
    const start = performance.now()
    const promises = []
    for (let i = 0; i < 20; i++) {
      promises.push(tbl.query().limit(10).toArray())
    }

    const results = await Promise.all(promises)
    const duration = performance.now() - start

    console.log(`  → 20 parallel queries in ${duration.toFixed(0)}ms`)

    expect(results.every(r => Array.isArray(r))).toBe(true)
    expect(duration).toBeLessThan(5000) // 5 seconds max
  })
})

describe('Stress: Validation Under Load', () => {
  it('should handle 1000 validation calls efficiently', async () => {
    const { validateSearchQuery, validateLimit, escapeSQL } = await import('../../lib/validators.js')

    const start = performance.now()

    for (let i = 0; i < 1000; i++) {
      validateSearchQuery(`test query ${i}`)
      validateLimit(i % 100 + 1)
      escapeSQL(`string with 'quotes' ${i}`)
    }

    const duration = performance.now() - start
    console.log(`  → 3000 validations in ${duration.toFixed(1)}ms`)

    expect(duration).toBeLessThan(100) // Should be very fast
  })

  it('should handle HTML stripping for large documents', async () => {
    const { stripHtmlTags } = await import('../../lib/validators.js')

    // Generate large HTML document
    const largeHtml = '<div>' + '<p>Paragraph content here.</p>'.repeat(1000) + '</div>'

    const start = performance.now()
    const result = stripHtmlTags(largeHtml)
    const duration = performance.now() - start

    console.log(`  → Stripped ${largeHtml.length} chars in ${duration.toFixed(1)}ms`)

    expect(duration).toBeLessThan(100)
    expect(result).not.toContain('<')
  })
})

describe('Stress: Search Logic Under Load', () => {
  it('should handle 100 keyword extractions', async () => {
    const { extractKeywords } = await import('../../search.js')

    const queries = [
      'meeting with John about budget planning',
      'schedule appointment for next Tuesday',
      'email from Sarah regarding project updates',
      'flight confirmation for trip to New York',
      'invoice payment due this Friday'
    ]

    const start = performance.now()

    for (let i = 0; i < 100; i++) {
      for (const query of queries) {
        extractKeywords(query)
      }
    }

    const duration = performance.now() - start
    console.log(`  → 500 keyword extractions in ${duration.toFixed(1)}ms`)

    expect(duration).toBeLessThan(200)
  })

  it('should handle 100 query expansions', async () => {
    const { expandQuery } = await import('../../search.js')

    const queries = [
      'meeting',
      'budget discussion',
      'project review',
      'weekly standup',
      'invoice payment'
    ]

    const start = performance.now()

    for (let i = 0; i < 100; i++) {
      for (const query of queries) {
        expandQuery(query)
      }
    }

    const duration = performance.now() - start
    console.log(`  → 500 query expansions in ${duration.toFixed(1)}ms`)

    expect(duration).toBeLessThan(200)
  })
})

describe('Stress: Memory Stability', () => {
  it('should not leak memory during repeated operations', async () => {
    const { validateSearchQuery, escapeSQL, stripHtmlTags } = await import('../../lib/validators.js')

    // Force GC if available
    if (global.gc) global.gc()

    const initialMem = process.memoryUsage().heapUsed

    // Run 10000 operations
    for (let i = 0; i < 10000; i++) {
      validateSearchQuery(`query ${i}`)
      escapeSQL(`string ${i}`)
      stripHtmlTags(`<p>text ${i}</p>`)
    }

    // Force GC if available
    if (global.gc) global.gc()

    const finalMem = process.memoryUsage().heapUsed
    const growth = (finalMem - initialMem) / 1024 / 1024

    console.log(`  → Memory growth after 30k operations: ${growth.toFixed(1)}MB`)

    // Should not grow more than 50MB
    expect(growth).toBeLessThan(50)
  })

  it('should handle string concatenation at scale', () => {
    const results = []
    const start = performance.now()

    for (let i = 0; i < 1000; i++) {
      results.push({
        rank: i,
        text: `Result ${i}: ` + 'x'.repeat(100)
      })
    }

    // Format results
    const formatted = results.map(r =>
      `[${r.rank}] ${r.text}`
    ).join('\n---\n')

    const duration = performance.now() - start
    console.log(`  → Formatted ${results.length} results (${formatted.length} chars) in ${duration.toFixed(1)}ms`)

    expect(duration).toBeLessThan(500)
  })
})
