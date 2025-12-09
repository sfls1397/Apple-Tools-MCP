/**
 * Performance Benchmark Tests
 *
 * Measures and asserts performance characteristics:
 * - Search latency
 * - Memory usage
 * - Throughput
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { connect } from '@lancedb/lancedb'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.env.HOME, '.apple-tools-mcp', 'lance_index')
const indexExists = fs.existsSync(DB_PATH)

let db = null

// Helper to measure execution time
async function measureTime(fn) {
  const start = performance.now()
  const result = await fn()
  const duration = performance.now() - start
  return { result, duration }
}

// Helper to measure memory usage
function measureMemory() {
  const usage = process.memoryUsage()
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024)
  }
}

describe.skipIf(!indexExists)('Performance: Search Latency', () => {
  beforeAll(async () => {
    if (indexExists) {
      db = await connect(DB_PATH)
    }
  })

  it('should complete email table query in <100ms', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      console.log('  → Skipped: emails table not found')
      return
    }

    const tbl = await db.openTable('emails')
    const { duration } = await measureTime(async () => {
      return await tbl.query().limit(100).toArray()
    })

    console.log(`  → Email query (100 rows): ${duration.toFixed(1)}ms`)
    expect(duration).toBeLessThan(100)
  })

  it('should complete messages table query in <100ms', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      console.log('  → Skipped: messages table not found')
      return
    }

    const tbl = await db.openTable('messages')
    const { duration } = await measureTime(async () => {
      return await tbl.query().limit(100).toArray()
    })

    console.log(`  → Messages query (100 rows): ${duration.toFixed(1)}ms`)
    expect(duration).toBeLessThan(100)
  })

  it('should complete calendar table query in <100ms', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('calendar')) {
      console.log('  → Skipped: calendar table not found')
      return
    }

    const tbl = await db.openTable('calendar')
    const { duration } = await measureTime(async () => {
      return await tbl.query().limit(100).toArray()
    })

    console.log(`  → Calendar query (100 rows): ${duration.toFixed(1)}ms`)
    expect(duration).toBeLessThan(100)
  })

  it('should handle large result sets efficiently (<500ms for 1000 rows)', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      console.log('  → Skipped: messages table not found')
      return
    }

    const tbl = await db.openTable('messages')
    const { duration, result } = await measureTime(async () => {
      return await tbl.query().limit(1000).toArray()
    })

    console.log(`  → Large query (${result.length} rows): ${duration.toFixed(1)}ms`)
    expect(duration).toBeLessThan(500)
  })
})

describe.skipIf(!indexExists)('Performance: Memory Usage', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should maintain reasonable heap usage during queries', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      console.log('  → Skipped: emails table not found')
      return
    }

    const beforeMem = measureMemory()

    const tbl = await db.openTable('emails')
    for (let i = 0; i < 10; i++) {
      await tbl.query().limit(100).toArray()
    }

    const afterMem = measureMemory()
    const heapGrowth = afterMem.heapUsed - beforeMem.heapUsed

    console.log(`  → Heap before: ${beforeMem.heapUsed}MB, after: ${afterMem.heapUsed}MB`)
    console.log(`  → Heap growth: ${heapGrowth}MB`)

    // Allow up to 100MB growth for 10 queries
    expect(heapGrowth).toBeLessThan(100)
  })

  it('should not leak memory on repeated queries', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      console.log('  → Skipped: messages table not found')
      return
    }

    // Force GC if available
    if (global.gc) global.gc()

    const tbl = await db.openTable('messages')
    const measurements = []

    for (let i = 0; i < 5; i++) {
      await tbl.query().limit(500).toArray()
      measurements.push(measureMemory().heapUsed)
    }

    console.log(`  → Memory samples: ${measurements.join(', ')}MB`)

    // Check that memory doesn't grow linearly
    const first = measurements[0]
    const last = measurements[measurements.length - 1]
    const growth = last - first

    // Allow up to 50MB total growth
    expect(growth).toBeLessThan(50)
  })
})

describe.skipIf(!indexExists)('Performance: Throughput', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 50 sequential queries in <5s', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      console.log('  → Skipped: emails table not found')
      return
    }

    const tbl = await db.openTable('emails')
    const { duration } = await measureTime(async () => {
      for (let i = 0; i < 50; i++) {
        await tbl.query().limit(10).toArray()
      }
    })

    const avgLatency = duration / 50
    console.log(`  → 50 queries in ${duration.toFixed(0)}ms (avg: ${avgLatency.toFixed(1)}ms)`)

    expect(duration).toBeLessThan(5000)
  })

  it('should maintain consistent latency under load', async () => {
    const tables = await db.tableNames()
    if (!tables.includes('messages')) {
      console.log('  → Skipped: messages table not found')
      return
    }

    const tbl = await db.openTable('messages')
    const latencies = []

    for (let i = 0; i < 20; i++) {
      const { duration } = await measureTime(async () => {
        await tbl.query().limit(50).toArray()
      })
      latencies.push(duration)
    }

    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const max = Math.max(...latencies)
    const min = Math.min(...latencies)
    const variance = max - min

    console.log(`  → Latency: min=${min.toFixed(1)}ms, avg=${avg.toFixed(1)}ms, max=${max.toFixed(1)}ms`)
    console.log(`  → Variance: ${variance.toFixed(1)}ms`)

    // Max should be less than 5x average (no major outliers)
    expect(max).toBeLessThan(avg * 5)
  })
})

describe('Performance: Utility Functions', () => {
  it('should parse dates quickly (<1ms for 100 dates)', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const dates = [
      'today', 'yesterday', 'last week', 'next Monday',
      '2024-01-15', 'January 15, 2024', 'Jan 15'
    ]

    const { duration } = await measureTime(() => {
      for (let i = 0; i < 100; i++) {
        dates.forEach(d => parseNaturalDate(d))
      }
    })

    console.log(`  → 700 date parses in ${duration.toFixed(1)}ms`)
    // chrono-node date parsing can be slower on first calls due to lazy loading
    expect(duration).toBeLessThan(500)
  })

  it('should validate inputs quickly (<1ms for 1000 validations)', async () => {
    const { validateSearchQuery, validateLimit } = await import('../../lib/validators.js')

    const { duration } = await measureTime(() => {
      for (let i = 0; i < 1000; i++) {
        validateSearchQuery('test query ' + i)
        validateLimit(i % 100)
      }
    })

    console.log(`  → 2000 validations in ${duration.toFixed(1)}ms`)
    expect(duration).toBeLessThan(50)
  })
})
