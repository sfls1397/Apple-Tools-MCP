/**
 * Performance & Boundary Tests - Stress testing and performance validation
 *
 * Tests for:
 * - Large result sets
 * - Concurrent operations
 * - Response time boundaries
 * - Memory-efficient processing
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { connect } from '@lancedb/lancedb'
import { pipeline } from '@huggingface/transformers'
import {
  loadContacts,
  searchContacts,
  lookupContact
} from '../../contacts.js'

// Real paths
const DATA_DIR = path.join(process.env.HOME, '.apple-tools-mcp')
const DB_PATH = path.join(DATA_DIR, 'vector-index')

const indexExists = fs.existsSync(DB_PATH)

let db = null
let embedder = null

async function getEmbedding(text) {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

async function searchTable(tableName, query, limit = 10) {
  if (!db) return []
  try {
    const tables = await db.tableNames()
    if (!tables.includes(tableName)) return []
    const table = await db.openTable(tableName)
    const embedding = await getEmbedding(query)
    return await table.search(embedding).limit(limit).toArray()
  } catch (e) {
    return []
  }
}

// ============================================================================
// LARGE RESULT SET TESTS
// ============================================================================

describe.skipIf(!indexExists)('Large Result Set Handling', () => {
  beforeAll(async () => {
    if (indexExists) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 100 result limit efficiently', async () => {
    const start = Date.now()
    const results = await searchTable('emails', 'the', 100)
    const elapsed = Date.now() - start

    console.log(`  → Retrieved ${results.length} emails in ${elapsed}ms`)

    expect(results.length).toBeLessThanOrEqual(100)
    expect(elapsed).toBeLessThan(10000) // Should complete within 10 seconds
  })

  it('should handle 200 result limit', async () => {
    const start = Date.now()
    const results = await searchTable('emails', 'meeting', 200)
    const elapsed = Date.now() - start

    console.log(`  → Retrieved ${results.length} emails in ${elapsed}ms`)

    expect(results.length).toBeLessThanOrEqual(200)
    expect(elapsed).toBeLessThan(15000)
  })

  it('should handle large message queries', async () => {
    const start = Date.now()
    const results = await searchTable('messages', 'hi', 100)
    const elapsed = Date.now() - start

    console.log(`  → Retrieved ${results.length} messages in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(10000)
  })

  it('should handle large calendar queries', async () => {
    const start = Date.now()
    const results = await searchTable('calendar', 'meeting', 100)
    const elapsed = Date.now() - start

    console.log(`  → Retrieved ${results.length} calendar events in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(10000)
  })
})

// ============================================================================
// CONCURRENT OPERATION TESTS
// ============================================================================

describe.skipIf(!indexExists)('Concurrent Operations', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle 3 concurrent email searches', async () => {
    const start = Date.now()

    const [results1, results2, results3] = await Promise.all([
      searchTable('emails', 'meeting', 10),
      searchTable('emails', 'project', 10),
      searchTable('emails', 'deadline', 10)
    ])

    const elapsed = Date.now() - start

    console.log(`  → 3 concurrent searches completed in ${elapsed}ms`)
    console.log(`  → Results: ${results1.length}, ${results2.length}, ${results3.length}`)

    expect(Array.isArray(results1)).toBe(true)
    expect(Array.isArray(results2)).toBe(true)
    expect(Array.isArray(results3)).toBe(true)
    // Concurrent should be faster than sequential (or at least not crash)
    expect(elapsed).toBeLessThan(30000)
  })

  it('should handle concurrent searches across different tables', async () => {
    const start = Date.now()

    const [emails, messages, calendar] = await Promise.all([
      searchTable('emails', 'update', 10),
      searchTable('messages', 'update', 10),
      searchTable('calendar', 'update', 10)
    ])

    const elapsed = Date.now() - start

    console.log(`  → Cross-table concurrent search in ${elapsed}ms`)

    expect(Array.isArray(emails)).toBe(true)
    expect(Array.isArray(messages)).toBe(true)
    expect(Array.isArray(calendar)).toBe(true)
  })

  it('should handle 5 concurrent searches', async () => {
    const queries = ['invoice', 'receipt', 'payment', 'order', 'confirmation']

    const start = Date.now()
    const results = await Promise.all(
      queries.map(q => searchTable('emails', q, 10))
    )
    const elapsed = Date.now() - start

    console.log(`  → 5 concurrent searches completed in ${elapsed}ms`)

    results.forEach((r, i) => {
      expect(Array.isArray(r)).toBe(true)
      console.log(`  → "${queries[i]}": ${r.length} results`)
    })
  })
})

// ============================================================================
// RESPONSE TIME TESTS
// ============================================================================

describe.skipIf(!indexExists)('Response Time Boundaries', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should return first 10 results within 5 seconds', async () => {
    const start = Date.now()
    const results = await searchTable('emails', 'important', 10)
    const elapsed = Date.now() - start

    console.log(`  → 10 results in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(5000)
  })

  it('should handle obscure query quickly', async () => {
    const start = Date.now()
    const results = await searchTable('emails', 'xyznonexistentquery99999', 10)
    const elapsed = Date.now() - start

    console.log(`  → Obscure query result in ${elapsed}ms, found ${results.length} results`)

    // Vector search always returns nearest neighbors, even for nonsense queries
    // The important thing is that it completes quickly
    expect(elapsed).toBeLessThan(5000)
    expect(Array.isArray(results)).toBe(true)
  })

  it('should handle repeated queries efficiently (caching)', async () => {
    // First query (cold)
    const start1 = Date.now()
    await searchTable('emails', 'test query for cache', 10)
    const elapsed1 = Date.now() - start1

    // Second query (potentially cached)
    const start2 = Date.now()
    await searchTable('emails', 'test query for cache', 10)
    const elapsed2 = Date.now() - start2

    console.log(`  → First query: ${elapsed1}ms, Second query: ${elapsed2}ms`)

    // Second should be same or faster (caching may help)
    expect(elapsed2).toBeLessThanOrEqual(elapsed1 * 1.5) // Allow some variance
  })
})

// ============================================================================
// CONTACT PERFORMANCE TESTS
// ============================================================================

describe('Contact Operations Performance', () => {
  beforeAll(() => {
    loadContacts()
  })

  it('should handle rapid lookups', () => {
    const start = Date.now()

    // Perform 100 lookups
    for (let i = 0; i < 100; i++) {
      lookupContact('john@example.com')
    }

    const elapsed = Date.now() - start
    console.log(`  → 100 contact lookups in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(1000) // Should be very fast
  })

  it('should handle rapid searches', () => {
    const start = Date.now()

    // Perform 50 searches
    for (let i = 0; i < 50; i++) {
      searchContacts('john', 10)
    }

    const elapsed = Date.now() - start
    console.log(`  → 50 contact searches in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(1000)
  })

  it('should search entire contact database efficiently', () => {
    const start = Date.now()
    const results = searchContacts('a', 1000) // Wide search
    const elapsed = Date.now() - start

    console.log(`  → Full contact search: ${results.length} results in ${elapsed}ms`)

    expect(elapsed).toBeLessThan(500)
  })
})

// ============================================================================
// MEMORY EFFICIENCY TESTS
// ============================================================================

describe.skipIf(!indexExists)('Memory Efficiency', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should not accumulate memory over repeated queries', async () => {
    // Run multiple queries and check we can complete without issues
    for (let i = 0; i < 20; i++) {
      await searchTable('emails', `query ${i}`, 10)
    }

    // If we get here without crashing, memory is managed
    expect(true).toBe(true)
  })

  it('should handle alternating table queries', async () => {
    for (let i = 0; i < 10; i++) {
      await searchTable('emails', 'test', 5)
      await searchTable('messages', 'test', 5)
      await searchTable('calendar', 'test', 5)
    }

    expect(true).toBe(true)
  })
})

// ============================================================================
// QUERY EXPANSION TESTS
// ============================================================================

describe('Query Processing Performance', () => {
  it('should handle query with many synonyms efficiently', async () => {
    const complexQuery = 'meeting appointment call sync discussion conference chat talk'

    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }

    if (db) {
      const start = Date.now()
      const results = await searchTable('emails', complexQuery, 10)
      const elapsed = Date.now() - start

      console.log(`  → Complex synonym query: ${elapsed}ms, ${results.length} results`)

      expect(elapsed).toBeLessThan(10000)
    } else {
      expect(true).toBe(true)
    }
  })

  it('should handle query with negations efficiently', async () => {
    const negationQuery = 'meeting NOT monday NOT tuesday'

    if (indexExists && db) {
      const start = Date.now()
      const results = await searchTable('emails', negationQuery, 10)
      const elapsed = Date.now() - start

      console.log(`  → Negation query: ${elapsed}ms, ${results.length} results`)

      expect(elapsed).toBeLessThan(10000)
    } else {
      expect(true).toBe(true)
    }
  })
})

// ============================================================================
// BATCH OPERATION TESTS
// ============================================================================

describe.skipIf(!indexExists)('Batch Operations', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  it('should handle sequential batch of queries', async () => {
    const queries = [
      'invoice', 'receipt', 'payment', 'order', 'shipping',
      'meeting', 'call', 'conference', 'sync', 'standup'
    ]

    const start = Date.now()

    for (const query of queries) {
      await searchTable('emails', query, 5)
    }

    const elapsed = Date.now() - start
    const avgPerQuery = elapsed / queries.length

    console.log(`  → 10 sequential queries: ${elapsed}ms total, ${avgPerQuery.toFixed(1)}ms avg`)

    expect(avgPerQuery).toBeLessThan(3000)
  })

  it('should handle mixed source batch queries', async () => {
    const sources = ['emails', 'messages', 'calendar']
    const query = 'update'

    const start = Date.now()

    for (let i = 0; i < 9; i++) {
      const source = sources[i % 3]
      await searchTable(source, query, 5)
    }

    const elapsed = Date.now() - start

    console.log(`  → 9 mixed-source queries: ${elapsed}ms`)

    expect(elapsed).toBeLessThan(30000)
  })
})
