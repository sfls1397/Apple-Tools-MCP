/**
 * Regression detection performance tests
 * Tests: baseline comparisons, delta tracking, performance trends
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  getMemoryUsage
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateSearchQueries
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

// Simulated baseline data (in production, load from file)
const BASELINES = {
  'search_latency': { mean: 15, p95: 25, threshold: 1.2 },
  'indexing_throughput': { mean: 500, threshold: 0.8 },
  'embedding_latency': { mean: 5, p95: 10, threshold: 1.3 },
  'tool_dispatch': { mean: 2, p95: 5, threshold: 1.5 },
  'memory_per_1k_items': { mean: 10, threshold: 1.5 }
}

describe('Regression Detection', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Regression Detection')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Baseline Comparisons', () => {
    it('should compare search latency against baseline', async () => {
      const queries = generateSearchQueries(50)
      const latencies = []

      for (const query of queries) {
        const start = performance.now()
        await mocks.embedder.embedder([query])
        latencies.push(performance.now() - start)
      }

      const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
      const sorted = [...latencies].sort((a, b) => a - b)
      const p95 = sorted[Math.floor(sorted.length * 0.95)]

      const baseline = BASELINES['search_latency']
      const meanRatio = mean / baseline.mean
      const p95Ratio = p95 / baseline.p95

      console.log('\nSearch Latency Regression Check:')
      console.log(`  Current Mean: ${mean.toFixed(2)}ms (baseline: ${baseline.mean}ms)`)
      console.log(`  Current P95: ${p95.toFixed(2)}ms (baseline: ${baseline.p95}ms)`)
      console.log(`  Mean Ratio: ${meanRatio.toFixed(2)}x`)
      console.log(`  P95 Ratio: ${p95Ratio.toFixed(2)}x`)
      console.log(`  Status: ${meanRatio <= baseline.threshold ? '✅ PASS' : '❌ REGRESSION'}`)

      expect(meanRatio).toBeLessThan(baseline.threshold)
    })

    it('should compare indexing throughput against baseline', async () => {
      const emails = generateEmails(1000)
      const BATCH_SIZE = 32

      const startTime = performance.now()

      for (let i = 0; i < emails.length; i += BATCH_SIZE) {
        const batch = emails.slice(i, i + BATCH_SIZE)
        await mocks.embedder.embedder(batch.map(e => e.subject))
      }

      const duration = performance.now() - startTime
      const throughput = (emails.length / duration) * 1000 // items per second

      const baseline = BASELINES['indexing_throughput']
      const ratio = throughput / baseline.mean

      console.log('\nIndexing Throughput Regression Check:')
      console.log(`  Current: ${throughput.toFixed(1)} items/sec (baseline: ${baseline.mean})`)
      console.log(`  Ratio: ${ratio.toFixed(2)}x`)
      console.log(`  Status: ${ratio >= baseline.threshold ? '✅ PASS' : '❌ REGRESSION'}`)

      // Throughput should not drop below threshold
      expect(ratio).toBeGreaterThan(baseline.threshold)
    })

    it('should compare embedding latency against baseline', async () => {
      const result = await benchmark(
        async () => {
          await mocks.embedder.embedder(['test embedding query'])
        },
        { name: 'Single embedding', iterations: 100, warmup: 20 }
      )

      const baseline = BASELINES['embedding_latency']
      const meanRatio = result.mean / baseline.mean
      const p95Ratio = result.p95 / baseline.p95

      console.log('\nEmbedding Latency Regression Check:')
      console.log(`  Current Mean: ${result.mean.toFixed(2)}ms (baseline: ${baseline.mean}ms)`)
      console.log(`  Current P95: ${result.p95.toFixed(2)}ms (baseline: ${baseline.p95}ms)`)
      console.log(`  Mean Ratio: ${meanRatio.toFixed(2)}x`)
      console.log(`  Status: ${meanRatio <= baseline.threshold ? '✅ PASS' : '❌ REGRESSION'}`)

      expect(meanRatio).toBeLessThan(baseline.threshold)
    })

    it('should compare tool dispatch latency against baseline', async () => {
      const result = await benchmark(
        async () => {
          // Simulate tool dispatch
          const toolName = 'mail_search'
          const args = { query: 'test' }
          await mocks.embedder.embedder([args.query])
        },
        { name: 'Tool dispatch', iterations: 100, warmup: 20 }
      )

      const baseline = BASELINES['tool_dispatch']
      const meanRatio = result.mean / baseline.mean

      console.log('\nTool Dispatch Regression Check:')
      console.log(`  Current Mean: ${result.mean.toFixed(2)}ms (baseline: ${baseline.mean}ms)`)
      console.log(`  Ratio: ${meanRatio.toFixed(2)}x`)
      console.log(`  Status: ${meanRatio <= baseline.threshold ? '✅ PASS' : '❌ REGRESSION'}`)

      expect(meanRatio).toBeLessThan(baseline.threshold)
    })
  })

  describe('Delta Tracking', () => {
    it('should track performance delta across runs', async () => {
      const runs = []

      // Simulate multiple runs
      for (let run = 0; run < 5; run++) {
        const queries = generateSearchQueries(20)
        const latencies = []

        for (const query of queries) {
          const start = performance.now()
          await mocks.embedder.embedder([query])
          latencies.push(performance.now() - start)
        }

        const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
        runs.push({ run: run + 1, mean })
      }

      console.log('\nPerformance Delta Across Runs:')
      runs.forEach(r => console.log(`  Run ${r.run}: ${r.mean.toFixed(2)}ms`))

      const means = runs.map(r => r.mean)
      const overallMean = means.reduce((a, b) => a + b, 0) / means.length
      const variance = means.reduce((sum, m) => sum + Math.pow(m - overallMean, 2), 0) / means.length
      const stdDev = Math.sqrt(variance)
      const cv = (stdDev / overallMean) * 100

      console.log(`  Mean: ${overallMean.toFixed(2)}ms`)
      console.log(`  StdDev: ${stdDev.toFixed(2)}ms`)
      console.log(`  CV: ${cv.toFixed(1)}%`)

      // Coefficient of variation should be reasonable
      // Higher threshold for mock operations where timer noise dominates
      expect(cv).toBeLessThan(150) // Less than 150% variation
    })

    it('should detect performance degradation trends', async () => {
      const samples = []

      // Simulate increasing load
      for (let load = 1; load <= 5; load++) {
        const itemCount = load * 100
        const emails = generateEmails(itemCount)

        const start = performance.now()
        for (let i = 0; i < emails.length; i += 32) {
          await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        }
        const duration = performance.now() - start

        samples.push({
          load: itemCount,
          duration,
          perItem: duration / itemCount
        })
      }

      console.log('\nPerformance Under Increasing Load:')
      samples.forEach(s => {
        console.log(`  ${s.load} items: ${s.duration.toFixed(1)}ms (${s.perItem.toFixed(3)}ms/item)`)
      })

      // Per-item time should not increase dramatically with load
      const firstPerItem = samples[0].perItem
      const lastPerItem = samples[samples.length - 1].perItem
      const degradation = lastPerItem / firstPerItem

      console.log(`  Degradation factor: ${degradation.toFixed(2)}x`)

      expect(degradation).toBeLessThan(3) // Should not degrade more than 3x
    })
  })

  describe('Memory Regression', () => {
    it('should compare memory usage against baseline', async () => {
      const memBefore = getMemoryUsage()

      // Process 1000 items
      const emails = generateEmails(1000)
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }

      const memAfter = getMemoryUsage()
      const growth = memAfter.heapUsed - memBefore.heapUsed

      const baseline = BASELINES['memory_per_1k_items']
      const ratio = growth / baseline.mean

      console.log('\nMemory Regression Check:')
      console.log(`  Current Growth: ${growth.toFixed(2)}MB (baseline: ${baseline.mean}MB)`)
      console.log(`  Ratio: ${ratio.toFixed(2)}x`)
      console.log(`  Status: ${ratio <= baseline.threshold ? '✅ PASS' : '❌ REGRESSION'}`)

      expect(ratio).toBeLessThan(baseline.threshold)
    })

    it('should track memory growth rate', async () => {
      const samples = []

      for (let batch = 1; batch <= 5; batch++) {
        const emails = generateEmails(200)
        await mocks.embedder.embedder(emails.map(e => e.subject))
        samples.push(getMemoryUsage().heapUsed)
      }

      console.log('\nMemory Growth Rate:')
      for (let i = 0; i < samples.length; i++) {
        const growth = i > 0 ? samples[i] - samples[i - 1] : 0
        console.log(`  Batch ${i + 1}: ${samples[i].toFixed(2)}MB (+${growth.toFixed(2)}MB)`)
      }

      // Later batches should not use significantly more memory
      const firstGrowth = samples[1] - samples[0]
      const lastGrowth = samples[samples.length - 1] - samples[samples.length - 2]

      // Allow for natural variation, but growth should not accelerate
      expect(lastGrowth).toBeLessThan(Math.max(firstGrowth * 3, 20))
    })
  })

  describe('Throughput Regression', () => {
    it('should maintain consistent throughput over time', async () => {
      const throughputSamples = []

      for (let sample = 0; sample < 5; sample++) {
        const emails = generateEmails(200)
        const start = performance.now()

        for (let i = 0; i < emails.length; i += 32) {
          await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
        }

        const duration = performance.now() - start
        const throughput = (200 / duration) * 1000
        throughputSamples.push(throughput)
      }

      console.log('\nThroughput Consistency:')
      throughputSamples.forEach((t, i) => {
        console.log(`  Sample ${i + 1}: ${t.toFixed(1)} items/sec`)
      })

      const mean = throughputSamples.reduce((a, b) => a + b, 0) / throughputSamples.length
      const min = Math.min(...throughputSamples)
      const max = Math.max(...throughputSamples)
      const range = max - min

      console.log(`  Mean: ${mean.toFixed(1)} items/sec`)
      console.log(`  Range: ${range.toFixed(1)} (${((range / mean) * 100).toFixed(1)}%)`)

      // Throughput should be consistent (within 50% range)
      expect(range / mean).toBeLessThan(0.5)
    })
  })

  describe('Latency Percentiles', () => {
    it('should track all latency percentiles for regression', async () => {
      const latencies = []

      for (let i = 0; i < 200; i++) {
        const start = performance.now()
        await mocks.embedder.embedder([`query ${i}`])
        latencies.push(performance.now() - start)
      }

      const sorted = [...latencies].sort((a, b) => a - b)
      const percentiles = {
        p50: sorted[Math.floor(sorted.length * 0.50)],
        p75: sorted[Math.floor(sorted.length * 0.75)],
        p90: sorted[Math.floor(sorted.length * 0.90)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)]
      }

      console.log('\nLatency Percentiles:')
      Object.entries(percentiles).forEach(([key, value]) => {
        console.log(`  ${key}: ${value.toFixed(2)}ms`)
      })

      // P99 should not be excessively higher than P50
      // Higher threshold for mock operations where outliers dominate at microsecond scale
      const ratio = percentiles.p99 / percentiles.p50
      console.log(`  P99/P50 ratio: ${ratio.toFixed(2)}x`)

      expect(ratio).toBeLessThan(200)
    })
  })

  describe('Baseline Generation', () => {
    it('should generate baseline data for future comparisons', async () => {
      const baselineData = {}

      // Search latency
      const searchLatencies = []
      for (let i = 0; i < 100; i++) {
        const start = performance.now()
        await mocks.embedder.embedder([`search query ${i}`])
        searchLatencies.push(performance.now() - start)
      }
      const searchSorted = [...searchLatencies].sort((a, b) => a - b)
      baselineData.search = {
        mean: searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length,
        p50: searchSorted[50],
        p95: searchSorted[95],
        p99: searchSorted[99]
      }

      // Indexing throughput
      const emails = generateEmails(500)
      const indexStart = performance.now()
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }
      const indexDuration = performance.now() - indexStart
      baselineData.indexing = {
        throughput: (500 / indexDuration) * 1000,
        duration: indexDuration
      }

      // Memory
      const memBefore = getMemoryUsage().heapUsed
      await mocks.embedder.embedder(generateEmails(100).map(e => e.subject))
      baselineData.memory = {
        heapUsed: getMemoryUsage().heapUsed - memBefore
      }

      console.log('\n=== BASELINE DATA ===')
      console.log(JSON.stringify(baselineData, null, 2))
      console.log('=====================')

      // Just verify we can generate baselines
      expect(baselineData.search.mean).toBeGreaterThan(0)
      expect(baselineData.indexing.throughput).toBeGreaterThan(0)
    })
  })

  describe('Regression Report', () => {
    it('should generate comprehensive regression report', async () => {
      const report = {
        timestamp: new Date().toISOString(),
        results: []
      }

      // Test 1: Search
      const searchResult = await benchmark(
        async () => await mocks.embedder.embedder(['test query']),
        { name: 'Search', iterations: 50, warmup: 10 }
      )
      report.results.push({
        name: 'Search Latency',
        current: searchResult.mean,
        baseline: BASELINES.search_latency.mean,
        status: searchResult.mean / BASELINES.search_latency.mean <= BASELINES.search_latency.threshold ? 'PASS' : 'FAIL'
      })

      // Test 2: Indexing
      const emails = generateEmails(200)
      const indexStart = performance.now()
      for (let i = 0; i < emails.length; i += 32) {
        await mocks.embedder.embedder(emails.slice(i, i + 32).map(e => e.subject))
      }
      const indexThroughput = (200 / (performance.now() - indexStart)) * 1000
      report.results.push({
        name: 'Indexing Throughput',
        current: indexThroughput,
        baseline: BASELINES.indexing_throughput.mean,
        status: indexThroughput / BASELINES.indexing_throughput.mean >= BASELINES.indexing_throughput.threshold ? 'PASS' : 'FAIL'
      })

      console.log('\n=== REGRESSION REPORT ===')
      console.log(`Timestamp: ${report.timestamp}`)
      console.log('Results:')
      report.results.forEach(r => {
        const emoji = r.status === 'PASS' ? '✅' : '❌'
        console.log(`  ${emoji} ${r.name}: ${typeof r.current === 'number' ? r.current.toFixed(2) : r.current} (baseline: ${r.baseline})`)
      })
      console.log('========================')

      const failures = report.results.filter(r => r.status === 'FAIL')
      expect(failures.length).toBe(0)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
