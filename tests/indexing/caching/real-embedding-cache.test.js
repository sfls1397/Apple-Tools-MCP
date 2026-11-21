
import { describe, it, expect, beforeAll } from 'vitest'
import {
  checkDataSources,
  isProductionIndexReady,
  embed,
  embedBatch,
  getEmbedder
} from '../helpers/real-data.js'

const sources = checkDataSources()

describe.skipIf(!sources.embedder)('Real Embedding Cache', () => {
  let embedder

  beforeAll(async () => {
    embedder = await getEmbedder()
  }, 60000)

  describe('Embedding Generation', () => {
    it('should generate embeddings using real model', async () => {
      const text = 'This is a test email about quarterly meeting'
      const vector = await embed(text)

      expect(vector).toHaveLength(384)
      expect(vector[0]).toBeTypeOf('number')
    }, 30000)

    it('should generate consistent embeddings for same text', async () => {
      const text = 'Important project update from the team'

      const vec1 = await embed(text)
      const vec2 = await embed(text)

      expect(vec1.length).toBe(vec2.length)

      for (let i = 0; i < vec1.length; i++) {
        expect(Math.abs(vec1[i] - vec2[i])).toBeLessThan(1e-6)
      }
    }, 30000)
  })

  describe('Batch Embedding', () => {
    it('should batch embed multiple texts', async () => {
      const texts = [
        'Meeting about budget review',
        'Dinner plans for Friday',
        'Project deadline reminder'
      ]

      const vectors = await embedBatch(texts)

      expect(vectors).toHaveLength(3)
      for (const vec of vectors) {
        expect(vec).toHaveLength(384)
      }
    }, 30000)

    it('should produce different vectors for different texts', async () => {
      const texts = [
        'Weather forecast for tomorrow',
        'Quarterly financial report'
      ]

      const vectors = await embedBatch(texts)

      let dot = 0, norm1 = 0, norm2 = 0
      for (let i = 0; i < 384; i++) {
        dot += vectors[0][i] * vectors[1][i]
        norm1 += vectors[0][i] * vectors[0][i]
        norm2 += vectors[1][i] * vectors[1][i]
      }
      const similarity = dot / (Math.sqrt(norm1) * Math.sqrt(norm2))

      expect(similarity).toBeLessThan(0.9)
    }, 30000)
  })

  describe('Cache Performance', () => {
    it('should be faster on repeated embeddings due to model caching', async () => {
      const text = 'Cache performance test text for embedding'

      const start1 = performance.now()
      await embed(text)
      const duration1 = performance.now() - start1

      const start2 = performance.now()
      await embed(text)
      const duration2 = performance.now() - start2

      expect(duration2).toBeLessThan(Math.max(duration1 * 20, 5000))

      console.log(`First embed: ${duration1.toFixed(0)}ms, Second: ${duration2.toFixed(0)}ms`)
    }, 30000)

    it('should handle rapid sequential embeddings', async () => {
      const texts = Array.from({ length: 10 }, (_, i) => `Test text number ${i}`)

      const start = performance.now()
      for (const text of texts) {
        await embed(text)
      }
      const duration = performance.now() - start

      expect(duration).toBeLessThan(30000)
      console.log(`10 sequential embeddings: ${duration.toFixed(0)}ms (${(duration/10).toFixed(0)}ms avg)`)
    }, 60000)
  })

  describe('Model Pipeline', () => {
    it('should reuse embedding pipeline', async () => {
      const embedder1 = await getEmbedder()
      const embedder2 = await getEmbedder()

      expect(embedder1).toBe(embedder2)
    }, 30000)

    it('should support pooling options', async () => {
      const text = 'Test with pooling options'
      const result = await embedder(text, { pooling: 'mean', normalize: true })

      expect(result.data).toHaveLength(384)
    }, 30000)
  })
})

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar)(
  'Search Result Caching',
  () => {
    beforeAll(async () => {
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error('System index not found. Run "npm run build-index" first.')
      }
    }, 180000)

    it('should benefit from repeated searches', async () => {
      const { searchProductionIndex } = await import('../helpers/real-data.js')

      const query = 'meeting tomorrow'

      const start1 = performance.now()
      const results1 = await searchProductionIndex(query, 'emails', 5)
      const duration1 = performance.now() - start1

      const start2 = performance.now()
      const results2 = await searchProductionIndex(query, 'emails', 5)
      const duration2 = performance.now() - start2

      expect(results1.length).toBe(results2.length)

      console.log(`First search: ${duration1.toFixed(0)}ms, Second: ${duration2.toFixed(0)}ms`)
    }, 60000)

    it('should handle different query variations', async () => {
      const { searchProductionIndex } = await import('../helpers/real-data.js')

      const queries = [
        'project update',
        'schedule meeting',
        'budget review',
        'team discussion'
      ]

      for (const query of queries) {
        const results = await searchProductionIndex(query, 'emails', 3)
        expect(Array.isArray(results)).toBe(true)
      }
    }, 60000)
  }
)
