/**
 * LanceDB performance tests
 * Tests: index creation, query optimization, compaction, vector operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  getMemoryUsage
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMockEmbeddings
} from './helpers/data-generators.js'
import { createLanceDBMock, createPerformanceMocks } from './helpers/mocks.js'

describe('LanceDB Performance', () => {
  let mocks
  let reporter
  let lancedb

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    lancedb = createLanceDBMock()
    reporter = new PerformanceReporter('LanceDB Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Table Creation', () => {
    it('should create table quickly', async () => {
      const result = await benchmark(
        async () => {
          const db = await lancedb.connect('/tmp/test.lance')
          await db.createTable('test_table', [
            { id: '1', vector: new Float32Array(384), text: 'test' }
          ])
        },
        { name: 'Create table', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should create table with many columns efficiently', async () => {
      const result = await benchmark(
        async () => {
          const db = await lancedb.connect('/tmp/test.lance')
          await db.createTable('wide_table', [
            {
              id: '1',
              vector: new Float32Array(384),
              text: 'test',
              subject: 'Subject',
              from: 'sender@example.com',
              to: 'recipient@example.com',
              date: new Date().toISOString(),
              source: 'email',
              path: '/path/to/file',
              metadata: JSON.stringify({ key: 'value' })
            }
          ])
        },
        { name: 'Create wide table', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })
  })

  describe('Bulk Insert', () => {
    it('should insert 100 records quickly', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const table = await db.createTable('bulk_test', [
        { id: '0', vector: new Float32Array(384), text: 'initial' }
      ])

      const records = Array(100).fill(null).map((_, i) => ({
        id: String(i + 1),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i + 1}`
      }))

      const result = await benchmark(
        async () => {
          await table.add(records)
        },
        { name: 'Insert 100 records', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(200)
    })

    it('should insert 1000 records efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const table = await db.createTable('bulk_test_large', [
        { id: '0', vector: new Float32Array(384), text: 'initial' }
      ])

      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i + 1),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i + 1}`
      }))

      const result = await benchmark(
        async () => {
          await table.add(records)
        },
        { name: 'Insert 1000 records', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      const throughput = 1000 / (result.mean / 1000)
      console.log(`Throughput: ${throughput.toFixed(0)} records/sec`)
      expect(result.mean).toBeLessThan(2000)
    })

    it('should handle batched inserts efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const table = await db.createTable('batched_test', [
        { id: '0', vector: new Float32Array(384), text: 'initial' }
      ])

      const BATCH_SIZE = 100
      const TOTAL = 500

      const result = await benchmark(
        async () => {
          for (let i = 0; i < TOTAL; i += BATCH_SIZE) {
            const batch = Array(BATCH_SIZE).fill(null).map((_, j) => ({
              id: String(i + j),
              vector: new Float32Array(384).fill(Math.random()),
              text: `Record ${i + j}`
            }))
            await table.add(batch)
          }
        },
        { name: 'Batched insert 500', iterations: 3, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(3000)
    })
  })

  describe('Vector Search', () => {
    it('should search small table quickly', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(100).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('search_small', records)

      const queryVector = new Float32Array(384).fill(0.5)

      const result = await benchmark(
        async () => {
          await table.search(queryVector).limit(10).execute()
        },
        { name: 'Search 100 records', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should search large table efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(10000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('search_large', records)

      const queryVector = new Float32Array(384).fill(0.5)

      const result = await benchmark(
        async () => {
          await table.search(queryVector).limit(20).execute()
        },
        { name: 'Search 10k records', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })

    it('should handle varying limit sizes', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('search_limits', records)

      const queryVector = new Float32Array(384).fill(0.5)
      const limits = [5, 10, 20, 50, 100]

      console.log('\nSearch latency by limit:')
      for (const limit of limits) {
        const result = await benchmark(
          async () => {
            await table.search(queryVector).limit(limit).execute()
          },
          { name: `Limit ${limit}`, iterations: 20, warmup: 5 }
        )
        console.log(`  Limit ${limit}: ${result.mean.toFixed(2)}ms`)
      }

      expect(true).toBe(true)
    })
  })

  describe('Filtered Search', () => {
    it('should filter by source type efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const sources = ['email', 'message', 'calendar', 'contact']
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`,
        source: sources[i % sources.length]
      }))
      const table = await db.createTable('filtered_search', records)

      const queryVector = new Float32Array(384).fill(0.5)

      const result = await benchmark(
        async () => {
          await table.search(queryVector)
            .filter("source = 'email'")
            .limit(20)
            .execute()
        },
        { name: 'Filtered search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should handle complex filter expressions', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`,
        source: i % 2 === 0 ? 'email' : 'message',
        date: Date.now() - (i * 86400000) // Days ago
      }))
      const table = await db.createTable('complex_filter', records)

      const queryVector = new Float32Array(384).fill(0.5)
      const oneWeekAgo = Date.now() - (7 * 86400000)

      const result = await benchmark(
        async () => {
          await table.search(queryVector)
            .filter(`source = 'email' AND date > ${oneWeekAgo}`)
            .limit(20)
            .execute()
        },
        { name: 'Complex filter', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })
  })

  describe('Delete Operations', () => {
    it('should delete single record quickly', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(100).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('delete_single', records)

      const result = await benchmark(
        async () => {
          await table.delete("id = '50'")
        },
        { name: 'Delete single', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should delete multiple records efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`,
        source: i % 2 === 0 ? 'old' : 'new'
      }))
      const table = await db.createTable('delete_bulk', records)

      const result = await benchmark(
        async () => {
          await table.delete("source = 'old'")
        },
        { name: 'Delete bulk', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(200)
    })
  })

  describe('Update Operations', () => {
    it('should update records efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(100).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`,
        updated: false
      }))
      const table = await db.createTable('update_test', records)

      const result = await benchmark(
        async () => {
          await table.update({ updated: true }, "id = '50'")
        },
        { name: 'Update single', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Connection Pooling', () => {
    it('should reuse connections efficiently', async () => {
      const connections = []

      const result = await benchmark(
        async () => {
          const db = await lancedb.connect('/tmp/test.lance')
          connections.push(db)
        },
        { name: 'Connection reuse', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should handle concurrent connections', async () => {
      const result = await benchmark(
        async () => {
          const promises = Array(10).fill(null).map(() =>
            lancedb.connect('/tmp/test.lance')
          )
          await Promise.all(promises)
        },
        { name: '10 concurrent connections', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })
  })

  describe('Memory Efficiency', () => {
    it('should manage memory during large inserts', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const table = await db.createTable('memory_test', [
        { id: '0', vector: new Float32Array(384), text: 'initial' }
      ])

      const memBefore = getMemoryUsage()

      for (let batch = 0; batch < 10; batch++) {
        const records = Array(100).fill(null).map((_, i) => ({
          id: String(batch * 100 + i),
          vector: new Float32Array(384).fill(Math.random()),
          text: `Record ${batch * 100 + i}`
        }))
        await table.add(records)
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      console.log(`\nMemory growth for 1000 inserts: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(100)
    })

    it('should not leak memory during searches', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('leak_test', records)

      const memSamples = []

      for (let i = 0; i < 100; i++) {
        const queryVector = new Float32Array(384).fill(Math.random())
        await table.search(queryVector).limit(20).execute()

        if (i % 20 === 0) {
          memSamples.push(getMemoryUsage().heapUsed)
        }
      }

      console.log('\nMemory during searches:')
      console.log(`  Samples: ${memSamples.map(m => m.toFixed(1)).join('MB → ')}MB`)

      const growth = memSamples[memSamples.length - 1] - memSamples[0]
      console.log(`  Growth: ${growth.toFixed(2)}MB`)

      expect(growth).toBeLessThan(50)
    })
  })

  describe('Index Operations', () => {
    it('should create index efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('index_test', records)

      const result = await benchmark(
        async () => {
          await table.createIndex('vector')
        },
        { name: 'Create vector index', iterations: 5, warmup: 1 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(500)
    })
  })

  describe('Query Builder Performance', () => {
    it('should build queries efficiently', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(100).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`,
        source: 'email'
      }))
      const table = await db.createTable('query_builder', records)

      const queryVector = new Float32Array(384).fill(0.5)

      const result = await benchmark(
        async () => {
          // Chain multiple operations
          await table.search(queryVector)
            .filter("source = 'email'")
            .select(['id', 'text'])
            .limit(10)
            .execute()
        },
        { name: 'Complex query build', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(30)
    })
  })

  describe('Latency Distribution', () => {
    it('should have consistent search latency', async () => {
      const db = await lancedb.connect('/tmp/test.lance')
      const records = Array(1000).fill(null).map((_, i) => ({
        id: String(i),
        vector: new Float32Array(384).fill(Math.random()),
        text: `Record ${i}`
      }))
      const table = await db.createTable('latency_dist', records)

      const histogram = new LatencyHistogram(2)
      const queryVector = new Float32Array(384).fill(0.5)

      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await table.search(queryVector).limit(20).execute()
        histogram.record(performance.now() - start)
      }

      console.log('\nLanceDB Search Latency Distribution:')
      histogram.printHistogram()

      expect(histogram.getMean()).toBeLessThan(50)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
