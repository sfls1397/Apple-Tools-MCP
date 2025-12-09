/**
 * Tests for search result caching
 * Tests query result caching, cache invalidation on updates, and cache warming
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Result Cache', () => {
  describe('query result caching', () => {
    const createResultCache = (maxSize = 100, ttlMs = 60000) => {
      const cache = new Map()

      const generateKey = (query, options) => {
        return JSON.stringify({ query: query.toLowerCase().trim(), options })
      }

      return {
        get: (query, options = {}) => {
          const key = generateKey(query, options)
          const entry = cache.get(key)
          if (!entry) return null
          if (Date.now() > entry.expires) {
            cache.delete(key)
            return null
          }
          return entry.results
        },

        set: (query, options, results) => {
          const key = generateKey(query, options)
          if (cache.size >= maxSize) {
            // Remove oldest entry
            const oldestKey = cache.keys().next().value
            cache.delete(oldestKey)
          }
          cache.set(key, {
            results,
            expires: Date.now() + ttlMs,
            timestamp: Date.now()
          })
        },

        invalidate: (query, options) => {
          const key = generateKey(query, options)
          cache.delete(key)
        },

        clear: () => cache.clear(),

        size: () => cache.size
      }
    }

    it('should cache search results', () => {
      const cache = createResultCache()
      const mockResults = [{ id: '1', title: 'Test' }]

      cache.set('test query', {}, mockResults)

      const cached = cache.get('test query', {})
      expect(cached).toEqual(mockResults)
    })

    it('should normalize query for caching', () => {
      const cache = createResultCache()
      const mockResults = [{ id: '1' }]

      cache.set('  TEST Query  ', {}, mockResults)

      // Should match with different casing/whitespace
      expect(cache.get('test query', {})).toEqual(mockResults)
      expect(cache.get('TEST QUERY', {})).toEqual(mockResults)
    })

    it('should include options in cache key', () => {
      const cache = createResultCache()

      cache.set('query', { limit: 10 }, [{ id: '1' }])
      cache.set('query', { limit: 20 }, [{ id: '2' }])

      expect(cache.get('query', { limit: 10 })[0].id).toBe('1')
      expect(cache.get('query', { limit: 20 })[0].id).toBe('2')
    })

    it('should expire entries after TTL', async () => {
      const cache = createResultCache(100, 50) // 50ms TTL

      cache.set('query', {}, [{ id: '1' }])
      expect(cache.get('query', {})).not.toBeNull()

      await new Promise(resolve => setTimeout(resolve, 60))

      expect(cache.get('query', {})).toBeNull()
    })

    it('should respect max size', () => {
      const cache = createResultCache(3)

      cache.set('q1', {}, [{ id: '1' }])
      cache.set('q2', {}, [{ id: '2' }])
      cache.set('q3', {}, [{ id: '3' }])
      expect(cache.size()).toBe(3)

      cache.set('q4', {}, [{ id: '4' }])
      expect(cache.size()).toBe(3)
    })

    it('should invalidate specific entries', () => {
      const cache = createResultCache()

      cache.set('query1', {}, [{ id: '1' }])
      cache.set('query2', {}, [{ id: '2' }])

      cache.invalidate('query1', {})

      expect(cache.get('query1', {})).toBeNull()
      expect(cache.get('query2', {})).not.toBeNull()
    })

    it('should clear all entries', () => {
      const cache = createResultCache()

      cache.set('q1', {}, [])
      cache.set('q2', {}, [])
      cache.set('q3', {}, [])

      cache.clear()
      expect(cache.size()).toBe(0)
    })
  })

  describe('cache invalidation on data changes', () => {
    const createCacheWithInvalidation = () => {
      const cache = new Map()
      const sourceToQueries = new Map() // Track which queries touched which sources

      return {
        get: (query) => cache.get(query)?.results || null,

        set: (query, results, sources) => {
          cache.set(query, { results, sources })
          // Track source -> query mapping
          for (const source of sources) {
            if (!sourceToQueries.has(source)) {
              sourceToQueries.set(source, new Set())
            }
            sourceToQueries.get(source).add(query)
          }
        },

        invalidateSource: (source) => {
          const queries = sourceToQueries.get(source) || new Set()
          for (const query of queries) {
            cache.delete(query)
          }
          sourceToQueries.delete(source)
        },

        size: () => cache.size
      }
    }

    it('should invalidate queries when source changes', () => {
      const cache = createCacheWithInvalidation()

      cache.set('email query', [{ id: '1' }], ['emails'])
      cache.set('message query', [{ id: '2' }], ['messages'])
      cache.set('cross query', [{ id: '3' }], ['emails', 'messages'])

      // Invalidate emails source
      cache.invalidateSource('emails')

      expect(cache.get('email query')).toBeNull()
      expect(cache.get('cross query')).toBeNull() // Also invalidated
      expect(cache.get('message query')).not.toBeNull()
    })

    it('should track multiple sources per query', () => {
      const cache = createCacheWithInvalidation()

      cache.set('smart search', [{ id: '1' }], ['emails', 'messages', 'calendar'])

      // Invalidating any source should clear the query
      cache.invalidateSource('calendar')
      expect(cache.get('smart search')).toBeNull()
    })
  })

  describe('paginated result caching', () => {
    const createPaginatedCache = () => {
      const cache = new Map()

      const getKey = (query, page, pageSize) => {
        return `${query.toLowerCase()}:${page}:${pageSize}`
      }

      return {
        get: (query, page, pageSize) => {
          return cache.get(getKey(query, page, pageSize)) || null
        },

        set: (query, page, pageSize, results, totalCount) => {
          cache.set(getKey(query, page, pageSize), {
            results,
            totalCount,
            page,
            pageSize
          })
        },

        invalidateQuery: (query) => {
          const prefix = query.toLowerCase() + ':'
          for (const key of cache.keys()) {
            if (key.startsWith(prefix)) {
              cache.delete(key)
            }
          }
        }
      }
    }

    it('should cache individual pages', () => {
      const cache = createPaginatedCache()

      cache.set('query', 1, 10, [{ id: '1' }], 100)
      cache.set('query', 2, 10, [{ id: '2' }], 100)

      const page1 = cache.get('query', 1, 10)
      const page2 = cache.get('query', 2, 10)

      expect(page1.results[0].id).toBe('1')
      expect(page2.results[0].id).toBe('2')
      expect(page1.totalCount).toBe(100)
    })

    it('should differentiate by page size', () => {
      const cache = createPaginatedCache()

      cache.set('query', 1, 10, [{ id: '10-item' }], 100)
      cache.set('query', 1, 20, [{ id: '20-item' }], 100)

      expect(cache.get('query', 1, 10).results[0].id).toBe('10-item')
      expect(cache.get('query', 1, 20).results[0].id).toBe('20-item')
    })

    it('should invalidate all pages for a query', () => {
      const cache = createPaginatedCache()

      cache.set('query', 1, 10, [], 100)
      cache.set('query', 2, 10, [], 100)
      cache.set('query', 3, 10, [], 100)

      cache.invalidateQuery('query')

      expect(cache.get('query', 1, 10)).toBeNull()
      expect(cache.get('query', 2, 10)).toBeNull()
      expect(cache.get('query', 3, 10)).toBeNull()
    })
  })

  describe('stale-while-revalidate', () => {
    const createSWRCache = (staleTTL, maxTTL) => {
      const cache = new Map()

      return {
        get: (key) => {
          const entry = cache.get(key)
          if (!entry) return { data: null, stale: false, expired: true }

          const now = Date.now()
          const isStale = now > entry.staleAt
          const isExpired = now > entry.expiresAt

          if (isExpired) {
            cache.delete(key)
            return { data: null, stale: false, expired: true }
          }

          return { data: entry.data, stale: isStale, expired: false }
        },

        set: (key, data) => {
          cache.set(key, {
            data,
            staleAt: Date.now() + staleTTL,
            expiresAt: Date.now() + maxTTL
          })
        }
      }
    }

    it('should return fresh data before stale time', () => {
      const cache = createSWRCache(100, 200)

      cache.set('key', { value: 1 })
      const result = cache.get('key')

      expect(result.data).toEqual({ value: 1 })
      expect(result.stale).toBe(false)
      expect(result.expired).toBe(false)
    })

    it('should mark data as stale after stale TTL', async () => {
      const cache = createSWRCache(50, 200) // Stale at 50ms, expires at 200ms

      cache.set('key', { value: 1 })

      await new Promise(resolve => setTimeout(resolve, 60))

      const result = cache.get('key')
      expect(result.data).toEqual({ value: 1 }) // Data still returned
      expect(result.stale).toBe(true) // But marked stale
      expect(result.expired).toBe(false)
    })

    it('should expire data after max TTL', async () => {
      const cache = createSWRCache(50, 100)

      cache.set('key', { value: 1 })

      await new Promise(resolve => setTimeout(resolve, 110))

      const result = cache.get('key')
      expect(result.data).toBeNull()
      expect(result.expired).toBe(true)
    })
  })

  describe('cache warming', () => {
    it('should warm cache with common queries', async () => {
      const cache = new Map()
      const commonQueries = ['inbox', 'sent', 'important', 'meeting']

      const warmCache = async (queries, searchFn) => {
        for (const query of queries) {
          const results = await searchFn(query)
          cache.set(query, results)
        }
      }

      const mockSearch = vi.fn().mockImplementation((query) => {
        return Promise.resolve([{ id: query, type: 'result' }])
      })

      await warmCache(commonQueries, mockSearch)

      expect(cache.size).toBe(4)
      expect(mockSearch).toHaveBeenCalledTimes(4)
      expect(cache.get('inbox')).toEqual([{ id: 'inbox', type: 'result' }])
    })

    it('should prioritize queries by frequency', () => {
      const queryFrequency = new Map()

      const recordQuery = (query) => {
        const count = queryFrequency.get(query) || 0
        queryFrequency.set(query, count + 1)
      }

      const getTopQueries = (n) => {
        return Array.from(queryFrequency.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, n)
          .map(([query]) => query)
      }

      // Simulate query history
      recordQuery('inbox')
      recordQuery('inbox')
      recordQuery('inbox')
      recordQuery('meeting')
      recordQuery('meeting')
      recordQuery('review')

      const topQueries = getTopQueries(2)
      expect(topQueries).toEqual(['inbox', 'meeting'])
    })
  })

  describe('conditional caching', () => {
    const shouldCache = (query, results, options) => {
      // Don't cache empty results
      if (!results || results.length === 0) return false

      // Don't cache very short queries
      if (query.length < 3) return false

      // Don't cache if explicitly disabled
      if (options.noCache) return false

      // Don't cache time-sensitive queries
      if (query.includes('today') || query.includes('now')) return false

      return true
    }

    it('should not cache empty results', () => {
      expect(shouldCache('test', [], {})).toBe(false)
      expect(shouldCache('test', null, {})).toBe(false)
    })

    it('should not cache short queries', () => {
      expect(shouldCache('ab', [{ id: 1 }], {})).toBe(false)
      expect(shouldCache('abc', [{ id: 1 }], {})).toBe(true)
    })

    it('should not cache when disabled', () => {
      expect(shouldCache('test', [{ id: 1 }], { noCache: true })).toBe(false)
    })

    it('should not cache time-sensitive queries', () => {
      expect(shouldCache('emails from today', [{ id: 1 }], {})).toBe(false)
      expect(shouldCache('meetings now', [{ id: 1 }], {})).toBe(false)
      expect(shouldCache('emails from john', [{ id: 1 }], {})).toBe(true)
    })
  })

  describe('cache compression', () => {
    // Simulated compression using JSON with reduced structure
    const compressResults = (results) => {
      return results.map(r => ({
        i: r.id,
        t: r.title,
        s: r.score
      }))
    }

    const decompressResults = (compressed) => {
      return compressed.map(r => ({
        id: r.i,
        title: r.t,
        score: r.s
      }))
    }

    it('should compress results for storage', () => {
      const results = [
        { id: '123', title: 'Test Email', score: 0.95 },
        { id: '456', title: 'Another Email', score: 0.85 }
      ]

      const compressed = compressResults(results)

      expect(compressed[0].i).toBe('123')
      expect(compressed[0].t).toBe('Test Email')
      expect(JSON.stringify(compressed).length).toBeLessThan(JSON.stringify(results).length)
    })

    it('should decompress results on retrieval', () => {
      const compressed = [
        { i: '123', t: 'Test', s: 0.9 }
      ]

      const decompressed = decompressResults(compressed)

      expect(decompressed[0].id).toBe('123')
      expect(decompressed[0].title).toBe('Test')
      expect(decompressed[0].score).toBe(0.9)
    })
  })

  describe('cache metrics', () => {
    const createMetricsCache = () => {
      const cache = new Map()
      const metrics = {
        hits: 0,
        misses: 0,
        sets: 0,
        evictions: 0
      }

      return {
        get: (key) => {
          if (cache.has(key)) {
            metrics.hits++
            return cache.get(key)
          }
          metrics.misses++
          return null
        },

        set: (key, value, maxSize = 100) => {
          if (cache.size >= maxSize && !cache.has(key)) {
            cache.delete(cache.keys().next().value)
            metrics.evictions++
          }
          cache.set(key, value)
          metrics.sets++
        },

        getMetrics: () => ({
          ...metrics,
          size: cache.size,
          hitRate: metrics.hits / (metrics.hits + metrics.misses) || 0
        })
      }
    }

    it('should track cache metrics', () => {
      const cache = createMetricsCache()

      cache.set('key1', 'value1')
      cache.set('key2', 'value2')
      cache.get('key1') // Hit
      cache.get('key1') // Hit
      cache.get('key3') // Miss

      const metrics = cache.getMetrics()

      expect(metrics.sets).toBe(2)
      expect(metrics.hits).toBe(2)
      expect(metrics.misses).toBe(1)
      expect(metrics.hitRate).toBeCloseTo(0.667, 2)
    })

    it('should track evictions', () => {
      const cache = createMetricsCache()

      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, `value${i}`, 3) // Max size 3
      }

      const metrics = cache.getMetrics()
      expect(metrics.evictions).toBe(2) // 5 items, max 3 = 2 evictions
    })
  })

  describe('distributed cache simulation', () => {
    const createLocalCache = (sharedStorage) => {
      const localCache = new Map()

      return {
        get: (key) => {
          // Check local first
          if (localCache.has(key)) {
            return { source: 'local', data: localCache.get(key) }
          }
          // Fall back to shared
          if (sharedStorage.has(key)) {
            const data = sharedStorage.get(key)
            localCache.set(key, data) // Promote to local
            return { source: 'shared', data }
          }
          return { source: 'miss', data: null }
        },

        set: (key, value) => {
          localCache.set(key, value)
          sharedStorage.set(key, value)
        },

        localSize: () => localCache.size,
        sharedSize: () => sharedStorage.size
      }
    }

    it('should use local cache first', () => {
      const shared = new Map()
      const cache = createLocalCache(shared)

      cache.set('key1', 'value1')
      const result = cache.get('key1')

      expect(result.source).toBe('local')
      expect(result.data).toBe('value1')
    })

    it('should fall back to shared cache', () => {
      const shared = new Map()
      shared.set('key1', 'sharedValue')

      const cache = createLocalCache(shared)
      const result = cache.get('key1')

      expect(result.source).toBe('shared')
      expect(result.data).toBe('sharedValue')
    })

    it('should promote shared to local on access', () => {
      const shared = new Map()
      shared.set('key1', 'value1')

      const cache = createLocalCache(shared)
      expect(cache.localSize()).toBe(0)

      cache.get('key1') // Should promote

      expect(cache.localSize()).toBe(1)

      // Second access should be local
      const result = cache.get('key1')
      expect(result.source).toBe('local')
    })
  })
})
