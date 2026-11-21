
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import {
  checkDataSources,
  isProductionIndexReady,
  searchProductionIndex,
  embed,
  embedBatch,
  getProductionIndexStats,
  PRODUCTION_INDEX_DIR
} from '../helpers/real-data.js'

const sources = checkDataSources()

function getMemoryUsage() {
  const used = process.memoryUsage()
  return {
    heapUsed: Math.round(used.heapUsed / 1024 / 1024),
    heapTotal: Math.round(used.heapTotal / 1024 / 1024),
    external: Math.round(used.external / 1024 / 1024),
    rss: Math.round(used.rss / 1024 / 1024)
  }
}

describe.skipIf(!sources.embedder)('Memory Usage', () => {
  describe('Embedding Memory', () => {
    it('should measure memory during embedding generation', async () => {
      if (global.gc) global.gc()

      const beforeMem = getMemoryUsage()

      const texts = Array.from({ length: 20 }, (_, i) =>
        `Test email ${i}: This is sample content for memory testing purposes with reasonable length text.`
      )

      const vectors = await embedBatch(texts)

      const afterMem = getMemoryUsage()
      const heapGrowth = afterMem.heapUsed - beforeMem.heapUsed

      console.log('Memory during embedding:')
      console.log(`  Before: ${beforeMem.heapUsed}MB heap, ${beforeMem.rss}MB RSS`)
      console.log(`  After: ${afterMem.heapUsed}MB heap, ${afterMem.rss}MB RSS`)
      console.log(`  Heap growth: ${heapGrowth}MB`)

      expect(vectors).toHaveLength(texts.length)

      expect(heapGrowth).toBeLessThan(500)
    }, 60000)

    it('should not leak memory during repeated embeddings', async () => {
      if (global.gc) global.gc()

      const initialMem = getMemoryUsage()
      const memSamples = []

      for (let batch = 0; batch < 5; batch++) {
        const texts = Array.from({ length: 10 }, (_, i) =>
          `Batch ${batch} text ${i}: Content for leak testing`
        )

        await embedBatch(texts)
        memSamples.push(getMemoryUsage().heapUsed)
      }

      if (global.gc) global.gc()
      const finalMem = getMemoryUsage()

      const totalGrowth = finalMem.heapUsed - initialMem.heapUsed

      console.log('Memory leak check:')
      console.log(`  Initial: ${initialMem.heapUsed}MB`)
      console.log(`  Samples: ${memSamples.join(', ')}MB`)
      console.log(`  Final: ${finalMem.heapUsed}MB`)
      console.log(`  Total growth: ${totalGrowth}MB`)

      expect(totalGrowth).toBeLessThan(200)
    }, 120000)
  })
})

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
  'Search Resource Usage',
  () => {
    beforeAll(async () => {
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error('Production index not found. Run "npm run rebuild-index" first.')
      }
    }, 30000)

    it('should measure memory during searches', async () => {
      if (global.gc) global.gc()

      const beforeMem = getMemoryUsage()

      const queries = [
        'meeting',
        'project',
        'deadline',
        'update',
        'review',
        'important',
        'urgent',
        'schedule',
        'team',
        'discussion'
      ]

      for (const query of queries) {
        await searchProductionIndex(query, 'emails', 10)
      }

      const afterMem = getMemoryUsage()
      const heapGrowth = afterMem.heapUsed - beforeMem.heapUsed

      console.log(`Memory for ${queries.length} searches: ${heapGrowth}MB growth`)

      expect(heapGrowth).toBeLessThan(100)
    }, 120000)

    it('should handle sustained search load', async () => {
      const startMem = getMemoryUsage()
      const startTime = performance.now()

      const queries = ['meeting', 'project', 'email', 'update', 'schedule']
      let queryCount = 0

      while (performance.now() - startTime < 10000 && queryCount < 50) {
        const query = queries[queryCount % queries.length]
        await searchProductionIndex(query, 'emails', 5)
        queryCount++
      }

      const endMem = getMemoryUsage()
      const duration = performance.now() - startTime

      console.log('Sustained search load:')
      console.log(`  Queries: ${queryCount}`)
      console.log(`  Duration: ${(duration/1000).toFixed(1)}s`)
      console.log(`  Rate: ${(queryCount / (duration/1000)).toFixed(1)} queries/sec`)
      console.log(`  Memory growth: ${endMem.heapUsed - startMem.heapUsed}MB`)

      expect(queryCount).toBeGreaterThan(0)
    }, 60000)
  }
)

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
  'Disk Usage',
  () => {
    beforeAll(async () => {
      const ready = await isProductionIndexReady()
      if (!ready) {
        throw new Error('Production index not found. Run "npm run rebuild-index" first.')
      }
    }, 30000)

    it('should report index size on disk', () => {
      const getDirectorySize = (dir) => {
        let size = 0
        const files = fs.readdirSync(dir)
        for (const file of files) {
          const filepath = `${dir}/${file}`
          const stat = fs.statSync(filepath)
          if (stat.isDirectory()) {
            size += getDirectorySize(filepath)
          } else {
            size += stat.size
          }
        }
        return size
      }

      if (fs.existsSync(PRODUCTION_INDEX_DIR)) {
        const sizeBytes = getDirectorySize(PRODUCTION_INDEX_DIR)
        const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2)

        console.log(`Production index size: ${sizeMB}MB`)

        expect(sizeBytes).toBeGreaterThan(0)
      }
    })

    it('should correlate index size with item count', async () => {
      const stats = await getProductionIndexStats()
      const totalItems = stats.emails + stats.messages + stats.calendar

      if (fs.existsSync(PRODUCTION_INDEX_DIR)) {
        const getDirectorySize = (dir) => {
          let size = 0
          const files = fs.readdirSync(dir)
          for (const file of files) {
            const filepath = `${dir}/${file}`
            const stat = fs.statSync(filepath)
            if (stat.isDirectory()) {
              size += getDirectorySize(filepath)
            } else {
              size += stat.size
            }
          }
          return size
        }

        const sizeBytes = getDirectorySize(PRODUCTION_INDEX_DIR)
        const bytesPerItem = totalItems > 0 ? sizeBytes / totalItems : 0

        console.log(`Index stats:`)
        console.log(`  Items: ${totalItems}`)
        console.log(`  Size: ${(sizeBytes / 1024 / 1024).toFixed(2)}MB`)
        console.log(`  Bytes per item: ${bytesPerItem.toFixed(0)}`)

        if (totalItems > 0) {
          expect(bytesPerItem).toBeLessThan(10000)
        }
      }
    })
  }
)

describe.skipIf(!sources.embedder)('CPU Throttling', () => {
  it.skip('should yield between batch operations', async () => {
    let mainThreadUnblocked = false

    const timer = setTimeout(() => {
      mainThreadUnblocked = true
    }, 500)

    const texts = Array.from({ length: 5 }, (_, i) => `Test text ${i}`)
    await embedBatch(texts)

    await new Promise(r => setTimeout(r, 100))
    clearTimeout(timer)

    if (!mainThreadUnblocked) {
      console.warn('⚠️  Event loop may have been blocked during embeddings (timing-sensitive test)')
    }
    expect(mainThreadUnblocked).toBe(true)
  }, 60000)

  it('should measure CPU time for embeddings', async () => {
    const startCpu = process.cpuUsage()
    const startTime = performance.now()

    const texts = Array.from({ length: 5 }, (_, i) =>
      `CPU test text ${i}: This is content for measuring CPU usage`
    )

    await embedBatch(texts)

    const endCpu = process.cpuUsage(startCpu)
    const wallTime = performance.now() - startTime

    const cpuTime = (endCpu.user + endCpu.system) / 1000
    const cpuUtilization = (cpuTime / wallTime) * 100

    console.log('CPU usage for embeddings:')
    console.log(`  Wall time: ${wallTime.toFixed(0)}ms`)
    console.log(`  CPU time: ${cpuTime.toFixed(0)}ms`)
    console.log(`  Utilization: ${cpuUtilization.toFixed(1)}%`)

    expect(cpuTime).toBeGreaterThan(0)
  }, 60000)
})
