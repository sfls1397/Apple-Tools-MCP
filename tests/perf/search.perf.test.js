/**
 * Performance tests for search operations
 * Tests: vector search, hybrid scoring, query expansion, RRF merging
 *
 * Run with real data: USE_REAL_DATA=1 npm run perf
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  calculateThroughput
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateSearchQueries,
  generateMockEmbeddings
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'
import {
  isRealDataAvailable,
  getRealEmails,
  getRealMessages,
  getRealCalendarEvents,
  realEmbed,
  realEmbedBatch,
  realVectorSearch,
  getTableStats,
  cleanup as cleanupRealData
} from './helpers/real-data.js'

// Check if we should use real data
const USE_REAL_DATA = process.env.USE_REAL_DATA === '1' || process.env.USE_REAL_DATA === 'true'
const REAL_DATA_AVAILABLE = isRealDataAvailable()
const useRealData = USE_REAL_DATA && REAL_DATA_AVAILABLE

describe('Search Performance', () => {
  let mocks
  let reporter
  let histogram
  let realEmails = []
  let realMessages = []
  let realEvents = []
  let tableStats = {}

  beforeAll(async () => {
    if (useRealData) {
      console.log('\n=== USING REAL DATA ===')
      tableStats = await getTableStats()
      console.log(`Index stats: ${tableStats.emails} emails, ${tableStats.messages} messages, ${tableStats.calendar} events`)

      // Pre-load real data
      realEmails = await getRealEmails(1000)
      realMessages = await getRealMessages(500)
      realEvents = await getRealCalendarEvents(200)
      console.log(`Loaded: ${realEmails.length} emails, ${realMessages.length} messages, ${realEvents.length} events\n`)
    } else {
      if (USE_REAL_DATA && !REAL_DATA_AVAILABLE) {
        console.log('\n=== REAL DATA REQUESTED BUT NOT AVAILABLE ===')
        console.log('Run the MCP server first to build the index')
      }
      console.log('\n=== USING MOCK DATA ===\n')
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Search Performance')
    histogram = new LatencyHistogram(5) // 5ms buckets
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    reporter.report()
    if (useRealData) {
      await cleanupRealData()
    }
  })

  describe('Vector Search', () => {
    it('should perform vector search efficiently', async () => {
      if (useRealData) {
        // Real vector search against LanceDB
        const result = await benchmark(
          async () => {
            await realVectorSearch('emails', 'meeting about budget', 20)
          },
          { name: 'Real vector search (emails)', iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.p95).toBeLessThan(500) // Allow more time for real search
      } else {
        // Mock search
        const records = generateEmails(10000).map((e, i) => ({
          ...e,
          vector: generateMockEmbeddings(1, 384)[0]
        }))

        const mockTable = {
          search: vi.fn().mockImplementation(() => ({
            limit: (n) => ({
              toArray: vi.fn().mockResolvedValue(
                records.slice(0, n).map((r, i) => ({
                  ...r,
                  _distance: 0.1 + i * 0.01
                }))
              )
            })
          }))
        }

        const result = await benchmark(
          async () => {
            const queryVector = generateMockEmbeddings(1, 384)[0]
            await mockTable.search(queryVector).limit(20).toArray()
          },
          { name: 'Mock vector search 10k records', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.p95).toBeLessThan(50)
      }
    })

    it('should handle concurrent searches efficiently', async () => {
      const concurrency = 5

      if (useRealData) {
        const result = await benchmark(
          async () => {
            await Promise.all(
              Array(concurrency).fill(null).map(() =>
                realVectorSearch('emails', 'project update', 10)
              )
            )
          },
          { name: `${concurrency} concurrent real searches`, iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(2000) // Allow time for real searches
      } else {
        const searchFn = async () => {
          await mocks.embedder.embedder(['test query'])
          await new Promise(r => setTimeout(r, 5))
        }

        const result = await benchmark(
          async () => {
            await Promise.all(
              Array(concurrency).fill(null).map(() => searchFn())
            )
          },
          { name: `${concurrency} concurrent mock searches`, iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(200)
      }
    })

    it('should scale with result limit', async () => {
      const limits = [10, 50, 100, 200]
      const results = []

      for (const limit of limits) {
        if (useRealData) {
          const result = await benchmark(
            async () => {
              await realVectorSearch('emails', 'important', limit)
            },
            { name: `Real search limit=${limit}`, iterations: 5, warmup: 1 }
          )
          results.push(result)
          reporter.addResult(result)
        } else {
          const result = await benchmark(
            async () => {
              const mockResults = generateEmails(limit)
              await new Promise(r => setTimeout(r, 2 + limit * 0.05))
              return mockResults
            },
            { name: `Mock search limit=${limit}`, iterations: 10, warmup: 2 }
          )
          results.push(result)
          reporter.addResult(result)
        }
      }

      // Higher limits should take proportionally longer
      expect(results[3].mean).toBeLessThan(results[0].mean * 20)
    })
  })

  describe('Embedding Performance', () => {
    it('should generate embeddings efficiently', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realEmbed('quarterly budget meeting discussion')
          },
          { name: 'Real single embedding', iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(200)
      } else {
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder(['quarterly budget meeting discussion'])
          },
          { name: 'Mock single embedding', iterations: 50, warmup: 10 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      }
    })

    it('should batch embed efficiently', async () => {
      const texts = [
        'meeting about Q4 budget',
        'project deadline tomorrow',
        'lunch with team',
        'call with client',
        'weekly sync'
      ]

      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realEmbedBatch(texts)
          },
          { name: 'Real batch embedding (5 texts)', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(500)
      } else {
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder(texts)
          },
          { name: 'Mock batch embedding (5 texts)', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      }
    })
  })

  describe('Query Expansion', () => {
    it('should expand queries quickly', async () => {
      const queries = generateSearchQueries(50, { complexity: 'complex' })

      const expandQuery = (query) => {
        const variants = [
          query,
          query.split(' ').slice(0, 3).join(' '),
          query.replace(/meeting/g, 'discussion')
        ]
        return variants
      }

      const result = await benchmark(
        async () => {
          for (const query of queries) {
            expandQuery(query)
          }
        },
        { name: 'Expand 50 queries', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should handle multi-query search efficiently', async () => {
      const originalQuery = 'meeting about Q4 budget review'
      const expandedQueries = [
        originalQuery,
        'Q4 budget meeting',
        'budget discussion quarterly'
      ]

      if (useRealData) {
        const result = await benchmark(
          async () => {
            // Real multi-query search
            await Promise.all(expandedQueries.map(q =>
              realVectorSearch('emails', q, 10)
            ))
          },
          { name: 'Real multi-query search (3 variants)', iterations: 3, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(1500)
      } else {
        const result = await benchmark(
          async () => {
            const embeddings = []
            for (const q of expandedQueries) {
              await mocks.embedder.embedder([q])
              embeddings.push(q)
            }
            await Promise.all(embeddings.map(async () => {
              await new Promise(r => setTimeout(r, 10))
            }))
          },
          { name: 'Mock multi-query search (3 variants)', iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(100)
      }
    })
  })

  describe('Hybrid Scoring', () => {
    it('should apply hybrid scoring efficiently', async () => {
      const data = useRealData && realEmails.length > 0
        ? realEmails.slice(0, 100).map((e, i) => ({ ...e, _distance: Math.random() * 0.5 }))
        : generateEmails(100).map((e, i) => ({ ...e, _distance: Math.random() * 0.5 }))

      const applyHybridScoring = (results, query) => {
        const queryTerms = query.toLowerCase().split(' ')

        return results.map(r => {
          const vectorScore = 1 - r._distance
          const text = `${r.subject || ''} ${r.body || ''}`.toLowerCase()
          const keywordScore = queryTerms.reduce((score, term) => {
            return score + (text.includes(term) ? 1 : 0)
          }, 0) / queryTerms.length

          return {
            ...r,
            finalScore: vectorScore * 0.7 + keywordScore * 0.3
          }
        }).sort((a, b) => b.finalScore - a.finalScore)
      }

      const query = 'quarterly budget meeting review'

      const result = await benchmark(
        () => applyHybridScoring(data, query),
        { name: `Hybrid scoring 100 ${useRealData ? 'real' : 'mock'} results`, iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should scale linearly with result count', async () => {
      const sizes = [50, 100, 200, 500]
      const timings = []

      for (const size of sizes) {
        const data = useRealData && realEmails.length >= size
          ? realEmails.slice(0, size).map((e, i) => ({ ...e, _distance: Math.random() }))
          : generateEmails(size).map((e, i) => ({ ...e, _distance: Math.random() }))

        const result = await benchmark(
          () => {
            data.map(r => ({ ...r, score: 1 - r._distance }))
              .sort((a, b) => b.score - a.score)
          },
          { name: `Score ${size} results`, iterations: 20, warmup: 5 }
        )

        timings.push({ size, mean: result.mean })
      }

      const ratio = timings[3].mean / timings[0].mean
      expect(ratio).toBeLessThan(15)
    })
  })

  describe('Reciprocal Rank Fusion (RRF)', () => {
    it('should merge multiple result sets efficiently', async () => {
      const k = 60

      const getResultSets = () => {
        if (useRealData && realEmails.length >= 50) {
          return [
            realEmails.slice(0, 50),
            realEmails.slice(50, 100),
            realEmails.slice(100, 150)
          ].map(set => set.map((e, i) => ({ ...e, rank: i + 1 })))
        }
        return [
          generateEmails(50),
          generateEmails(50),
          generateEmails(50)
        ].map(set => set.map((e, i) => ({ ...e, rank: i + 1 })))
      }

      const resultSets = getResultSets()

      const rrfMerge = (sets, k) => {
        const scoreMap = new Map()

        for (const set of sets) {
          for (const item of set) {
            const score = 1 / (k + item.rank)
            const existing = scoreMap.get(item.id) || 0
            scoreMap.set(item.id, existing + score)
          }
        }

        return [...scoreMap.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([id, score]) => ({ id, score }))
      }

      const result = await benchmark(
        () => rrfMerge(resultSets, k),
        { name: 'RRF merge 3 x 50 results', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })
  })

  describe('End-to-End Search', () => {
    it('should complete full search pipeline', async () => {
      const query = 'important meeting about budget'

      if (useRealData) {
        const result = await benchmark(
          async () => {
            // 1. Query embedding
            const embedding = await realEmbed(query)

            // 2. Query expansion
            const variants = [query, 'budget meeting', 'important discussion']

            // 3. Parallel searches across sources
            const [emailResults, messageResults, calendarResults] = await Promise.all([
              realVectorSearch('emails', query, 10),
              realVectorSearch('messages', query, 10),
              realVectorSearch('calendar', query, 5)
            ])

            // 4. Merge and score
            const allResults = [...emailResults, ...messageResults, ...calendarResults]
            return allResults.sort((a, b) => (a._distance || 0) - (b._distance || 0))
          },
          { name: 'Real full search pipeline', iterations: 3, warmup: 1 }
        )

        reporter.addResult(result)
        expect(result.p95).toBeLessThan(2000) // Allow time for real operations
      } else {
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder([query])
            const variants = [query, 'budget meeting', 'important discussion']
            await Promise.all(variants.map(async () => {
              await new Promise(r => setTimeout(r, 10))
            }))
            const merged = variants.map((v, i) => ({ query: v, rank: i }))
            merged.map(m => ({ ...m, score: 1 / (60 + m.rank) }))
              .sort((a, b) => b.score - a.score)
          },
          { name: 'Mock full search pipeline', iterations: 20, warmup: 5 }
        )

        reporter.addResult(result)
        expect(result.p95).toBeLessThan(100)
      }
    })

    it('should maintain latency under load', async () => {
      const queries = generateSearchQueries(100)

      if (useRealData) {
        const result = await benchmark(
          async () => {
            for (const query of queries.slice(0, 5)) {
              const start = performance.now()
              await realVectorSearch('emails', query, 10)
              histogram.record(performance.now() - start)
            }
          },
          { name: 'Real search under load (5 queries)', iterations: 3, warmup: 1 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(3000)
      } else {
        const result = await benchmark(
          async () => {
            for (const query of queries.slice(0, 10)) {
              await mocks.embedder.embedder([query])
              await new Promise(r => setTimeout(r, 5))
              histogram.record(5 + Math.random() * 20)
            }
          },
          { name: 'Mock search under load (10 queries)', iterations: 10, warmup: 2 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(500)
      }
    })
  })

  describe('Search by Data Source', () => {
    it('should search emails efficiently', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realVectorSearch('emails', 'meeting tomorrow', 20)
          },
          { name: 'Real email search', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(500)
      } else {
        const emails = generateEmails(1000)
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder(['search query'])
            return emails.slice(0, 20)
          },
          { name: 'Mock email search', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      }
    })

    it('should search messages efficiently', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realVectorSearch('messages', 'dinner plans', 20)
          },
          { name: 'Real message search', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(500)
      } else {
        const messages = generateMessages(500)
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder(['search query'])
            return messages.slice(0, 20)
          },
          { name: 'Mock message search', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      }
    })

    it('should search calendar efficiently', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realVectorSearch('calendar', 'team sync', 20)
          },
          { name: 'Real calendar search', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(500)
      } else {
        const events = generateCalendarEvents(200)
        const result = await benchmark(
          async () => {
            await mocks.embedder.embedder(['search query'])
            return events.slice(0, 20)
          },
          { name: 'Mock calendar search', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      }
    })

    it('should search across all sources (smart_search)', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await Promise.all([
              realVectorSearch('emails', 'project update', 10),
              realVectorSearch('messages', 'project update', 10),
              realVectorSearch('calendar', 'project update', 5)
            ])
          },
          { name: 'Real cross-source smart search', iterations: 3, warmup: 1 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(1500)
      } else {
        const result = await benchmark(
          async () => {
            await Promise.all([
              mocks.embedder.embedder(['query']),
              mocks.embedder.embedder(['query']),
              mocks.embedder.embedder(['query'])
            ])
            await new Promise(r => setTimeout(r, 5))
          },
          { name: 'Mock cross-source smart search', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(100)
      }
    })
  })

  describe('Latency Distribution', () => {
    it('should have consistent latency distribution', async () => {
      if (useRealData) {
        for (let i = 0; i < 10; i++) {
          const start = performance.now()
          await realVectorSearch('emails', `test query ${i}`, 10)
          histogram.record(performance.now() - start)
        }

        console.log('\nReal Search Latency Distribution:')
        histogram.printHistogram()
        expect(histogram.getMean()).toBeLessThan(500)
      } else {
        for (let i = 0; i < 100; i++) {
          const start = performance.now()
          await mocks.embedder.embedder(['test query'])
          await new Promise(r => setTimeout(r, Math.random() * 20))
          histogram.record(performance.now() - start)
        }

        console.log('\nMock Search Latency Distribution:')
        histogram.printHistogram()
        expect(histogram.getMean()).toBeLessThan(30)
      }
    })
  })
})
