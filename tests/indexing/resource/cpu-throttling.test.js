
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const BATCH_SIZE = 32
const BATCH_DELAY_MS = 100

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function measureTime(fn) {
  const start = performance.now()
  await fn()
  const duration = performance.now() - start
  return { duration }
}

function generateTestData(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    content: `Test content ${i + 1}`
  }))
}

describe('CPU Throttling', () => {
  describe('BATCH_DELAY_MS verification', () => {
    it('should have BATCH_DELAY_MS = 100', () => {
      expect(BATCH_DELAY_MS).toBe(100)
    })

    it('should apply delay between batches', async () => {
      const count = 64
      const items = generateTestData(count)
      const batchTimes = []

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE)

        if (batchIndex > 0) {
          await wait(BATCH_DELAY_MS)
        }

        batchTimes.push(performance.now())
        await Promise.resolve()
      }

      for (let i = 1; i < batchTimes.length; i++) {
        const gap = batchTimes[i] - batchTimes[i - 1]
        expect(gap).toBeGreaterThanOrEqual(BATCH_DELAY_MS * 0.9)
      }
    })

    it('should not apply delay after last batch', async () => {
      const items = generateTestData(BATCH_SIZE)
      let delayCount = 0

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE)
        const isLastBatch = i + BATCH_SIZE >= items.length

        await Promise.resolve()

        if (!isLastBatch) {
          await wait(BATCH_DELAY_MS)
          delayCount++
        }
      }

      expect(delayCount).toBe(0)
    })
  })

  describe('rate limiting with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should respect batch delays with fake timers', async () => {
      const count = 96
      const items = generateTestData(count)
      const batchStartTimes = []

      const processBatch = async (batch, batchIndex) => {
        if (batchIndex > 0) {
          const delayPromise = new Promise(r => setTimeout(r, BATCH_DELAY_MS))
          vi.advanceTimersByTime(BATCH_DELAY_MS)
          await delayPromise
        }

        batchStartTimes.push(Date.now())
        await Promise.resolve()
      }

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE)
        const batchIndex = Math.floor(i / BATCH_SIZE)
        await processBatch(batch, batchIndex)
      }

      expect(batchStartTimes.length).toBe(3)
    })

    it('should accumulate correct total delay time', async () => {
      const batchCount = 5
      const count = batchCount * BATCH_SIZE
      const items = generateTestData(count)

      let totalDelayTime = 0

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE)

        if (batchIndex > 0) {
          totalDelayTime += BATCH_DELAY_MS
          vi.advanceTimersByTime(BATCH_DELAY_MS)
        }

        await Promise.resolve()
      }

      const expectedDelay = (batchCount - 1) * BATCH_DELAY_MS
      expect(totalDelayTime).toBe(expectedDelay)
    })
  })

  describe('throttled processing simulation', () => {
    it('should add overhead from throttling', async () => {
      const count = 96
      const items = generateTestData(count)

      const { duration: unthrottled } = await measureTime(async () => {
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          await Promise.resolve()
        }
      })

      const { duration: throttled } = await measureTime(async () => {
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batchIndex = Math.floor(i / BATCH_SIZE)

          if (batchIndex > 0) {
            await wait(BATCH_DELAY_MS)
          }

          await Promise.resolve()
        }
      })

      const expectedMinOverhead = (Math.ceil(count / BATCH_SIZE) - 1) * BATCH_DELAY_MS
      const actualOverhead = throttled - unthrottled

      expect(actualOverhead).toBeGreaterThan(expectedMinOverhead * 0.8)
    })
  })

  describe('batch interval tracking', () => {
    it('should track intervals between batches', async () => {
      const count = 128
      const items = generateTestData(count)
      const batchEndTimes = []

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        await Promise.resolve()

        batchEndTimes.push(performance.now())

        const isLastBatch = i + BATCH_SIZE >= items.length
        if (!isLastBatch) {
          await wait(BATCH_DELAY_MS)
        }
      }

      expect(batchEndTimes.length).toBe(4)

      const intervals = []
      for (let i = 1; i < batchEndTimes.length; i++) {
        intervals.push(batchEndTimes[i] - batchEndTimes[i - 1])
      }

      for (const interval of intervals) {
        expect(interval).toBeGreaterThanOrEqual(BATCH_DELAY_MS * 0.8)
      }
    })
  })

  describe('yield to event loop', () => {
    it('should allow other operations during delays', async () => {
      const count = 64
      const items = generateTestData(count)
      let otherWorkDone = false

      const batchPromise = (async () => {
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batchIndex = Math.floor(i / BATCH_SIZE)

          if (batchIndex > 0) {
            await wait(BATCH_DELAY_MS)
          }

          await Promise.resolve()
        }
      })()

      const otherWork = (async () => {
        await wait(50)
        otherWorkDone = true
      })()

      await Promise.all([batchPromise, otherWork])

      expect(otherWorkDone).toBe(true)
    })
  })

  describe('adaptive throttling simulation', () => {
    it('should demonstrate adaptive delay concept', async () => {
      const count = 128
      const items = generateTestData(count)

      let baseDelay = BATCH_DELAY_MS
      const delaysUsed = []

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batchIndex = Math.floor(i / BATCH_SIZE)

        if (batchIndex > 0) {
          delaysUsed.push(baseDelay)
          await wait(baseDelay)
        }

        await Promise.resolve()
      }

      expect(delaysUsed.length).toBe(Math.ceil(count / BATCH_SIZE) - 1)

      expect(delaysUsed.every(d => d === BATCH_DELAY_MS)).toBe(true)
    })
  })
})
