/**
 * Negative tests for embedding failure handling
 * Tests graceful handling of NaN vectors, dimension errors, and partial failures
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const EMBEDDING_DIM = 384

describe('Embedding Failure Handling', () => {
  describe('invalid vector detection', () => {
    const isValidVector = (vector) => {
      if (!Array.isArray(vector)) return false
      if (vector.length !== EMBEDDING_DIM) return false

      for (const val of vector) {
        if (typeof val !== 'number') return false
        if (Number.isNaN(val)) return false
        if (!Number.isFinite(val)) return false
      }

      return true
    }

    it('should reject vectors containing NaN', () => {
      const nanVector = new Array(EMBEDDING_DIM).fill(0)
      nanVector[100] = NaN

      expect(isValidVector(nanVector)).toBe(false)
    })

    it('should reject vectors containing Infinity', () => {
      const infVector = new Array(EMBEDDING_DIM).fill(0)
      infVector[50] = Infinity

      expect(isValidVector(infVector)).toBe(false)
    })

    it('should reject vectors containing negative Infinity', () => {
      const negInfVector = new Array(EMBEDDING_DIM).fill(0)
      negInfVector[50] = -Infinity

      expect(isValidVector(negInfVector)).toBe(false)
    })

    it('should reject vectors with wrong dimensions', () => {
      const shortVector = new Array(100).fill(0.1)
      const longVector = new Array(500).fill(0.1)

      expect(isValidVector(shortVector)).toBe(false)
      expect(isValidVector(longVector)).toBe(false)
    })

    it('should accept valid normalized vectors', () => {
      const validVector = new Array(EMBEDDING_DIM).fill(1 / Math.sqrt(EMBEDDING_DIM))

      expect(isValidVector(validVector)).toBe(true)
    })

    it('should reject non-array inputs', () => {
      expect(isValidVector(null)).toBe(false)
      expect(isValidVector(undefined)).toBe(false)
      expect(isValidVector('vector')).toBe(false)
      expect(isValidVector({ length: EMBEDDING_DIM })).toBe(false)
    })

    it('should reject vectors with non-numeric values', () => {
      const mixedVector = new Array(EMBEDDING_DIM).fill(0)
      mixedVector[0] = 'string'

      expect(isValidVector(mixedVector)).toBe(false)
    })
  })

  describe('batch embedding with failures', () => {
    // Simulate embedder that fails on specific inputs
    const createFailingEmbedder = (failOnTexts = []) => {
      return async (texts) => {
        const results = []

        for (const text of texts) {
          if (failOnTexts.includes(text)) {
            results.push(null) // Failed embedding
          } else {
            // Return valid mock embedding
            results.push(new Array(EMBEDDING_DIM).fill(0.1))
          }
        }

        return results
      }
    }

    it('should continue batch after single item failure', async () => {
      const embedder = createFailingEmbedder(['bad text'])

      const texts = ['good text 1', 'bad text', 'good text 2']
      const embeddings = await embedder(texts)

      expect(embeddings[0]).not.toBeNull()
      expect(embeddings[1]).toBeNull()
      expect(embeddings[2]).not.toBeNull()
    })

    it('should filter out failed embeddings', async () => {
      const embedder = createFailingEmbedder(['bad1', 'bad2'])

      const texts = ['good1', 'bad1', 'good2', 'bad2', 'good3']
      const embeddings = await embedder(texts)

      const validEmbeddings = embeddings.filter(e => e !== null)
      expect(validEmbeddings).toHaveLength(3)
    })

    it('should track which items failed', async () => {
      const embedder = createFailingEmbedder(['fail1', 'fail2'])

      const items = [
        { id: 1, text: 'success1' },
        { id: 2, text: 'fail1' },
        { id: 3, text: 'success2' },
        { id: 4, text: 'fail2' }
      ]

      const embeddings = await embedder(items.map(i => i.text))

      const failedIds = []
      const successfulItems = []

      items.forEach((item, idx) => {
        if (embeddings[idx] === null) {
          failedIds.push(item.id)
        } else {
          successfulItems.push({ ...item, vector: embeddings[idx] })
        }
      })

      expect(failedIds).toEqual([2, 4])
      expect(successfulItems).toHaveLength(2)
    })

    it('should handle all items failing', async () => {
      const embedder = createFailingEmbedder(['text1', 'text2', 'text3'])

      const texts = ['text1', 'text2', 'text3']
      const embeddings = await embedder(texts)

      const validCount = embeddings.filter(e => e !== null).length
      expect(validCount).toBe(0)
    })
  })

  describe('embedding model errors', () => {
    it('should handle model load failure', async () => {
      const createModelLoader = (shouldFail) => {
        return async () => {
          if (shouldFail) {
            throw new Error('Failed to load model: out of memory')
          }
          return { embed: () => {} }
        }
      }

      const loadWithFallback = async () => {
        try {
          return await createModelLoader(true)()
        } catch (e) {
          return { error: e.message, fallback: true }
        }
      }

      const result = await loadWithFallback()
      expect(result.fallback).toBe(true)
      expect(result.error).toContain('out of memory')
    })

    it('should handle tokenization overflow', () => {
      const MAX_TOKENS = 512
      const CHARS_PER_TOKEN = 4 // Rough estimate

      const truncateForTokenLimit = (text) => {
        const maxChars = MAX_TOKENS * CHARS_PER_TOKEN
        if (text.length > maxChars) {
          return text.substring(0, maxChars)
        }
        return text
      }

      const longText = 'a'.repeat(10000)
      const truncated = truncateForTokenLimit(longText)

      expect(truncated.length).toBe(MAX_TOKENS * CHARS_PER_TOKEN)
    })
  })

  describe('vector normalization issues', () => {
    it('should handle zero vector (all zeros)', () => {
      const normalizeVector = (vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))

        if (magnitude === 0) {
          // Return uniform distribution instead of dividing by zero
          const uniformVal = 1 / Math.sqrt(vector.length)
          return vector.map(() => uniformVal)
        }

        return vector.map(val => val / magnitude)
      }

      const zeroVector = new Array(EMBEDDING_DIM).fill(0)
      const normalized = normalizeVector(zeroVector)

      // Should not have NaN values
      expect(normalized.every(v => !Number.isNaN(v))).toBe(true)

      // Should have unit magnitude
      const magnitude = Math.sqrt(normalized.reduce((sum, val) => sum + val * val, 0))
      expect(Math.abs(magnitude - 1)).toBeLessThan(0.001)
    })

    it('should handle near-zero magnitude vector', () => {
      const normalizeVector = (vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))

        const EPSILON = 1e-10
        if (magnitude < EPSILON) {
          const uniformVal = 1 / Math.sqrt(vector.length)
          return vector.map(() => uniformVal)
        }

        return vector.map(val => val / magnitude)
      }

      const tinyVector = new Array(EMBEDDING_DIM).fill(1e-20)
      const normalized = normalizeVector(tinyVector)

      // Should not have NaN or Infinity
      expect(normalized.every(v => Number.isFinite(v))).toBe(true)
    })

    it('should preserve direction during normalization', () => {
      const normalizeVector = (vector) => {
        const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0))
        return vector.map(val => val / magnitude)
      }

      const original = [1, 2, 3, ...new Array(EMBEDDING_DIM - 3).fill(0)]
      const normalized = normalizeVector(original)

      // First 3 values should have same relative ratios
      const ratio12 = original[0] / original[1]
      const normalizedRatio12 = normalized[0] / normalized[1]
      expect(Math.abs(ratio12 - normalizedRatio12)).toBeLessThan(0.0001)
    })
  })

  describe('partial batch recovery', () => {
    it('should save successful embeddings before failure', async () => {
      const BATCH_SIZE = 32
      let savedItems = []

      const processWithPartialSave = async (items, embedder) => {
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE)
          const embeddings = await embedder(batch.map(item => item.text))

          // Save successful items immediately
          batch.forEach((item, idx) => {
            if (embeddings[idx] !== null) {
              savedItems.push({ ...item, vector: embeddings[idx] })
            }
          })
        }

        return savedItems.length
      }

      // Embedder that fails on items 40-60
      const partialFailEmbedder = async (texts) => {
        return texts.map((_, idx) => {
          // Simulate failure for certain range in second batch
          if (idx >= 8 && idx < 24) return null
          return new Array(EMBEDDING_DIM).fill(0.1)
        })
      }

      const items = Array.from({ length: 64 }, (_, i) => ({
        id: i,
        text: `Item ${i}`
      }))

      savedItems = []
      const savedCount = await processWithPartialSave(items, partialFailEmbedder)

      // First batch (32 items): 32 - 16 failures = 16 success (indices 8-23 fail)
      // Actually let me recalculate: batch 0 is items 0-31, batch 1 is items 32-63
      // Within each batch, indices 8-23 fail, so 16 fail per batch
      // 64 items total, 32 fail (16 per batch), 32 succeed
      expect(savedCount).toBe(32)
    })

    it('should report failed items for retry', async () => {
      const failedItems = []

      const processWithRetryTracking = async (items, embedder) => {
        const embeddings = await embedder(items.map(i => i.text))

        const successful = []
        items.forEach((item, idx) => {
          if (embeddings[idx] === null) {
            failedItems.push(item)
          } else {
            successful.push(item)
          }
        })

        return { successful, failed: failedItems }
      }

      const selectiveFailEmbedder = async (texts) => {
        return texts.map(text => {
          if (text.includes('special')) return null
          return new Array(EMBEDDING_DIM).fill(0.1)
        })
      }

      const items = [
        { id: 1, text: 'normal text' },
        { id: 2, text: 'special character ™' },
        { id: 3, text: 'another normal' },
        { id: 4, text: 'more special stuff' }
      ]

      const result = await processWithRetryTracking(items, selectiveFailEmbedder)

      expect(result.successful).toHaveLength(2)
      expect(result.failed).toHaveLength(2)
      expect(result.failed.map(i => i.id)).toEqual([2, 4])
    })
  })
})
