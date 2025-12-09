/**
 * Performance measurement utilities for indexing tests
 */

/**
 * Measure execution time of an async function
 * @returns {{ result: any, duration: number }}
 */
export async function measureTime(fn) {
  const start = performance.now()
  const result = await fn()
  const duration = performance.now() - start
  return { result, duration }
}

/**
 * Measure execution time of a sync function
 * @returns {{ result: any, duration: number }}
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
export function measureMemory() {
  const usage = process.memoryUsage()
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024 * 100) / 100,
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024 * 100) / 100,
    rss: Math.round(usage.rss / 1024 / 1024 * 100) / 100,
    external: Math.round(usage.external / 1024 / 1024 * 100) / 100
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length')
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  if (magnitude === 0) return 0

  return dotProduct / magnitude
}

/**
 * Calculate throughput (items per second)
 */
export function calculateThroughput(itemCount, durationMs) {
  if (durationMs === 0) return Infinity
  return itemCount / (durationMs / 1000)
}

/**
 * Performance tracker for collecting samples over time
 */
export class PerformanceTracker {
  constructor(name = 'Performance') {
    this.name = name
    this.samples = []
    this.startTime = null
  }

  start() {
    this.startTime = performance.now()
    this.samples = []
    return this
  }

  sample(label = '') {
    if (!this.startTime) {
      this.start()
    }

    this.samples.push({
      label,
      elapsed: performance.now() - this.startTime,
      memory: measureMemory(),
      timestamp: Date.now()
    })

    return this
  }

  stop() {
    this.sample('end')
    return this
  }

  getTotalDuration() {
    if (this.samples.length === 0) return 0
    return this.samples[this.samples.length - 1].elapsed
  }

  getMemoryGrowth() {
    if (this.samples.length < 2) return 0
    const first = this.samples[0].memory.heapUsed
    const last = this.samples[this.samples.length - 1].memory.heapUsed
    return last - first
  }

  getPeakMemory() {
    if (this.samples.length === 0) return 0
    return Math.max(...this.samples.map(s => s.memory.heapUsed))
  }

  getAverageInterval() {
    if (this.samples.length < 2) return 0
    const intervals = []
    for (let i = 1; i < this.samples.length; i++) {
      intervals.push(this.samples[i].elapsed - this.samples[i - 1].elapsed)
    }
    return intervals.reduce((a, b) => a + b, 0) / intervals.length
  }

  report() {
    console.log(`\n=== ${this.name} Report ===`)
    console.table(this.samples.map(s => ({
      label: s.label,
      elapsed: `${s.elapsed.toFixed(1)}ms`,
      heap: `${s.memory.heapUsed}MB`,
      rss: `${s.memory.rss}MB`
    })))
    console.log(`Total Duration: ${this.getTotalDuration().toFixed(1)}ms`)
    console.log(`Memory Growth: ${this.getMemoryGrowth().toFixed(2)}MB`)
    console.log(`Peak Memory: ${this.getPeakMemory().toFixed(2)}MB`)
    return this
  }

  getSummary() {
    return {
      name: this.name,
      totalDuration: this.getTotalDuration(),
      memoryGrowth: this.getMemoryGrowth(),
      peakMemory: this.getPeakMemory(),
      sampleCount: this.samples.length
    }
  }
}

/**
 * Throughput tracker for measuring items per second
 */
export class ThroughputTracker {
  constructor() {
    this.batches = []
    this.startTime = null
  }

  start() {
    this.startTime = performance.now()
    this.batches = []
    return this
  }

  recordBatch(itemCount) {
    const now = performance.now()
    const elapsed = this.startTime ? now - this.startTime : 0

    this.batches.push({
      itemCount,
      elapsed,
      timestamp: now
    })

    return this
  }

  getTotalItems() {
    return this.batches.reduce((sum, b) => sum + b.itemCount, 0)
  }

  getTotalDuration() {
    if (this.batches.length === 0) return 0
    return this.batches[this.batches.length - 1].elapsed
  }

  getOverallThroughput() {
    return calculateThroughput(this.getTotalItems(), this.getTotalDuration())
  }

  getBatchThroughputs() {
    const throughputs = []
    for (let i = 1; i < this.batches.length; i++) {
      const items = this.batches[i].itemCount
      const duration = this.batches[i].elapsed - this.batches[i - 1].elapsed
      throughputs.push(calculateThroughput(items, duration))
    }
    return throughputs
  }

  getSummary() {
    const throughputs = this.getBatchThroughputs()
    return {
      totalItems: this.getTotalItems(),
      totalDuration: this.getTotalDuration(),
      overallThroughput: this.getOverallThroughput(),
      batchCount: this.batches.length,
      avgBatchThroughput: throughputs.length > 0
        ? throughputs.reduce((a, b) => a + b, 0) / throughputs.length
        : 0,
      minBatchThroughput: throughputs.length > 0 ? Math.min(...throughputs) : 0,
      maxBatchThroughput: throughputs.length > 0 ? Math.max(...throughputs) : 0
    }
  }
}

/**
 * Wait for a specified duration (useful for testing throttling)
 */
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run GC if available (requires --expose-gc flag)
 */
export function forceGC() {
  if (global.gc) {
    global.gc()
    return true
  }
  return false
}

/**
 * Benchmark a function multiple times and return statistics
 */
export async function benchmark(fn, iterations = 10, warmupIterations = 2) {
  // Warmup
  for (let i = 0; i < warmupIterations; i++) {
    await fn()
  }

  // Actual benchmark
  const durations = []
  for (let i = 0; i < iterations; i++) {
    const { duration } = await measureTime(fn)
    durations.push(duration)
  }

  durations.sort((a, b) => a - b)

  return {
    iterations,
    min: durations[0],
    max: durations[durations.length - 1],
    mean: durations.reduce((a, b) => a + b, 0) / durations.length,
    median: durations[Math.floor(durations.length / 2)],
    p95: durations[Math.floor(durations.length * 0.95)],
    stdDev: calculateStdDev(durations)
  }
}

function calculateStdDev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2))
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length)
}

/**
 * Assert that a duration is within expected bounds
 */
export function assertDuration(actualMs, maxMs, message = '') {
  if (actualMs > maxMs) {
    throw new Error(
      `Duration exceeded: ${actualMs.toFixed(1)}ms > ${maxMs}ms ${message}`
    )
  }
}

/**
 * Assert that throughput meets minimum requirement
 */
export function assertThroughput(actualItemsPerSec, minItemsPerSec, message = '') {
  if (actualItemsPerSec < minItemsPerSec) {
    throw new Error(
      `Throughput too low: ${actualItemsPerSec.toFixed(1)}/s < ${minItemsPerSec}/s ${message}`
    )
  }
}

/**
 * Assert that memory usage is within bounds
 */
export function assertMemory(actualMB, maxMB, message = '') {
  if (actualMB > maxMB) {
    throw new Error(
      `Memory exceeded: ${actualMB.toFixed(1)}MB > ${maxMB}MB ${message}`
    )
  }
}
