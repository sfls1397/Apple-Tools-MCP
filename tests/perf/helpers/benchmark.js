/**
 * Comprehensive benchmarking utilities for performance tests
 */

/**
 * Measure execution time of an async function with high precision
 */
export async function measureTime(fn) {
  const start = performance.now()
  const result = await fn()
  const duration = performance.now() - start
  return { result, duration }
}

/**
 * Measure execution time of a sync function
 */
export function measureTimeSync(fn) {
  const start = performance.now()
  const result = fn()
  const duration = performance.now() - start
  return { result, duration }
}

/**
 * Get current memory usage in MB
 */
export function getMemoryUsage() {
  const usage = process.memoryUsage()
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    external: Math.round(usage.external / 1024 / 1024 * 100) / 100,
    arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024 * 100) / 100
  }
}

/**
 * Calculate throughput (items per second)
 */
export function calculateThroughput(itemCount, durationMs) {
  if (durationMs === 0) return Infinity
  return itemCount / (durationMs / 1000)
}

/**
 * Calculate latency percentiles
 */
export function calculatePercentiles(durations) {
  const sorted = [...durations].sort((a, b) => a - b)
  const len = sorted.length

  return {
    min: sorted[0],
    p50: sorted[Math.floor(len * 0.50)],
    p75: sorted[Math.floor(len * 0.75)],
    p90: sorted[Math.floor(len * 0.90)],
    p95: sorted[Math.floor(len * 0.95)],
    p99: sorted[Math.floor(len * 0.99)] || sorted[len - 1],
    max: sorted[len - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / len,
    stdDev: calculateStdDev(sorted)
  }
}

function calculateStdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2))
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length)
}

/**
 * Run a benchmark with warmup, iterations, and stats collection
 */
export async function benchmark(fn, options = {}) {
  const {
    name = 'Benchmark',
    iterations = 10,
    warmup = 3,
    collectMemory = false,
    cooldownMs = 10
  } = options

  // Warmup phase
  for (let i = 0; i < warmup; i++) {
    await fn()
    if (collectMemory && global.gc) global.gc()
  }

  // Benchmark phase
  const durations = []
  const memorySnapshots = []

  for (let i = 0; i < iterations; i++) {
    if (collectMemory) {
      memorySnapshots.push(getMemoryUsage())
    }

    const { duration } = await measureTime(fn)
    durations.push(duration)

    // Brief cooldown between iterations
    await new Promise(r => setTimeout(r, cooldownMs))
  }

  if (collectMemory) {
    memorySnapshots.push(getMemoryUsage())
  }

  const percentiles = calculatePercentiles(durations)

  return {
    name,
    iterations,
    warmup,
    durations,
    ...percentiles,
    totalTime: durations.reduce((a, b) => a + b, 0),
    memory: collectMemory ? {
      start: memorySnapshots[0],
      end: memorySnapshots[memorySnapshots.length - 1],
      growth: memorySnapshots.length > 1
        ? memorySnapshots[memorySnapshots.length - 1].heapUsed - memorySnapshots[0].heapUsed
        : 0
    } : null
  }
}

/**
 * Run multiple benchmarks and compare results
 */
export async function compareBenchmarks(benchmarks, options = {}) {
  const results = []

  for (const { name, fn } of benchmarks) {
    const result = await benchmark(fn, { name, ...options })
    results.push(result)
  }

  // Find baseline (first one)
  const baseline = results[0]

  return results.map(r => ({
    ...r,
    relativeToBaseline: r.mean / baseline.mean,
    speedupVsBaseline: baseline.mean / r.mean
  }))
}

/**
 * Performance reporter for console output
 */
export class PerformanceReporter {
  constructor(name) {
    this.name = name
    this.results = []
  }

  addResult(result) {
    this.results.push(result)
    return this
  }

  report() {
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  ${this.name} - Performance Report`)
    console.log('='.repeat(60))

    for (const r of this.results) {
      console.log(`\n📊 ${r.name}`)
      console.log(`   Iterations: ${r.iterations} (warmup: ${r.warmup})`)
      console.log(`   Mean:   ${r.mean.toFixed(2)}ms`)
      console.log(`   Median: ${r.p50.toFixed(2)}ms`)
      console.log(`   Min:    ${r.min.toFixed(2)}ms`)
      console.log(`   Max:    ${r.max.toFixed(2)}ms`)
      console.log(`   P95:    ${r.p95.toFixed(2)}ms`)
      console.log(`   StdDev: ${r.stdDev.toFixed(2)}ms`)

      if (r.memory) {
        console.log(`   Memory Growth: ${r.memory.growth.toFixed(2)}MB`)
      }

      if (r.speedupVsBaseline && r.speedupVsBaseline !== 1) {
        console.log(`   vs Baseline: ${r.speedupVsBaseline.toFixed(2)}x`)
      }
    }

    console.log('\n' + '='.repeat(60) + '\n')
    return this
  }

  toJSON() {
    return {
      name: this.name,
      timestamp: new Date().toISOString(),
      results: this.results.map(r => ({
        name: r.name,
        iterations: r.iterations,
        mean: r.mean,
        median: r.p50,
        min: r.min,
        max: r.max,
        p95: r.p95,
        p99: r.p99,
        stdDev: r.stdDev,
        memoryGrowth: r.memory?.growth
      }))
    }
  }
}

/**
 * Latency histogram for detailed distribution analysis
 */
export class LatencyHistogram {
  constructor(bucketWidth = 1) {
    this.bucketWidth = bucketWidth
    this.buckets = new Map()
    this.count = 0
    this.sum = 0
    this.min = Infinity
    this.max = -Infinity
  }

  record(latencyMs) {
    const bucket = Math.floor(latencyMs / this.bucketWidth) * this.bucketWidth
    this.buckets.set(bucket, (this.buckets.get(bucket) || 0) + 1)
    this.count++
    this.sum += latencyMs
    this.min = Math.min(this.min, latencyMs)
    this.max = Math.max(this.max, latencyMs)
  }

  getMean() {
    return this.count > 0 ? this.sum / this.count : 0
  }

  getDistribution() {
    const sorted = [...this.buckets.entries()].sort((a, b) => a[0] - b[0])
    return sorted.map(([bucket, count]) => ({
      bucket: `${bucket}-${bucket + this.bucketWidth}ms`,
      count,
      percentage: ((count / this.count) * 100).toFixed(1) + '%'
    }))
  }

  printHistogram() {
    const dist = this.getDistribution()
    const maxCount = Math.max(...dist.map(d => d.count))
    const maxBarWidth = 40

    console.log('\nLatency Distribution:')
    for (const d of dist) {
      const barWidth = Math.round((d.count / maxCount) * maxBarWidth)
      const bar = '█'.repeat(barWidth)
      console.log(`  ${d.bucket.padStart(12)} | ${bar} (${d.count})`)
    }
  }
}

/**
 * Wait for a specified duration
 */
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Force garbage collection if available
 */
export function forceGC() {
  if (global.gc) {
    global.gc()
    return true
  }
  return false
}

/**
 * Run performance test with assertions
 */
export async function assertPerformance(fn, expectations, options = {}) {
  const result = await benchmark(fn, options)

  const failures = []

  if (expectations.maxMeanMs && result.mean > expectations.maxMeanMs) {
    failures.push(`Mean ${result.mean.toFixed(2)}ms exceeds max ${expectations.maxMeanMs}ms`)
  }

  if (expectations.maxP95Ms && result.p95 > expectations.maxP95Ms) {
    failures.push(`P95 ${result.p95.toFixed(2)}ms exceeds max ${expectations.maxP95Ms}ms`)
  }

  if (expectations.maxP99Ms && result.p99 > expectations.maxP99Ms) {
    failures.push(`P99 ${result.p99.toFixed(2)}ms exceeds max ${expectations.maxP99Ms}ms`)
  }

  if (expectations.minThroughput) {
    const throughput = 1000 / result.mean
    if (throughput < expectations.minThroughput) {
      failures.push(`Throughput ${throughput.toFixed(2)}/s below min ${expectations.minThroughput}/s`)
    }
  }

  if (expectations.maxMemoryGrowthMB && result.memory) {
    if (result.memory.growth > expectations.maxMemoryGrowthMB) {
      failures.push(`Memory growth ${result.memory.growth.toFixed(2)}MB exceeds max ${expectations.maxMemoryGrowthMB}MB`)
    }
  }

  return {
    passed: failures.length === 0,
    result,
    failures
  }
}
