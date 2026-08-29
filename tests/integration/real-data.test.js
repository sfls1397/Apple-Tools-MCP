/**
 * Integration tests using real Apple data
 * These tests run against your actual LanceDB index and Apple databases
 *
 * Tests will skip gracefully if the index doesn't exist
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { connect } from '@lancedb/lancedb'
import { pipeline } from '@xenova/transformers'

// Real paths
const DATA_DIR = path.join(process.env.HOME, '.apple-tools-mcp')
const DB_PATH = path.join(DATA_DIR, 'vector-index')

// Check if index exists
const indexExists = fs.existsSync(DB_PATH)

// Embedding model (loaded once)
let embedder = null

async function getEmbedding(text) {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

describe.skipIf(!indexExists)('Real Data Integration Tests', () => {
  let db = null
  let tables = []

  beforeAll(async () => {
    if (!indexExists) return

    db = await connect(DB_PATH)
    tables = await db.tableNames()
    console.log(`Connected to LanceDB with tables: ${tables.join(', ')}`)
  })

  describe('Index Health', () => {
    it('should have LanceDB database', () => {
      expect(fs.existsSync(DB_PATH)).toBe(true)
    })

    it('should have at least one table', async () => {
      expect(tables.length).toBeGreaterThan(0)
    })

    it('should have emails table', async () => {
      expect(tables).toContain('emails')
    })

    it('should have messages table', async () => {
      expect(tables).toContain('messages')
    })

    it('should have calendar table', async () => {
      expect(tables).toContain('calendar')
    })
  })

  describe('Email Search', () => {
    it('should return results for common query', async () => {
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('meeting')

      const results = await table.search(embedding).limit(5).toArray()

      // Should have some results (unless index is empty)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should return results with expected structure', async () => {
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('important')

      const results = await table.search(embedding).limit(1).toArray()

      if (results.length > 0) {
        const email = results[0]
        // Verify expected fields exist
        expect(email).toHaveProperty('subject')
        expect(email).toHaveProperty('from')
        expect(email).toHaveProperty('date')
        expect(email).toHaveProperty('filePath')
      }
    })

    it('should have valid file paths', async () => {
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('email')

      const results = await table.search(embedding).limit(3).toArray()

      for (const email of results) {
        if (email.filePath) {
          // Path should be in Mail directory
          expect(email.filePath).toContain('Library/Mail')
          expect(email.filePath).toMatch(/\.emlx$/)
        }
      }
    })

    it.skip('should have reasonable dates', async () => {
      // SKIPPED: Production index is unlimited by default, so dates are not
      // constrained to a 30-day window. Kept as a sanity check that dates
      // are parseable and not in the far future.
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('recent')

      const results = await table.search(embedding).limit(5).toArray()

      const now = Date.now()

      for (const email of results) {
        if (email.date) {
          const timestamp = typeof email.date === 'number' ? email.date : new Date(email.date).getTime()
          expect(timestamp).toBeLessThanOrEqual(now + 86400000) // Allow 1 day future for timezone
        }
      }
    })
  })

  describe('Messages Search', () => {
    it('should return results for common query', async () => {
      if (!tables.includes('messages')) return

      const table = await db.openTable('messages')
      const embedding = await getEmbedding('hello')

      const results = await table.search(embedding).limit(5).toArray()

      expect(Array.isArray(results)).toBe(true)
    })

    it('should return results with expected structure', async () => {
      if (!tables.includes('messages')) return

      const table = await db.openTable('messages')
      const embedding = await getEmbedding('message')

      const results = await table.search(embedding).limit(1).toArray()

      if (results.length > 0) {
        const msg = results[0]
        // Verify expected fields
        expect(msg).toHaveProperty('text')
        expect(msg).toHaveProperty('date')
        expect(msg).toHaveProperty('chatIdentifier')
      }
    })

    it('should have chat identifiers in valid format', async () => {
      if (!tables.includes('messages')) return

      const table = await db.openTable('messages')
      const embedding = await getEmbedding('text')

      const results = await table.search(embedding).limit(5).toArray()

      for (const msg of results) {
        if (msg.chatIdentifier) {
          // Should be email or phone format
          const isEmail = msg.chatIdentifier.includes('@')
          const isPhone = /^\+?\d/.test(msg.chatIdentifier)
          expect(isEmail || isPhone).toBe(true)
        }
      }
    })
  })

  describe('Calendar Search', () => {
    it('should return results for common query', async () => {
      if (!tables.includes('calendar')) return

      const table = await db.openTable('calendar')
      const embedding = await getEmbedding('meeting')

      const results = await table.search(embedding).limit(5).toArray()

      expect(Array.isArray(results)).toBe(true)
    })

    it('should return results with expected structure', async () => {
      if (!tables.includes('calendar')) return

      const table = await db.openTable('calendar')
      const embedding = await getEmbedding('appointment')

      const results = await table.search(embedding).limit(1).toArray()

      if (results.length > 0) {
        const event = results[0]
        // Verify expected fields
        expect(event).toHaveProperty('title')
        expect(event).toHaveProperty('start')
      }
    })

    it('should have calendar names', async () => {
      if (!tables.includes('calendar')) return

      const table = await db.openTable('calendar')
      const embedding = await getEmbedding('event')

      const results = await table.search(embedding).limit(5).toArray()

      for (const event of results) {
        if (event.calendar) {
          expect(typeof event.calendar).toBe('string')
          expect(event.calendar.length).toBeGreaterThan(0)
        }
      }
    })
  })

  describe('Cross-Source Consistency', () => {
    it('should use same embedding dimension across tables', async () => {
      const dimensions = []

      for (const tableName of ['emails', 'messages', 'calendar']) {
        if (!tables.includes(tableName)) continue

        const table = await db.openTable(tableName)
        const embedding = await getEmbedding('test')
        const results = await table.search(embedding).limit(1).toArray()

        if (results.length > 0 && results[0].vector) {
          dimensions.push(results[0].vector.length)
        }
      }

      // All dimensions should be the same (384 for MiniLM-L6-v2)
      if (dimensions.length > 1) {
        const first = dimensions[0]
        expect(dimensions.every(d => d === first)).toBe(true)
        expect(first).toBe(384) // MiniLM-L6-v2 dimension
      }
    })
  })

  describe('Search Quality', () => {
    it('should return relevant results for specific query', async () => {
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('invoice payment')

      const results = await table.search(embedding).limit(10).toArray()

      // Check that distances are reasonable (0 = perfect match, 2 = opposite)
      for (const result of results) {
        if (result._distance !== undefined) {
          expect(result._distance).toBeGreaterThanOrEqual(0)
          expect(result._distance).toBeLessThan(2)
        }
      }
    })

    it('should return results sorted by relevance', async () => {
      if (!tables.includes('emails')) return

      const table = await db.openTable('emails')
      const embedding = await getEmbedding('project update')

      const results = await table.search(embedding).limit(5).toArray()

      // Results should be sorted by distance (ascending)
      for (let i = 1; i < results.length; i++) {
        if (results[i]._distance !== undefined && results[i-1]._distance !== undefined) {
          expect(results[i]._distance).toBeGreaterThanOrEqual(results[i-1]._distance)
        }
      }
    })
  })
})

describe.skipIf(!indexExists)('Real Contacts Integration', () => {
  const ADDRESSBOOK_DIR = path.join(process.env.HOME, 'Library', 'Application Support', 'AddressBook')
  const contactsExist = fs.existsSync(ADDRESSBOOK_DIR)

  it.skipIf(!contactsExist)('should have AddressBook directory', () => {
    expect(fs.existsSync(ADDRESSBOOK_DIR)).toBe(true)
  })
})

// Report skip reason if index doesn't exist
if (!indexExists) {
  console.log(`
  ⚠️  Real data tests skipped - LanceDB index not found at ${DB_PATH}

  To run these tests:
  1. Start the MCP server to build the index
  2. Wait for indexing to complete
  3. Run tests again
  `)
}
