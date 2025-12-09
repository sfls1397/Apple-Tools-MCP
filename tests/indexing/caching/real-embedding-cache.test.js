/**
 * Real Embedding Cache Tests
 *
 * Tests embedding caching with real Xenova/all-MiniLM-L6-v2 model
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  checkDataSources,
  isProductionIndexReady,
  embed,
  embedBatch,
  getEmbedder
} from '../helpers/real-data.js'

const sources = checkDataSources()

describe('Real Embedding Cache', () => {
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

      // Same text should produce identical vectors
      expect(vec1.length).toBe(vec2.length)

      // Check each element is the same (within floating point tolerance)
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

      // Calculate cosine similarity
      let dot = 0, norm1 = 0, norm2 = 0
      for (let i = 0; i < 384; i++) {
        dot += vectors[0][i] * vectors[1][i]
        norm1 += vectors[0][i] * vectors[0][i]
        norm2 += vectors[1][i] * vectors[1][i]
      }
      const similarity = dot / (Math.sqrt(norm1) * Math.sqrt(norm2))

      // Different texts should have lower similarity
      expect(similarity).toBeLessThan(0.9)
    }, 30000)
  })

  describe('Cache Performance', () => {
    it('should be faster on repeated embeddings due to model caching', async () => {
      const text = 'Cache performance test text for embedding'

      // First call - model may need warmup
      const start1 = performance.now()
      await embed(text)
      const duration1 = performance.now() - start1

      // Second call - should be faster (model cached)
      const start2 = performance.now()
      await embed(text)
      const duration2 = performance.now() - start2

      // Second call should be faster or similar (not slower)
      // Allow generous variance due to system load - real goal is catching model reloads (100x+ slower)
      expect(duration2).toBeLessThan(duration1 * 3)

      console.log(`First embed: ${duration1.toFixed(0)}ms, Second: ${duration2.toFixed(0)}ms`)
    }, 30000)

    it('should handle rapid sequential embeddings', async () => {
      const texts = Array.from({ length: 10 }, (_, i) => `Test text number ${i}`)

      const start = performance.now()
      for (const text of texts) {
        await embed(text)
      }
      const duration = performance.now() - start

      // Should complete in reasonable time (< 30s for 10 texts)
      expect(duration).toBeLessThan(30000)
      console.log(`10 sequential embeddings: ${duration.toFixed(0)}ms (${(duration/10).toFixed(0)}ms avg)`)
    }, 60000)
  })

  describe('Model Pipeline', () => {
    it('should reuse embedding pipeline', async () => {
      const embedder1 = await getEmbedder()
      const embedder2 = await getEmbedder()

      // Should be same instance (cached)
      expect(embedder1).toBe(embedder2)
    }, 30000)

    it('should support pooling options', async () => {
      // Direct use of embedder with options
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
      // System index must already exist - tests never rebuild it
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error('System index not found. Run "npm run build-index" first.')
      }
    }, 180000)

    it('should benefit from repeated searches', async () => {
      // This tests that LanceDB/embedding caching works in search
      const { searchProductionIndex } = await import('../helpers/real-data.js')

      const query = 'meeting tomorrow'

      // First search
      const start1 = performance.now()
      const results1 = await searchProductionIndex(query, 'emails', 5)
      const duration1 = performance.now() - start1

      // Second search (same query) - should benefit from caching
      const start2 = performance.now()
      const results2 = await searchProductionIndex(query, 'emails', 5)
      const duration2 = performance.now() - start2

      // Results should be the same
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
