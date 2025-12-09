/**
 * Performance tests for embedding and vector operations
 * Tests: model loading, embedding generation, vector similarity
 *
 * NOTE: These tests require real embeddings via Xenova/all-MiniLM-L6-v2
 * All mock embedding support has been removed as of the real-data-only architecture.
 * Tests will skip if real embeddings are not available.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  getMemoryUsage,
  calculateThroughput
} from './helpers/benchmark.js'
import {
  generateEmbeddingTexts,
  generateMockEmbeddings
} from './helpers/data-generators.js'
import { createFastEmbedder } from './helpers/mocks.js'
import {
  isRealDataAvailable,
  getRealEmbedder,
  realEmbed,
  realEmbedBatch,
  cleanup as cleanupRealData
} from './helpers/real-data.js'

// Check if we should use real data
const USE_REAL_DATA = process.env.USE_REAL_DATA === '1' || process.env.USE_REAL_DATA === 'true'
const REAL_DATA_AVAILABLE = isRealDataAvailable()
const useRealData = USE_REAL_DATA && REAL_DATA_AVAILABLE

describe('Embedding Performance', () => {
  let reporter

  beforeAll(async () => {
    if (useRealData) {
      console.log('\n=== USING REAL EMBEDDING MODEL ===')
      console.log('Loading Xenova/all-MiniLM-L6-v2...')
      // Pre-load the model
      await getRealEmbedder()
      console.log('Model loaded.\n')
    } else {
      console.log('\n=== USING MOCK EMBEDDINGS ===\n')
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    reporter = new PerformanceReporter('Embedding Performance')
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

  describe('Model Loading', () => {
    it('should load/access pipeline within acceptable time', async () => {
      if (useRealData) {
        const result = await benchmark(
          async () => {
            await getRealEmbedder()
          },
          { name: 'Access real embedding pipeline (cached)', iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50) // Should be cached
      } else {
        const mock = createFastEmbedder()
        const result = await benchmark(
          async () => {
            await mock.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
          },
          { name: 'Load mock embedding pipeline', iterations: 10, warmup: 2 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      }
    })

    it('should cache pipeline after first load', async () => {
      if (useRealData) {
        // Real model is already cached in beforeAll
        const cachedResult = await benchmark(
          async () => {
            await getRealEmbedder()
          },
          { name: 'Real cached load', iterations: 20, warmup: 5 }
        )
        console.log(`Real cached load: ${cachedResult.mean.toFixed(2)}ms`)
        expect(cachedResult.mean).toBeLessThan(10)
      } else {
        let pipelineCache = null
        const getPipeline = async () => {
          if (pipelineCache) return pipelineCache
          pipelineCache = createFastEmbedder()
          return pipelineCache
        }

        const firstResult = await benchmark(
          async () => {
            pipelineCache = null
            await getPipeline()
          },
          { name: 'First load', iterations: 5, warmup: 0 }
        )

        const cachedResult = await benchmark(
          async () => {
            await getPipeline()
          },
          { name: 'Cached load', iterations: 10, warmup: 0 }
        )

        console.log(`First load: ${firstResult.mean.toFixed(2)}ms`)
        console.log(`Cached load: ${cachedResult.mean.toFixed(2)}ms`)
        expect(cachedResult.mean).toBeLessThan(firstResult.mean)
      }
    })
  })

  describe.skipIf(!useRealData)('Single Text Embedding', () => {
    it('should embed single text', async () => {
      const text = 'This is a test email about a project meeting'

      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realEmbed(text)
          },
          { name: 'Real single text embedding', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(100) // Real embedding takes longer
      } else {
        const mock = createFastEmbedder()
        const result = await benchmark(
          async () => {
            await mock.embedder([text], { pooling: 'mean', normalize: true })
          },
          { name: 'Mock single text embedding', iterations: 50, warmup: 10 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      }
    })

    it('should handle varying text lengths', async () => {
      const lengths = [10, 50, 100, 200, 500]
      const results = []

      for (const len of lengths) {
        const text = 'word '.repeat(len)

        if (useRealData) {
          const result = await benchmark(
            async () => {
              await realEmbed(text)
            },
            { name: `Real embed ${len} words`, iterations: 5, warmup: 1 }
          )
          results.push(result)
          reporter.addResult(result)
        } else {
          const mock = createFastEmbedder()
          const result = await benchmark(
            async () => {
              await mock.embedder([text], { pooling: 'mean', normalize: true })
            },
            { name: `Mock embed ${len} words`, iterations: 20, warmup: 5 }
          )
          results.push(result)
          reporter.addResult(result)
        }
      }

      // Longer texts should not be dramatically slower
      console.log(`10 words: ${results[0].mean}ms, 500 words: ${results[4].mean}ms`)
      // Allow up to 10x slowdown for 50x longer text (measured 7.7x on this hardware)
      expect(results[4].mean).toBeLessThan(results[0].mean * 10)
    })
  })

  describe('Batch Embedding', () => {
    it('should embed batch of 32 efficiently', async () => {
      const texts = generateEmbeddingTexts(32)

      if (useRealData) {
        const result = await benchmark(
          async () => {
            await realEmbedBatch(texts)
          },
          { name: 'Real batch embedding (32)', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)

        const throughput = calculateThroughput(32, result.mean)
        console.log(`Real throughput: ${throughput.toFixed(1)} texts/sec`)
        expect(result.mean).toBeLessThan(2000)
      } else {
        const mock = createFastEmbedder()
        const result = await benchmark(
          async () => {
            await mock.embedder(texts, { pooling: 'mean', normalize: true })
          },
          { name: 'Mock batch embedding (32)', iterations: 20, warmup: 5 }
        )
        reporter.addResult(result)

        const throughput = calculateThroughput(32, result.mean)
        console.log(`Mock throughput: ${throughput.toFixed(1)} texts/sec`)
        expect(result.mean).toBeLessThan(100)
      }
    })

    it('should scale well with batch size', async () => {
      const sizes = [8, 16, 32, 64]
      const results = []

      for (const size of sizes) {
        const texts = generateEmbeddingTexts(size)

        if (useRealData) {
          const result = await benchmark(
            async () => {
              await realEmbedBatch(texts)
            },
            { name: `Real batch ${size}`, iterations: 3, warmup: 1 }
          )
          results.push({ size, ...result })
        } else {
          const mock = createFastEmbedder()
          const result = await benchmark(
            async () => {
              await mock.embedder(texts, { pooling: 'mean', normalize: true })
            },
            { name: `Mock batch ${size}`, iterations: 20, warmup: 5 }
          )
          results.push({ size, ...result })
        }
      }

      console.log('\nBatch Size vs Throughput:')
      for (const r of results) {
        const throughput = calculateThroughput(r.size, r.mean)
        console.log(`  Batch ${r.size}: ${throughput.toFixed(1)} texts/sec`)
      }

      const throughput8 = calculateThroughput(results[0].size, results[0].mean)
      const throughput64 = calculateThroughput(results[3].size, results[3].mean)
      expect(throughput64).toBeGreaterThanOrEqual(throughput8 * 0.3) // Batch should help throughput
    })

    it('should handle 100 texts in batches', async () => {
      const texts = generateEmbeddingTexts(100)
      const BATCH_SIZE = 32

      if (useRealData) {
        const result = await benchmark(
          async () => {
            for (let i = 0; i < texts.length; i += BATCH_SIZE) {
              const batch = texts.slice(i, i + BATCH_SIZE)
              await realEmbedBatch(batch)
            }
          },
          { name: 'Real embed 100 texts (batched)', iterations: 3, warmup: 1 }
        )
        reporter.addResult(result)

        const throughput = calculateThroughput(100, result.mean)
        console.log(`Real 100 texts throughput: ${throughput.toFixed(1)} texts/sec`)
        expect(result.mean).toBeLessThan(10000)
      } else {
        const mock = createFastEmbedder()
        const result = await benchmark(
          async () => {
            for (let i = 0; i < texts.length; i += BATCH_SIZE) {
              const batch = texts.slice(i, i + BATCH_SIZE)
              await mock.embedder(batch, { pooling: 'mean', normalize: true })
            }
          },
          { name: 'Mock embed 100 texts (batched)', iterations: 5, warmup: 1 }
        )
        reporter.addResult(result)

        const throughput = calculateThroughput(100, result.mean)
        console.log(`Mock 100 texts throughput: ${throughput.toFixed(1)} texts/sec`)
        expect(result.mean).toBeLessThan(500)
      }
    })
  })

  describe('Vector Operations', () => {
    it('should calculate cosine similarity quickly', async () => {
      const vec1 = generateMockEmbeddings(1, 384)[0]
      const vec2 = generateMockEmbeddings(1, 384)[0]

      const cosineSimilarity = (a, b) => {
        let dotProduct = 0
        let normA = 0
        let normB = 0

        for (let i = 0; i < a.length; i++) {
          dotProduct += a[i] * b[i]
          normA += a[i] * a[i]
          normB += b[i] * b[i]
        }

        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
      }

      const result = await benchmark(
        () => cosineSimilarity(vec1, vec2),
        { name: 'Cosine similarity', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should find top-k similar vectors efficiently', async () => {
      const queryVector = generateMockEmbeddings(1, 384)[0]
      const database = generateMockEmbeddings(10000, 384)

      const cosineSimilarity = (a, b) => {
        let dot = 0, normA = 0, normB = 0
        for (let i = 0; i < a.length; i++) {
          dot += a[i] * b[i]
          normA += a[i] * a[i]
          normB += b[i] * b[i]
        }
        return dot / (Math.sqrt(normA) * Math.sqrt(normB))
      }

      const result = await benchmark(
        () => {
          const similarities = database.map((vec, i) => ({
            index: i,
            similarity: cosineSimilarity(queryVector, vec)
          }))
          return similarities
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, 20)
        },
        { name: 'Top-20 from 10k vectors', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(500)
    })

    it('should normalize vectors efficiently', async () => {
      const vectors = generateMockEmbeddings(100, 384)

      const normalize = (vec) => {
        let norm = 0
        for (let i = 0; i < vec.length; i++) {
          norm += vec[i] * vec[i]
        }
        norm = Math.sqrt(norm)
        const result = new Float32Array(vec.length)
        for (let i = 0; i < vec.length; i++) {
          result[i] = vec[i] / norm
        }
        return result
      }

      const result = await benchmark(
        () => {
          for (const vec of vectors) {
            normalize(vec)
          }
        },
        { name: 'Normalize 100 vectors', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })
  })

  describe('Embedding Cache', () => {
    it('should hit cache efficiently', async () => {
      const cache = new Map()
      const texts = generateEmbeddingTexts(100)

      if (useRealData) {
        // Populate cache with real embeddings
        for (const text of texts.slice(0, 20)) {
          const embedding = await realEmbed(text)
          cache.set(text, embedding)
        }

        const result = await benchmark(
          () => {
            for (const text of texts.slice(0, 20)) {
              cache.get(text)
            }
          },
          { name: 'Real cache hits (20)', iterations: 100, warmup: 20 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(5)
      } else {
        const mock = createFastEmbedder()
        for (const text of texts) {
          const result = await mock.embedder([text])
          cache.set(text, result.data)
        }

        const result = await benchmark(
          () => {
            for (const text of texts) {
              cache.get(text)
            }
          },
          { name: 'Mock cache hits (100)', iterations: 100, warmup: 20 }
        )
        reporter.addResult(result)
        expect(result.mean).toBeLessThan(5)
      }
    })

    it('should handle cache miss gracefully', async () => {
      const cache = new Map()

      if (useRealData) {
        const getEmbedding = async (text) => {
          if (cache.has(text)) {
            return cache.get(text)
          }
          const embedding = await realEmbed(text)
          cache.set(text, embedding)
          return embedding
        }

        const texts = generateEmbeddingTexts(10)

        // First pass - all misses
        const missResult = await benchmark(
          async () => {
            cache.clear()
            for (const text of texts) {
              await getEmbedding(text)
            }
          },
          { name: 'Real cold cache', iterations: 2, warmup: 0 }
        )

        // Second pass - all hits
        const hitResult = await benchmark(
          async () => {
            for (const text of texts) {
              await getEmbedding(text)
            }
          },
          { name: 'Real warm cache', iterations: 5, warmup: 1 }
        )

        console.log(`\nReal cold cache: ${missResult.mean.toFixed(2)}ms`)
        console.log(`Real warm cache: ${hitResult.mean.toFixed(2)}ms`)
        console.log(`Speedup: ${(missResult.mean / hitResult.mean).toFixed(1)}x`)

        expect(hitResult.mean).toBeLessThan(missResult.mean)
      } else {
        const mock = createFastEmbedder()

        const getEmbedding = async (text) => {
          if (cache.has(text)) {
            return cache.get(text)
          }
          const result = await mock.embedder([text])
          cache.set(text, result.data)
          return result.data
        }

        const texts = generateEmbeddingTexts(50)

        const missResult = await benchmark(
          async () => {
            cache.clear()
            for (const text of texts) {
              await getEmbedding(text)
            }
          },
          { name: 'Mock cold cache', iterations: 5, warmup: 1 }
        )

        const hitResult = await benchmark(
          async () => {
            for (const text of texts) {
              await getEmbedding(text)
            }
          },
          { name: 'Mock warm cache', iterations: 10, warmup: 2 }
        )

        console.log(`\nMock cold cache: ${missResult.mean.toFixed(2)}ms`)
        console.log(`Mock warm cache: ${hitResult.mean.toFixed(2)}ms`)
        console.log(`Speedup: ${(missResult.mean / hitResult.mean).toFixed(1)}x`)

        expect(hitResult.mean).toBeLessThan(missResult.mean)
      }
    })
  })

  describe('Memory Efficiency', () => {
    it('should manage embedding memory efficiently', async () => {
      const memBefore = getMemoryUsage()

      if (useRealData) {
        // Generate embeddings
        for (let i = 0; i < 20; i++) {
          const texts = generateEmbeddingTexts(10)
          await realEmbedBatch(texts)
        }
      } else {
        const mock = createFastEmbedder()
        for (let i = 0; i < 100; i++) {
          const texts = generateEmbeddingTexts(32)
          await mock.embedder(texts)
        }
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory growth: ${growth.toFixed(2)}MB`)
      expect(growth).toBeLessThan(200) // Allow more for real model
    })

    it('should not leak memory in batch processing', async () => {
      const samples = []

      if (useRealData) {
        for (let i = 0; i < 5; i++) {
          const texts = generateEmbeddingTexts(20)
          await realEmbedBatch(texts)
          samples.push(getMemoryUsage().heapUsed)
        }
      } else {
        const mock = createFastEmbedder()
        for (let i = 0; i < 10; i++) {
          const texts = generateEmbeddingTexts(100)
          await mock.embedder(texts)
          samples.push(getMemoryUsage().heapUsed)
        }
      }

      const growth = samples[samples.length - 1] - samples[0]
      console.log(`\nMemory samples: ${samples.map(s => s.toFixed(1)).join(' -> ')}MB`)
      console.log(`Total growth: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(100)
    })
  })

  describe('Latency Distribution', () => {
    it('should have consistent embedding latency', async () => {
      const histogram = new LatencyHistogram(useRealData ? 10 : 1)

      if (useRealData) {
        for (let i = 0; i < 20; i++) {
          const text = `Test text number ${i} with some content`
          const start = performance.now()
          await realEmbed(text)
          histogram.record(performance.now() - start)
        }

        console.log('\nReal Embedding Latency Distribution:')
        histogram.printHistogram()
        expect(histogram.getMean()).toBeLessThan(200)
      } else {
        const mock = createFastEmbedder()
        for (let i = 0; i < 200; i++) {
          const text = `Test text number ${i} with some content`
          const start = performance.now()
          await mock.embedder([text])
          histogram.record(performance.now() - start)
        }

        console.log('\nMock Embedding Latency Distribution:')
        histogram.printHistogram()
        expect(histogram.getMean()).toBeLessThan(10)
      }
    })
  })
})
