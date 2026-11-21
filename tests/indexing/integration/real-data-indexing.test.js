
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import {
  checkDataSources,
  isProductionIndexReady,
  getProductionIndexStats,
  searchProductionIndex,
  embed,
  PRODUCTION_INDEX_DIR
} from '../helpers/real-data.js'

const sources = checkDataSources()

describe('Real Data Indexing', () => {
  describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
    'Full Indexing Workflow',
    () => {
      beforeAll(async () => {
        const ready = await isProductionIndexReady()
        if (!ready) {
          throw new Error(
            'Production index not found or empty. ' +
            'Run "npm run rebuild-index" to build it first.'
          )
        }
      }, 60000)

      it('should have valid production index data', async () => {
        const stats = await getProductionIndexStats()

        const totalRows = stats.emails + stats.messages + stats.calendar
        expect(totalRows).toBeGreaterThan(0)

        console.log('Index stats:', stats)
      }, 30000)

      it('should create production index directory', () => {
        expect(fs.existsSync(PRODUCTION_INDEX_DIR)).toBe(true)
      })

      it('should have valid production index stats', async () => {
        const stats = await getProductionIndexStats()

        const totalRows = stats.emails + stats.messages + stats.calendar
        expect(totalRows).toBeGreaterThan(0)

        console.log('Index stats:', stats)
      })

      it('should report index as ready', async () => {
        const ready = await isProductionIndexReady()
        expect(ready).toBe(true)
      })
    }
  )
})

describe.skipIf(!sources.mail)('Email Indexing (Real Data)', () => {
  beforeAll(async () => {
    const ready = await isProductionIndexReady()
    if (!ready) {
      throw new Error('Production index not found. Run "npm run rebuild-index" first.')
    }
  }, 30000)

  it('should index real emails', async () => {
    const stats = await getProductionIndexStats()
    expect(stats.emails).toBeGreaterThan(0)
  })

  it('should search emails with real embeddings', async () => {
    const results = await searchProductionIndex('meeting', 'emails', 5)

    if (results.length > 0) {
      expect(results[0]).toHaveProperty('filePath')
      expect(results[0]).toHaveProperty('subject')
      expect(results[0]).toHaveProperty('vector')
    }
  }, 30000)

  it('should have correct email field structure', async () => {
    const stats = await getProductionIndexStats()
    if (stats.emails === 0) return

    const results = await searchProductionIndex('email', 'emails', 1)
    if (results.length > 0) {
      const email = results[0]

      expect(email).toHaveProperty('filePath')
      expect(email).toHaveProperty('from')
      expect(email).toHaveProperty('subject')
      expect(email).toHaveProperty('dateTimestamp')
      expect(email).toHaveProperty('vector')

      expect(email.vector).toHaveLength(384)
    }
  }, 30000)
})

describe.skipIf(!sources.messages)('Message Indexing (Real Data)', () => {
  beforeAll(async () => {
    const ready = await isProductionIndexReady()
    if (!ready) {
      throw new Error('Production index not found. Run "npm run rebuild-index" first.')
    }
  }, 30000)

  it('should index real messages', async () => {
    const stats = await getProductionIndexStats()
    expect(stats.messages).toBeGreaterThan(0)
  })

  it('should search messages with real embeddings', async () => {
    const results = await searchProductionIndex('hello', 'messages', 5)

    if (results.length > 0) {
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('text')
      expect(results[0]).toHaveProperty('vector')
    }
  }, 30000)

  it('should have correct message field structure', async () => {
    const stats = await getProductionIndexStats()
    if (stats.messages === 0) return

    const results = await searchProductionIndex('message', 'messages', 1)
    if (results.length > 0) {
      const message = results[0]

      expect(message).toHaveProperty('id')
      expect(message).toHaveProperty('text')
      expect(message).toHaveProperty('dateTimestamp')
      expect(message).toHaveProperty('vector')

      expect(message.vector).toHaveLength(384)
    }
  }, 30000)
})

describe.skipIf(!sources.calendar)('Calendar Indexing (Real Data)', () => {
  beforeAll(async () => {
    const ready = await isProductionIndexReady()
    if (!ready) {
      throw new Error('Production index not found. Run "npm run rebuild-index" first.')
    }
  }, 30000)

  it('should index real calendar events', async () => {
    const stats = await getProductionIndexStats()
    expect(stats.calendar).toBeGreaterThan(0)
  })

  it('should search calendar with real embeddings', async () => {
    const results = await searchProductionIndex('meeting', 'calendar', 5)

    if (results.length > 0) {
      expect(results[0]).toHaveProperty('id')
      expect(results[0]).toHaveProperty('title')
      expect(results[0]).toHaveProperty('vector')
    }
  }, 30000)

  it('should have correct calendar field structure', async () => {
    const stats = await getProductionIndexStats()
    if (stats.calendar === 0) return

    const results = await searchProductionIndex('event', 'calendar', 1)
    if (results.length > 0) {
      const event = results[0]

      expect(event).toHaveProperty('id')
      expect(event).toHaveProperty('title')
      expect(event).toHaveProperty('startTimestamp')
      expect(event).toHaveProperty('vector')

      expect(event.vector).toHaveLength(384)
    }
  }, 30000)
})

describe.skipIf(!sources.embedder)('Real Embedding Quality', () => {
  it('should generate consistent 384-dim embeddings', async () => {
    const text = 'This is a test email about a meeting'
    const vector = await embed(text)

    expect(vector).toHaveLength(384)
    expect(vector[0]).toBeTypeOf('number')
    expect(Number.isFinite(vector[0])).toBe(true)
  }, 30000)

  it('should produce different embeddings for different text', async () => {
    const text1 = 'Meeting about quarterly budget review'
    const text2 = 'Dinner reservation at Italian restaurant'

    const vec1 = await embed(text1)
    const vec2 = await embed(text2)

    let dotProduct = 0
    let norm1 = 0
    let norm2 = 0
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i]
      norm1 += vec1[i] * vec1[i]
      norm2 += vec2[i] * vec2[i]
    }
    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))

    expect(similarity).toBeLessThan(0.7)
  }, 30000)

  it('should produce similar embeddings for similar text', async () => {
    const text1 = 'Schedule a meeting with John tomorrow at 2pm'
    const text2 = 'Set up a meeting with John tomorrow afternoon'

    const vec1 = await embed(text1)
    const vec2 = await embed(text2)

    let dotProduct = 0
    let norm1 = 0
    let norm2 = 0
    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i]
      norm1 += vec1[i] * vec1[i]
      norm2 += vec2[i] * vec2[i]
    }
    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2))

    expect(similarity).toBeGreaterThan(0.7)
  }, 30000)
})
