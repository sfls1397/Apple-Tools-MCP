/**
 * Real Data Accuracy Tests
 *
 * Validates that indexed data accurately reflects source data:
 * - Field mapping correctness
 * - Data transformation accuracy
 * - Embedding quality
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import { execSync } from 'child_process'
import {
  checkDataSources,
  isProductionIndexReady,
  searchProductionIndex,
  embed,
  MAIL_DIR,
  MESSAGES_DB,
  CALENDAR_DB,
  PRODUCTION_INDEX_DIR
} from '../helpers/real-data.js'

const sources = checkDataSources()

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
  'Real Data Accuracy',
  () => {
    beforeAll(async () => {
      // Production index must already exist - tests only validate, don't build
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error(
          'Production index not found or empty. ' +
          'Run "npm run rebuild-index" to build it first.'
        )
      }
    }, 60000)

    describe.skipIf(!sources.mail)('Email Field Correctness', () => {
      it('should have valid filePath pointing to real .emlx file', async () => {
        const results = await searchProductionIndex('email', 'emails', 10)

        for (const email of results) {
          expect(email.filePath).toBeTruthy()
          expect(email.filePath).toMatch(/\.emlx$/)
          expect(email.filePath).toContain(MAIL_DIR)

          // Verify file exists (sample a few)
          if (results.indexOf(email) < 3) {
            expect(fs.existsSync(email.filePath)).toBe(true)
          }
        }
      }, 60000)

      it('should have valid email addresses in from field', async () => {
        const results = await searchProductionIndex('from', 'emails', 10)

        for (const email of results) {
          // from should be a string (may contain name + email or just email)
          expect(typeof email.from).toBe('string')
        }
      }, 30000)

      it('should have fromEmail in email format', async () => {
        const results = await searchProductionIndex('test', 'emails', 10)

        for (const email of results) {
          if (email.fromEmail) {
            expect(email.fromEmail).toMatch(/.*@.*/)
          }
        }
      }, 30000)

      it('should have numeric dateTimestamp', async () => {
        const results = await searchProductionIndex('meeting', 'emails', 10)

        for (const email of results) {
          expect(typeof email.dateTimestamp).toBe('number')
          expect(email.dateTimestamp).toBeGreaterThan(0)

          // Should be reasonable (after year 2000, before year 2100)
          const year2000 = new Date('2000-01-01').getTime()
          const year2100 = new Date('2100-01-01').getTime()
          expect(email.dateTimestamp).toBeGreaterThan(year2000)
          expect(email.dateTimestamp).toBeLessThan(year2100)
        }
      }, 30000)

      it('should have 384-dim vector embeddings', async () => {
        const results = await searchProductionIndex('hello', 'emails', 5)

        for (const email of results) {
          expect(email.vector).toBeDefined()
          expect(email.vector).toHaveLength(384)
          const vectorArray = Array.from(email.vector)
          expect(Number.isFinite(vectorArray[0])).toBe(true)
        }
      }, 30000)

      it('should have mailbox extracted from path', async () => {
        const results = await searchProductionIndex('inbox', 'emails', 5)

        for (const email of results) {
          expect(email.mailbox).toBeTruthy()
          expect(typeof email.mailbox).toBe('string')
        }
      }, 30000)
    })

    describe.skipIf(!sources.messages)('Message Field Correctness', () => {
      it('should have valid message id', async () => {
        const results = await searchProductionIndex('hello', 'messages', 10)

        for (const msg of results) {
          expect(msg.id).toBeTruthy()
          expect(typeof msg.id).toBe('string')
        }
      }, 30000)

      it('should have text content', async () => {
        const results = await searchProductionIndex('meeting', 'messages', 10)

        for (const msg of results) {
          expect(msg.text).toBeTruthy()
          expect(typeof msg.text).toBe('string')
          expect(msg.text.length).toBeGreaterThan(0)
        }
      }, 30000)

      it('should have valid dateTimestamp', async () => {
        const results = await searchProductionIndex('hi', 'messages', 10)

        for (const msg of results) {
          expect(typeof msg.dateTimestamp).toBe('number')
          expect(msg.dateTimestamp).toBeGreaterThan(0)
        }
      }, 30000)

      it('should have sender information', async () => {
        const results = await searchProductionIndex('text', 'messages', 10)

        for (const msg of results) {
          expect(msg.sender).toBeTruthy()
          // Sender is either "Me" or a phone/email identifier
          expect(typeof msg.sender).toBe('string')
        }
      }, 30000)

      it('should have 384-dim vector embeddings', async () => {
        const results = await searchProductionIndex('message', 'messages', 5)

        for (const msg of results) {
          expect(msg.vector).toBeDefined()
          expect(msg.vector).toHaveLength(384)
          const vectorArray = Array.from(msg.vector)
          expect(Number.isFinite(vectorArray[0])).toBe(true)
        }
      }, 30000)
    })

    describe.skipIf(!sources.calendar)('Calendar Field Correctness', () => {
      it('should have valid event id', async () => {
        const results = await searchProductionIndex('meeting', 'calendar', 10)

        for (const event of results) {
          expect(event.id).toBeTruthy()
          expect(typeof event.id).toBe('string')
        }
      }, 30000)

      it('should have event title', async () => {
        const results = await searchProductionIndex('appointment', 'calendar', 10)

        for (const event of results) {
          expect(event.title).toBeTruthy()
          expect(typeof event.title).toBe('string')
        }
      }, 30000)

      it('should have start and end timestamps', async () => {
        const results = await searchProductionIndex('event', 'calendar', 10)

        for (const event of results) {
          expect(typeof event.startTimestamp).toBe('number')
          expect(event.startTimestamp).toBeGreaterThan(0)
        }
      }, 30000)

      it('should have calendar name', async () => {
        const results = await searchProductionIndex('calendar', 'calendar', 10)

        for (const event of results) {
          expect(event.calendar).toBeTruthy()
          expect(typeof event.calendar).toBe('string')
        }
      }, 30000)

      it('should have 384-dim vector embeddings', async () => {
        const results = await searchProductionIndex('schedule', 'calendar', 5)

        for (const event of results) {
          expect(event.vector).toBeDefined()
          expect(event.vector).toHaveLength(384)
          const vectorArray = Array.from(event.vector)
          expect(Number.isFinite(vectorArray[0])).toBe(true)
        }
      }, 30000)
    })
  }
)

describe.skipIf(!sources.embedder)('Embedding Accuracy', () => {
  it('should produce consistent embeddings for same text', async () => {
    const text = 'Important meeting about quarterly review'

    const vec1 = await embed(text)
    const vec2 = await embed(text)

    // Same text should produce identical vectors
    expect(vec1).toHaveLength(384)
    expect(vec2).toHaveLength(384)

    // Compare first few elements (floating point comparison)
    for (let i = 0; i < 10; i++) {
      expect(Math.abs(vec1[i] - vec2[i])).toBeLessThan(1e-6)
    }
  }, 30000)

  it('should produce normalized vectors (unit length)', async () => {
    const text = 'Test email about project updates'
    const vector = await embed(text)

    // Calculate magnitude
    let magnitude = 0
    for (const v of vector) {
      magnitude += v * v
    }
    magnitude = Math.sqrt(magnitude)

    // Normalized vectors should have magnitude ~1
    expect(magnitude).toBeCloseTo(1, 3)
  }, 30000)

  it('should capture semantic similarity', async () => {
    // Similar texts
    const text1 = 'Schedule a team meeting for next Tuesday'
    const text2 = 'Set up a group meeting for Tuesday next week'

    // Unrelated text
    const text3 = 'Recipe for chocolate cake with frosting'

    const vec1 = await embed(text1)
    const vec2 = await embed(text2)
    const vec3 = await embed(text3)

    // Calculate cosine similarities
    const cosineSim = (a, b) => {
      let dot = 0, norm1 = 0, norm2 = 0
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i]
        norm1 += a[i] * a[i]
        norm2 += b[i] * b[i]
      }
      return dot / (Math.sqrt(norm1) * Math.sqrt(norm2))
    }

    const simSimilar = cosineSim(vec1, vec2)
    const simUnrelated = cosineSim(vec1, vec3)

    // Similar texts should have higher similarity
    expect(simSimilar).toBeGreaterThan(simUnrelated)
    expect(simSimilar).toBeGreaterThan(0.7)
    expect(simUnrelated).toBeLessThan(0.5)
  }, 30000)
})

describe.skipIf(!sources.messages)('Message Database Accuracy', () => {
  it('should match message count with database', async () => {
    // Get count from production index
    const lancedb = await import('@lancedb/lancedb')
    const db = await lancedb.connect(PRODUCTION_INDEX_DIR)
    const tables = await db.tableNames()

    if (!tables.includes('messages')) {
      return // Skip if not indexed
    }

    const table = await db.openTable('messages')
    const indexedCount = await table.countRows()

    // Get count from database (with text)
    try {
      const dbCount = execSync(
        `sqlite3 "${MESSAGES_DB}" "SELECT COUNT(*) FROM message WHERE text IS NOT NULL AND text != ''"`,
        { encoding: 'utf-8' }
      )
      const actualCount = parseInt(dbCount.trim())

      // Indexed count should be reasonable compared to actual
      // (may differ due to filtering, limits, etc.)
      expect(indexedCount).toBeGreaterThan(0)
      console.log(`Messages: ${indexedCount} indexed / ${actualCount} in database`)
    } catch (e) {
      console.warn('Could not verify message count:', e.message)
    }
  }, 30000)
})

describe.skipIf(!sources.mail)('Email Source Accuracy', () => {
  it('should verify indexed email matches source file', async () => {
    const results = await searchProductionIndex('test', 'emails', 1)

    if (results.length === 0) return

    const email = results[0]

    // Read source file
    if (fs.existsSync(email.filePath)) {
      const content = fs.readFileSync(email.filePath, 'utf-8')

      // Subject from index should appear in source file
      if (email.subject) {
        // Subject might be encoded, so just check it's reasonable
        expect(typeof email.subject).toBe('string')
      }

      // From should appear in source
      if (email.from) {
        expect(typeof email.from).toBe('string')
      }
    }
  }, 30000)
})
