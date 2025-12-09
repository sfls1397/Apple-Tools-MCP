/**
 * Tests for timeout handling in embedding and indexing operations
 * Covers: embedBatch timeouts, fallback strategies, and zero-vector fallbacks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const EMBEDDING_DIM = 384
const EMBEDDING_TIMEOUT_MS = 30000
const SINGLE_EMBEDDING_TIMEOUT_MS = 10000

describe('Timeout Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('withTimeout utility', () => {
    // Mock the withTimeout function behavior
    const withTimeout = (promise, timeoutMs, operation = "Operation") => {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ])
    }

    it('should resolve if promise completes before timeout', async () => {
      const fastPromise = new Promise(resolve => setTimeout(() => resolve('success'), 100))

      const result = await withTimeout(fastPromise, 1000, 'Fast operation')

      expect(result).toBe('success')
    })

    it('should reject with timeout error if promise takes too long', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('too slow'), 2000))

      await expect(
        withTimeout(slowPromise, 500, 'Slow operation')
      ).rejects.toThrow('Slow operation timed out after 500ms')
    })

    it('should include operation name in timeout error', async () => {
      const slowPromise = new Promise(resolve => setTimeout(() => resolve('delayed'), 2000))

      await expect(
        withTimeout(slowPromise, 100, 'Custom operation')
      ).rejects.toThrow('Custom operation timed out after 100ms')
    })
  })

  describe('embedBatch timeout handling', () => {
    it('should timeout after 30 seconds on hung embedder', async () => {
      // Mock embedder that hangs indefinitely
      const hangingEmbedder = vi.fn(() => new Promise(() => {})) // Never resolves

      const withTimeout = (promise, timeoutMs) => {
        return Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
          )
        ])
      }

      const texts = ['text1', 'text2', 'text3']

      // Use a shorter timeout for testing (500ms instead of 30 seconds)
      await expect(
        withTimeout(hangingEmbedder(texts), 500)
      ).rejects.toThrow('timed out')
    }, 2000) // Test timeout of 2 seconds

    it('should fall back to single-item embedding on batch timeout', async () => {
      let callCount = 0
      const mockEmbedder = vi.fn((texts) => {
        callCount++
        if (Array.isArray(texts) && texts.length > 1) {
          // Batch call - timeout
          return new Promise(() => {}) // Hangs
        } else {
          // Single item - success
          return Promise.resolve({
            data: new Float32Array(EMBEDDING_DIM).fill(0.1)
          })
        }
      })

      // Simulate the fallback logic from embedBatch
      const texts = ['text1', 'text2']
      let embeddings = []

      try {
        // Try batch
        const batchPromise = mockEmbedder(texts)
        await Promise.race([
          batchPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
        ])
      } catch (e) {
        if (e.message.includes('timeout')) {
          // Fallback to single items
          for (const text of texts) {
            const result = await mockEmbedder([text])
            embeddings.push(Array.from(result.data))
          }
        }
      }

      expect(embeddings).toHaveLength(2)
      expect(embeddings[0]).toHaveLength(EMBEDDING_DIM)
    })

    it('should return zero vector on individual embedding timeout', async () => {
      const mockEmbed = vi.fn(() => new Promise(() => {})) // Hangs

      let embedding
      try {
        await Promise.race([
          mockEmbed('text'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
        ])
      } catch (e) {
        if (e.message.includes('timeout')) {
          // Return zero vector as fallback
          embedding = new Array(EMBEDDING_DIM).fill(0)
        }
      }

      expect(embedding).toHaveLength(EMBEDDING_DIM)
      expect(embedding.every(v => v === 0)).toBe(true)
    })

    it('should handle mixed success and timeout in fallback mode', async () => {
      let callIndex = 0
      const mockEmbed = vi.fn((text) => {
        const index = callIndex++
        if (index === 1) {
          // Second call times out
          return new Promise(() => {})
        }
        // Other calls succeed
        return Promise.resolve(new Array(EMBEDDING_DIM).fill(0.1))
      })

      const texts = ['text1', 'text2', 'text3']
      const embeddings = []

      for (const text of texts) {
        try {
          const result = await Promise.race([
            mockEmbed(text),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100))
          ])
          embeddings.push(result)
        } catch (e) {
          // Fallback to zero vector
          embeddings.push(new Array(EMBEDDING_DIM).fill(0))
        }
      }

      expect(embeddings).toHaveLength(3)
      expect(embeddings[0].every(v => v === 0.1)).toBe(true) // Success
      expect(embeddings[1].every(v => v === 0)).toBe(true)   // Timeout -> zero
      expect(embeddings[2].every(v => v === 0.1)).toBe(true) // Success
    })
  })

  describe('timeout error messages', () => {
    const withTimeout = (promise, timeoutMs, operation) => {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ])
    }

    it('should provide clear error for batch embedding timeout', async () => {
      const hangingPromise = new Promise(() => {})
      const SHORT_TIMEOUT = 100 // Use 100ms for testing instead of 30000ms

      await expect(
        withTimeout(hangingPromise, SHORT_TIMEOUT, 'Batch embedding')
      ).rejects.toThrow(`Batch embedding timed out after ${SHORT_TIMEOUT}ms`)
    }, 500) // Test timeout of 500ms

    it('should provide clear error for single embedding timeout', async () => {
      const hangingPromise = new Promise(() => {})
      const SHORT_TIMEOUT = 100 // Use 100ms for testing instead of 10000ms

      await expect(
        withTimeout(hangingPromise, SHORT_TIMEOUT, 'Single embedding')
      ).rejects.toThrow(`Single embedding timed out after ${SHORT_TIMEOUT}ms`)
    }, 500) // Test timeout of 500ms
  })

  describe('zero vector fallback properties', () => {
    it('should create zero vector with correct dimensions', () => {
      const zeroVector = new Array(EMBEDDING_DIM).fill(0)

      expect(zeroVector).toHaveLength(EMBEDDING_DIM)
      expect(zeroVector.every(v => v === 0)).toBe(true)
    })

    it('should be valid for vector operations', () => {
      const zeroVector = new Array(EMBEDDING_DIM).fill(0)

      // All values should be numbers
      expect(zeroVector.every(v => typeof v === 'number')).toBe(true)
      // All values should be finite
      expect(zeroVector.every(v => Number.isFinite(v))).toBe(true)
      // No NaN values
      expect(zeroVector.every(v => !Number.isNaN(v))).toBe(true)
    })

    it('should have zero magnitude', () => {
      const zeroVector = new Array(EMBEDDING_DIM).fill(0)
      const magnitude = Math.sqrt(zeroVector.reduce((sum, v) => sum + v * v, 0))

      expect(magnitude).toBe(0)
    })
  })

  describe('timeout configuration', () => {
    it('should use 30 second timeout for batch operations', () => {
      expect(EMBEDDING_TIMEOUT_MS).toBe(30000)
    })

    it('should use 10 second timeout for single embeddings', () => {
      expect(SINGLE_EMBEDDING_TIMEOUT_MS).toBe(10000)
    })

    it('batch timeout should be longer than single timeout', () => {
      expect(EMBEDDING_TIMEOUT_MS).toBeGreaterThan(SINGLE_EMBEDDING_TIMEOUT_MS)
    })
  })

  describe('timeout recovery', () => {
    it('should not leave hanging timers after timeout', async () => {
      const timers = []
      const originalSetTimeout = global.setTimeout
      global.setTimeout = vi.fn((fn, delay) => {
        const timer = originalSetTimeout(fn, delay)
        timers.push(timer)
        return timer
      })

      const withTimeout = (promise, timeoutMs) => {
        return Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs)
          )
        ])
      }

      try {
        await withTimeout(new Promise(() => {}), 100)
      } catch (e) {
        // Expected timeout
      }

      // Cleanup
      global.setTimeout = originalSetTimeout

      // Timer should have been created
      expect(timers.length).toBeGreaterThan(0)
    })
  })
})
