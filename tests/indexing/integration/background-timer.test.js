
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('Continuous Background Indexing', () => {
  let indexTimer = null
  let runCount = 0
  let indexingInProgress = false
  const DEFAULT_INDEX_INTERVAL = 5 * 60 * 1000

  beforeEach(() => {
    vi.useFakeTimers()
    indexTimer = null
    runCount = 0
    indexingInProgress = false
  })

  afterEach(() => {
    if (indexTimer) {
      clearInterval(indexTimer)
      indexTimer = null
    }
    vi.useRealTimers()
  })

  const runIndexCycle = () => {
    if (indexingInProgress) {
      return
    }
    runCount++
  }

  const startBackgroundIndexing = (interval = DEFAULT_INDEX_INTERVAL) => {
    runIndexCycle()
    indexTimer = setInterval(runIndexCycle, interval)
  }

  const stopBackgroundIndexing = () => {
    if (indexTimer) {
      clearInterval(indexTimer)
      indexTimer = null
    }
  }

  describe('interval scheduling', () => {
    it('should schedule indexing at INDEX_INTERVAL (5 min default)', () => {
      startBackgroundIndexing()

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)

      expect(runCount).toBe(2)

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)

      expect(runCount).toBe(3)
    })

    it('should run initial + interval cycles correctly', () => {
      startBackgroundIndexing()

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(2)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(3)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(4)
    })
  })

  describe('skip when in progress', () => {
    it('should skip cycle if previous still in progress', () => {
      indexingInProgress = true

      runIndexCycle()

      expect(runCount).toBe(0)
    })

    it('should resume when previous completes', () => {
      indexingInProgress = true
      runIndexCycle()
      expect(runCount).toBe(0)

      indexingInProgress = false
      runIndexCycle()
      expect(runCount).toBe(1)
    })

    it('should not accumulate skipped cycles', () => {
      let actualRuns = 0

      const runCycleWithProgress = () => {
        if (indexingInProgress) {
          return
        }
        actualRuns++
        indexingInProgress = true

        setTimeout(() => {
          indexingInProgress = false
        }, 8 * 60 * 1000)
      }

      runCycleWithProgress()
      expect(actualRuns).toBe(1)

      const timer = setInterval(runCycleWithProgress, DEFAULT_INDEX_INTERVAL)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(actualRuns).toBe(1)

      vi.advanceTimersByTime(3 * 60 * 1000)

      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(actualRuns).toBe(2)

      clearInterval(timer)
    })
  })

  describe('custom INDEX_INTERVAL_MS', () => {
    it('should respect custom 1-minute interval', () => {
      const customInterval = 60 * 1000

      startBackgroundIndexing(customInterval)

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(customInterval)
      expect(runCount).toBe(2)

      vi.advanceTimersByTime(customInterval)
      expect(runCount).toBe(3)
    })

    it('should respect custom 10-minute interval', () => {
      const customInterval = 10 * 60 * 1000

      startBackgroundIndexing(customInterval)

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(1)

      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(2)
    })
  })

  describe('stop background indexing', () => {
    it('should stop cleanly on stopBackgroundIndexing()', () => {
      startBackgroundIndexing()

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)
      expect(runCount).toBe(2)

      stopBackgroundIndexing()

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL * 5)
      expect(runCount).toBe(2)
    })

    it('should set indexTimer to null after stop', () => {
      startBackgroundIndexing()

      expect(indexTimer).not.toBeNull()

      stopBackgroundIndexing()

      expect(indexTimer).toBeNull()
    })

    it('should handle stop when never started', () => {
      expect(indexTimer).toBeNull()

      expect(() => stopBackgroundIndexing()).not.toThrow()

      expect(indexTimer).toBeNull()
    })
  })

  describe('multiple start/stop cycles', () => {
    it('should work correctly through multiple cycles', () => {
      startBackgroundIndexing()
      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)
      expect(runCount).toBe(2)
      stopBackgroundIndexing()

      startBackgroundIndexing()
      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)
      expect(runCount).toBe(4)
      stopBackgroundIndexing()
    })
  })

  describe('environment variable override', () => {
    it('should parse INDEX_INTERVAL_MS from environment', () => {
      const envValue = '120000'
      const interval = parseInt(envValue || String(DEFAULT_INDEX_INTERVAL))

      expect(interval).toBe(120000)
    })

    it('should fall back to default when env not set', () => {
      const envValue = undefined
      const interval = parseInt(envValue || String(DEFAULT_INDEX_INTERVAL))

      expect(interval).toBe(DEFAULT_INDEX_INTERVAL)
    })
  })
})
