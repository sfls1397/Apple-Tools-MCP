/**
 * Real Data Edge Case Tests
 *
 * Tests edge cases using actual data from the system:
 * - Unicode/emoji handling
 * - Special characters
 * - Large content
 * - Empty/null fields
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import {
  checkDataSources,
  buildProductionIndex,
  isProductionIndexReady,
  searchProductionIndex,
  embed,
  sampleEmails,
  sampleMessages,
  sampleCalendarEvents,
  PRODUCTION_INDEX_DIR
} from '../helpers/real-data.js'

const sources = checkDataSources()

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
  'Real Data Edge Cases',
  () => {
    beforeAll(async () => {
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error('Production index not found. Run "npm run rebuild-index" first.')
      }
    }, 30000)

    describe('Unicode Handling', () => {
      it('should handle emoji in search queries', async () => {
        // Search with emoji - should not throw
        const results = await searchProductionIndex('🎉 celebration party', 'emails', 5)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)

      it('should handle CJK characters in search', async () => {
        // Search with Chinese characters
        const results = await searchProductionIndex('会议 meeting 会议', 'emails', 5)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)

      it('should handle mixed scripts', async () => {
        const results = await searchProductionIndex('Hello 你好 مرحبا שלום', 'messages', 5)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)

      it('should generate valid embeddings for unicode text', async () => {
        const unicodeTexts = [
          '会议安排 - Meeting Schedule',
          'Réunion avec l\'équipe française',
          'Встреча с командой',
          '🎂 Birthday party 🎉'
        ]

        for (const text of unicodeTexts) {
          const vector = await embed(text)
          expect(vector).toHaveLength(384)
          expect(vector.every(v => Number.isFinite(v))).toBe(true)
        }
      }, 60000)
    })

    describe('Special Characters', () => {
      it('should handle special characters in search', async () => {
        const specialQueries = [
          'email@test.com',
          'Re: Fw: Important',
          'C:\\Users\\test',
          '50% off sale!',
          'Q&A session',
          '<script>alert</script>'
        ]

        for (const query of specialQueries) {
          const results = await searchProductionIndex(query, 'emails', 5)
          expect(Array.isArray(results)).toBe(true)
        }
      }, 60000)

      it('should handle SQL-like characters safely', async () => {
        // These should not cause SQL injection or errors
        const queries = [
          "O'Brien meeting",
          'SELECT * FROM users',
          "'; DROP TABLE --",
          'test = value'
        ]

        for (const query of queries) {
          const results = await searchProductionIndex(query, 'messages', 5)
          expect(Array.isArray(results)).toBe(true)
        }
      }, 60000)
    })

    describe('Empty and Edge Cases', () => {
      it('should handle empty string search', async () => {
        // Empty search should return results (all docs)
        // or handle gracefully
        try {
          const results = await searchProductionIndex('', 'emails', 5)
          expect(Array.isArray(results)).toBe(true)
        } catch (e) {
          // Empty search might throw - that's acceptable
          expect(e.message).toBeDefined()
        }
      }, 30000)

      it('should handle whitespace-only search', async () => {
        try {
          const results = await searchProductionIndex('   ', 'emails', 5)
          expect(Array.isArray(results)).toBe(true)
        } catch (e) {
          expect(e.message).toBeDefined()
        }
      }, 30000)

      it('should handle very long search query', async () => {
        const longQuery = 'meeting '.repeat(100)
        const results = await searchProductionIndex(longQuery, 'emails', 5)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)

      it('should handle single character search', async () => {
        const results = await searchProductionIndex('a', 'emails', 5)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)
    })

    describe('Search Result Limits', () => {
      it('should respect limit parameter', async () => {
        const limit = 3
        const results = await searchProductionIndex('the', 'emails', limit)
        expect(results.length).toBeLessThanOrEqual(limit)
      }, 30000)

      it('should handle limit of 1', async () => {
        const results = await searchProductionIndex('email', 'emails', 1)
        expect(results.length).toBeLessThanOrEqual(1)
      }, 30000)

      it('should handle large limit', async () => {
        const results = await searchProductionIndex('meeting', 'emails', 1000)
        expect(Array.isArray(results)).toBe(true)
      }, 30000)
    })

    describe('Cross-Table Search', () => {
      it.skipIf(!sources.mail)('should search emails table', async () => {
        const results = await searchProductionIndex('important', 'emails', 5)
        expect(Array.isArray(results)).toBe(true)
        for (const r of results) {
          expect(r).toHaveProperty('filePath')
        }
      }, 30000)

      it.skipIf(!sources.messages)('should search messages table', async () => {
        const results = await searchProductionIndex('hello', 'messages', 5)
        expect(Array.isArray(results)).toBe(true)
        for (const r of results) {
          expect(r).toHaveProperty('text')
        }
      }, 30000)

      it.skipIf(!sources.calendar)('should search calendar table', async () => {
        const results = await searchProductionIndex('meeting', 'calendar', 5)
        expect(Array.isArray(results)).toBe(true)
        for (const r of results) {
          expect(r).toHaveProperty('title')
        }
      }, 30000)
    })

    describe('Error Handling', () => {
      it('should handle non-existent table gracefully', async () => {
        try {
          await searchProductionIndex('test', 'nonexistent', 5)
        } catch (e) {
          expect(e.message).toContain('not found')
        }
      })

      it('should handle invalid table name', async () => {
        try {
          await searchProductionIndex('test', '', 5)
        } catch (e) {
          expect(e).toBeDefined()
        }
      })
    })
  }
)

describe('Embedding Edge Cases', () => {
  it('should handle empty string embedding', async () => {
    const vector = await embed('')
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)

  it('should handle very long text embedding', async () => {
    const longText = 'This is a very long email about various topics. '.repeat(200)
    const vector = await embed(longText)
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)

  it('should handle numbers-only text', async () => {
    const vector = await embed('123456789012345678901234567890')
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)

  it('should handle URL-like text', async () => {
    const vector = await embed('https://www.example.com/path/to/page?query=value&other=123')
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)

  it('should handle email address text', async () => {
    const vector = await embed('john.doe@company.example.com')
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)

  it('should handle code-like text', async () => {
    const code = `
      function hello() {
        console.log("Hello, World!");
        return { status: 200, message: "OK" };
      }
    `
    const vector = await embed(code)
    expect(vector).toHaveLength(384)
    expect(vector.every(v => Number.isFinite(v))).toBe(true)
  }, 30000)
})

describe('Data Sampling', () => {
  it.skipIf(!sources.mail)('should sample real emails', async () => {
    const emails = await sampleEmails(10)
    expect(Array.isArray(emails)).toBe(true)
    // May have fewer if not enough emails exist
    expect(emails.length).toBeLessThanOrEqual(10)

    for (const path of emails) {
      expect(path).toMatch(/\.emlx$/)
      expect(fs.existsSync(path)).toBe(true)
    }
  }, 30000)

  it.skipIf(!sources.messages)('should sample real messages', async () => {
    const messages = await sampleMessages(10)
    expect(Array.isArray(messages)).toBe(true)

    for (const msg of messages) {
      expect(msg).toHaveProperty('id')
      expect(msg).toHaveProperty('text')
    }
  }, 30000)

  it.skipIf(!sources.calendar)('should sample real calendar events', async () => {
    const events = await sampleCalendarEvents(10)
    expect(Array.isArray(events)).toBe(true)

    for (const event of events) {
      expect(event).toHaveProperty('id')
      expect(event).toHaveProperty('title')
    }
  }, 30000)
})
