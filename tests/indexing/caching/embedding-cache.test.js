/**
 * Tests for embedding cache functionality
 * Tests cache hits, misses, invalidation, and persistence
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Standard indexer constants
const EMBEDDING_DIM = 384
const BATCH_SIZE = 32

/**
 * Create a deterministic embedder for testing
 */
function createTestEmbedder() {
  return async (texts, _options = {}) => {
    const data = new Float32Array(texts.length * EMBEDDING_DIM)
    for (let i = 0; i < texts.length; i++) {
      // Generate deterministic vector from text
      let hash = 0
      for (let j = 0; j < texts[i].length; j++) {
        hash = ((hash << 5) - hash) + texts[i].charCodeAt(j)
        hash = hash & hash
      }
      for (let j = 0; j < EMBEDDING_DIM; j++) {
        data[i * EMBEDDING_DIM + j] = Math.sin(hash + j) * 0.5 + 0.5
      }
    }
    return { data }
  }
}

describe('Embedding Cache', () => {
  let testEmbedder

  beforeEach(() => {
    vi.clearAllMocks()
    testEmbedder = createTestEmbedder()
  })

  describe('cache key generation', () => {
    const generateCacheKey = (text, options = {}) => {
      // Create a deterministic key from text and options
      const normalizedText = text.toLowerCase().trim()
      const optionsStr = JSON.stringify(options, Object.keys(options).sort())
      return `${normalizedText.length}:${hashString(normalizedText)}:${optionsStr}`
    }

    // Simple hash function for testing
    const hashString = (str) => {
      let hash = 0
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash // Convert to 32-bit integer
      }
      return hash.toString(16)
    }

    it('should generate consistent keys for same text', () => {
      const key1 = generateCacheKey('Hello World')
      const key2 = generateCacheKey('Hello World')

      expect(key1).toBe(key2)
    })

    it('should generate different keys for different text', () => {
      const key1 = generateCacheKey('Hello World')
      const key2 = generateCacheKey('Hello Universe')

      expect(key1).not.toBe(key2)
    })

    it('should normalize text before keying', () => {
      const key1 = generateCacheKey('  Hello World  ')
      const key2 = generateCacheKey('hello world')

      expect(key1).toBe(key2)
    })

    it('should include options in key', () => {
      const key1 = generateCacheKey('Hello', { model: 'a' })
      const key2 = generateCacheKey('Hello', { model: 'b' })

      expect(key1).not.toBe(key2)
    })
  })

  describe('in-memory cache', () => {
    it('should cache embeddings', async () => {
      const cache = new Map()
      let embedCallCount = 0

      const cachedEmbed = async (text) => {
        if (cache.has(text)) {
          return cache.get(text)
        }
        embedCallCount++
        const result = await testEmbedder([text], { pooling: 'mean', normalize: true })
        const vector = Array.from(result.data.slice(0, EMBEDDING_DIM))
        cache.set(text, vector)
        return vector
      }

      // First call - cache miss
      const result1 = await cachedEmbed('Test text')
      expect(embedCallCount).toBe(1)

      // Second call - cache hit
      const result2 = await cachedEmbed('Test text')
      expect(embedCallCount).toBe(1) // Should not increment

      expect(result1).toEqual(result2)
    })

    it('should respect cache size limit', async () => {
      const maxSize = 3
      const cache = new Map()

      const addToCache = (key, value) => {
        if (cache.size >= maxSize) {
          // Remove oldest entry (first key)
          const firstKey = cache.keys().next().value
          cache.delete(firstKey)
        }
        cache.set(key, value)
      }

      addToCache('key1', 'value1')
      addToCache('key2', 'value2')
      addToCache('key3', 'value3')
      expect(cache.size).toBe(3)

      // Add one more - should evict oldest
      addToCache('key4', 'value4')
      expect(cache.size).toBe(3)
      expect(cache.has('key1')).toBe(false)
      expect(cache.has('key4')).toBe(true)
    })

    it('should clear cache on demand', () => {
      const cache = new Map()
      cache.set('key1', 'value1')
      cache.set('key2', 'value2')

      expect(cache.size).toBe(2)
      cache.clear()
      expect(cache.size).toBe(0)
    })
  })

  describe('LRU cache behavior', () => {
    class LRUCache {
      constructor(maxSize) {
        this.maxSize = maxSize
        this.cache = new Map()
      }

      get(key) {
        if (!this.cache.has(key)) return undefined
        // Move to end (most recently used)
        const value = this.cache.get(key)
        this.cache.delete(key)
        this.cache.set(key, value)
        return value
      }

      set(key, value) {
        if (this.cache.has(key)) {
          this.cache.delete(key)
        } else if (this.cache.size >= this.maxSize) {
          // Remove least recently used (first key)
          const firstKey = this.cache.keys().next().value
          this.cache.delete(firstKey)
        }
        this.cache.set(key, value)
      }

      has(key) {
        return this.cache.has(key)
      }

      get size() {
        return this.cache.size
      }
    }

    it('should evict least recently used items', () => {
      const lru = new LRUCache(3)

      lru.set('a', 1)
      lru.set('b', 2)
      lru.set('c', 3)

      // Access 'a' to make it recently used
      lru.get('a')

      // Add new item - should evict 'b' (least recently used)
      lru.set('d', 4)

      expect(lru.has('a')).toBe(true)
      expect(lru.has('b')).toBe(false)
      expect(lru.has('c')).toBe(true)
      expect(lru.has('d')).toBe(true)
    })

    it('should update access order on get', () => {
      const lru = new LRUCache(2)

      lru.set('a', 1)
      lru.set('b', 2)

      // Access 'a'
      lru.get('a')

      // Add 'c' - should evict 'b'
      lru.set('c', 3)

      expect(lru.has('a')).toBe(true)
      expect(lru.has('b')).toBe(false)
      expect(lru.has('c')).toBe(true)
    })
  })

  describe('batch embedding with cache', () => {
    it('should batch only cache misses', async () => {
      const cache = new Map()
      let batchedTexts = []

      const batchEmbedWithCache = async (texts) => {
        const results = new Array(texts.length)
        const missIndices = []
        const missTexts = []

        // Check cache for each text
        for (let i = 0; i < texts.length; i++) {
          if (cache.has(texts[i])) {
            results[i] = cache.get(texts[i])
          } else {
            missIndices.push(i)
            missTexts.push(texts[i])
          }
        }

        // Embed only misses
        if (missTexts.length > 0) {
          batchedTexts = missTexts
          const embedResult = await testEmbedder(missTexts, { pooling: 'mean', normalize: true })

          // Store in cache and results
          for (let i = 0; i < missTexts.length; i++) {
            const vector = Array.from(embedResult.data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM))
            cache.set(missTexts[i], vector)
            results[missIndices[i]] = vector
          }
        }

        return results
      }

      // Pre-populate cache
      cache.set('text1', new Array(EMBEDDING_DIM).fill(0.1))
      cache.set('text2', new Array(EMBEDDING_DIM).fill(0.2))

      // Request mix of cached and uncached
      const texts = ['text1', 'text3', 'text2', 'text4']
      const results = await batchEmbedWithCache(texts)

      // Only text3 and text4 should be batched
      expect(batchedTexts).toEqual(['text3', 'text4'])
      expect(results).toHaveLength(4)
      expect(results[0]).toEqual(new Array(EMBEDDING_DIM).fill(0.1)) // From cache
      expect(results[2]).toEqual(new Array(EMBEDDING_DIM).fill(0.2)) // From cache
    })
  })

  describe('cache TTL', () => {
    it('should expire entries after TTL', async () => {
      const TTL_MS = 50
      const cache = new Map()

      const setWithTTL = (key, value) => {
        cache.set(key, {
          value,
          expires: Date.now() + TTL_MS
        })
      }

      const getWithTTL = (key) => {
        const entry = cache.get(key)
        if (!entry) return undefined
        if (Date.now() > entry.expires) {
          cache.delete(key)
          return undefined
        }
        return entry.value
      }

      // Set value
      setWithTTL('key1', [1, 2, 3])
      expect(getWithTTL('key1')).toEqual([1, 2, 3])

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 60))

      expect(getWithTTL('key1')).toBeUndefined()
    })

    it('should support sliding TTL on access', async () => {
      const TTL_MS = 100
      const cache = new Map()

      const setWithSlidingTTL = (key, value) => {
        cache.set(key, {
          value,
          expires: Date.now() + TTL_MS
        })
      }

      const getWithSlidingTTL = (key) => {
        const entry = cache.get(key)
        if (!entry) return undefined
        if (Date.now() > entry.expires) {
          cache.delete(key)
          return undefined
        }
        // Refresh TTL on access
        entry.expires = Date.now() + TTL_MS
        return entry.value
      }

      setWithSlidingTTL('key1', 'value1')

      // Access before expiration, refreshing TTL
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(getWithSlidingTTL('key1')).toBe('value1')

      // Wait another 50ms - should still be valid due to refresh
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(getWithSlidingTTL('key1')).toBe('value1')

      // Wait full TTL - should expire
      await new Promise(resolve => setTimeout(resolve, 110))
      expect(getWithSlidingTTL('key1')).toBeUndefined()
    })
  })

  describe('cache invalidation', () => {
    it('should invalidate specific entries', () => {
      const cache = new Map()
      cache.set('email:1', 'vector1')
      cache.set('email:2', 'vector2')
      cache.set('message:1', 'vector3')

      // Invalidate specific entry
      cache.delete('email:1')

      expect(cache.has('email:1')).toBe(false)
      expect(cache.has('email:2')).toBe(true)
    })

    it('should invalidate by prefix', () => {
      const cache = new Map()
      cache.set('email:1', 'vector1')
      cache.set('email:2', 'vector2')
      cache.set('message:1', 'vector3')

      const invalidateByPrefix = (prefix) => {
        for (const key of cache.keys()) {
          if (key.startsWith(prefix)) {
            cache.delete(key)
          }
        }
      }

      invalidateByPrefix('email:')

      expect(cache.has('email:1')).toBe(false)
      expect(cache.has('email:2')).toBe(false)
      expect(cache.has('message:1')).toBe(true)
    })

    it('should invalidate all on reindex', () => {
      const cache = new Map()
      cache.set('email:1', 'vector1')
      cache.set('email:2', 'vector2')
      cache.set('message:1', 'vector3')

      // Simulate reindex invalidation
      cache.clear()

      expect(cache.size).toBe(0)
    })
  })

  describe('cache persistence simulation', () => {
    it('should serialize cache to JSON', () => {
      const cache = new Map()
      cache.set('key1', [0.1, 0.2, 0.3])
      cache.set('key2', [0.4, 0.5, 0.6])

      const serialized = JSON.stringify(Array.from(cache.entries()))

      expect(serialized).toContain('key1')
      expect(serialized).toContain('key2')
    })

    it('should deserialize cache from JSON', () => {
      const serialized = '[["key1",[0.1,0.2,0.3]],["key2",[0.4,0.5,0.6]]]'
      const cache = new Map(JSON.parse(serialized))

      expect(cache.get('key1')).toEqual([0.1, 0.2, 0.3])
      expect(cache.get('key2')).toEqual([0.4, 0.5, 0.6])
    })

    it('should handle corrupted cache gracefully', () => {
      const loadCache = (serialized) => {
        try {
          const entries = JSON.parse(serialized)
          return new Map(entries)
        } catch {
          return new Map() // Return empty cache on error
        }
      }

      const corrupted = 'not valid json'
      const cache = loadCache(corrupted)

      expect(cache.size).toBe(0)
    })
  })

  describe('cache statistics', () => {
    it('should track hit rate', async () => {
      const stats = { hits: 0, misses: 0 }
      const cache = new Map()

      const getWithStats = (key) => {
        if (cache.has(key)) {
          stats.hits++
          return cache.get(key)
        }
        stats.misses++
        return undefined
      }

      // Simulate lookups
      cache.set('key1', 'value1')
      getWithStats('key1') // Hit
      getWithStats('key1') // Hit
      getWithStats('key2') // Miss
      getWithStats('key3') // Miss
      getWithStats('key1') // Hit

      expect(stats.hits).toBe(3)
      expect(stats.misses).toBe(2)

      const hitRate = stats.hits / (stats.hits + stats.misses)
      expect(hitRate).toBe(0.6)
    })

    it('should track cache size in bytes', () => {
      const estimateSize = (value) => {
        if (Array.isArray(value)) {
          return value.length * 4 // Float32 = 4 bytes
        }
        return JSON.stringify(value).length * 2 // Approximate string size
      }

      const cache = new Map()
      let totalBytes = 0

      const setWithSizeTracking = (key, value) => {
        const size = estimateSize(value)
        cache.set(key, { value, size })
        totalBytes += size
      }

      setWithSizeTracking('key1', new Array(384).fill(0.1))
      setWithSizeTracking('key2', new Array(384).fill(0.2))

      expect(totalBytes).toBe(384 * 4 * 2) // 2 vectors × 384 floats × 4 bytes
    })
  })

  describe('content-based deduplication', () => {
    const hashContent = (content) => {
      let hash = 0
      for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i)
        hash = ((hash << 5) - hash) + char
        hash = hash & hash
      }
      return hash.toString(16)
    }

    it('should detect duplicate content', () => {
      const seen = new Set()

      const isDuplicate = (content) => {
        const hash = hashContent(content)
        if (seen.has(hash)) return true
        seen.add(hash)
        return false
      }

      expect(isDuplicate('Hello World')).toBe(false)
      expect(isDuplicate('Different text')).toBe(false)
      expect(isDuplicate('Hello World')).toBe(true) // Duplicate
    })

    it('should skip embedding for duplicates', async () => {
      const contentHashes = new Map() // hash -> embedding
      let embedCount = 0

      const embedWithDedup = async (content) => {
        const hash = hashContent(content)
        if (contentHashes.has(hash)) {
          return contentHashes.get(hash)
        }
        embedCount++
        const result = await testEmbedder([content], { pooling: 'mean', normalize: true })
        const vector = Array.from(result.data.slice(0, EMBEDDING_DIM))
        contentHashes.set(hash, vector)
        return vector
      }

      await embedWithDedup('Same content')
      await embedWithDedup('Different content')
      await embedWithDedup('Same content') // Should be deduped

      expect(embedCount).toBe(2) // Only 2 unique contents
    })
  })

  describe('warm-up and preloading', () => {
    it('should preload frequently accessed embeddings', async () => {
      const cache = new Map()
      const frequentlyAccessed = ['common query 1', 'common query 2', 'common query 3']

      const preloadCache = async (texts) => {
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          const batch = texts.slice(i, i + BATCH_SIZE)
          const result = await testEmbedder(batch, { pooling: 'mean', normalize: true })

          for (let j = 0; j < batch.length; j++) {
            const vector = Array.from(result.data.slice(j * EMBEDDING_DIM, (j + 1) * EMBEDDING_DIM))
            cache.set(batch[j], vector)
          }
        }
      }

      await preloadCache(frequentlyAccessed)

      expect(cache.size).toBe(3)
      expect(cache.has('common query 1')).toBe(true)
      expect(cache.has('common query 2')).toBe(true)
      expect(cache.has('common query 3')).toBe(true)
    })
  })

  describe('memory-efficient vector storage', () => {
    it('should store as Float32Array for memory efficiency', () => {
      const vectorAsArray = [0.1, 0.2, 0.3, 0.4, 0.5]
      const vectorAsFloat32 = new Float32Array(vectorAsArray)

      // Float32Array uses less memory than regular array of numbers
      expect(vectorAsFloat32.BYTES_PER_ELEMENT).toBe(4)
      expect(vectorAsFloat32.byteLength).toBe(20) // 5 elements × 4 bytes
    })

    it('should handle Float32Array in cache', () => {
      const cache = new Map()

      const vector = new Float32Array([0.1, 0.2, 0.3])
      cache.set('key1', vector)

      const retrieved = cache.get('key1')
      expect(retrieved instanceof Float32Array).toBe(true)
      expect(Array.from(retrieved)).toEqual([
        expect.closeTo(0.1, 5),
        expect.closeTo(0.2, 5),
        expect.closeTo(0.3, 5)
      ])
    })
  })
})
