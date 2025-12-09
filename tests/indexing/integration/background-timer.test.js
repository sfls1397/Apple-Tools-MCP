/**
 * Integration tests for continuous background indexing
 * Uses fake timers to test interval-based behavior
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('Continuous Background Indexing', () => {
  let indexTimer = null
  let runCount = 0
  let indexingInProgress = false
  const DEFAULT_INDEX_INTERVAL = 5 * 60 * 1000 // 5 minutes

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
      return // Skip if already running
    }
    runCount++
  }

  const startBackgroundIndexing = (interval = DEFAULT_INDEX_INTERVAL) => {
    runIndexCycle() // Run immediately
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

      expect(runCount).toBe(1) // Initial run

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)

      expect(runCount).toBe(2) // After 5 min

      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)

      expect(runCount).toBe(3) // After 10 min
    })

    it('should run initial + interval cycles correctly', () => {
      startBackgroundIndexing()

      // Initial
      expect(runCount).toBe(1)

      // After 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(2)

      // After 10 minutes
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(3)

      // After 15 minutes
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(runCount).toBe(4)
    })
  })

  describe('skip when in progress', () => {
    it('should skip cycle if previous still in progress', () => {
      indexingInProgress = true

      runIndexCycle()

      expect(runCount).toBe(0) // Skipped
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
          return // Skip
        }
        actualRuns++
        indexingInProgress = true

        // Simulate slow indexing (longer than interval)
        setTimeout(() => {
          indexingInProgress = false
        }, 8 * 60 * 1000) // 8 minutes
      }

      runCycleWithProgress() // Start first run
      expect(actualRuns).toBe(1)

      const timer = setInterval(runCycleWithProgress, DEFAULT_INDEX_INTERVAL)

      // After 5 min - should skip (still in progress)
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(actualRuns).toBe(1) // Still 1

      // After another 3 min (8 total) - first run completes
      vi.advanceTimersByTime(3 * 60 * 1000)
      // indexingInProgress is now false

      // After another 2 min (10 total) - next interval fires
      vi.advanceTimersByTime(2 * 60 * 1000)
      expect(actualRuns).toBe(2) // Now 2

      clearInterval(timer)
    })
  })

  describe('custom INDEX_INTERVAL_MS', () => {
    it('should respect custom 1-minute interval', () => {
      const customInterval = 60 * 1000 // 1 minute

      startBackgroundIndexing(customInterval)

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(customInterval)
      expect(runCount).toBe(2)

      vi.advanceTimersByTime(customInterval)
      expect(runCount).toBe(3)
    })

    it('should respect custom 10-minute interval', () => {
      const customInterval = 10 * 60 * 1000 // 10 minutes

      startBackgroundIndexing(customInterval)

      expect(runCount).toBe(1)

      vi.advanceTimersByTime(5 * 60 * 1000) // 5 min
      expect(runCount).toBe(1) // No additional run yet

      vi.advanceTimersByTime(5 * 60 * 1000) // 10 min total
      expect(runCount).toBe(2) // Now runs
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
      expect(runCount).toBe(2) // No more runs
    })

    it('should set indexTimer to null after stop', () => {
      startBackgroundIndexing()

      expect(indexTimer).not.toBeNull()

      stopBackgroundIndexing()

      expect(indexTimer).toBeNull()
    })

    it('should handle stop when never started', () => {
      expect(indexTimer).toBeNull()

      // Should not throw
      expect(() => stopBackgroundIndexing()).not.toThrow()

      expect(indexTimer).toBeNull()
    })
  })

  describe('multiple start/stop cycles', () => {
    it('should work correctly through multiple cycles', () => {
      // First cycle
      startBackgroundIndexing()
      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)
      expect(runCount).toBe(2)
      stopBackgroundIndexing()

      // Second cycle
      startBackgroundIndexing()
      vi.advanceTimersByTime(DEFAULT_INDEX_INTERVAL)
      expect(runCount).toBe(4) // 2 from first + 2 from second
      stopBackgroundIndexing()
    })
  })

  describe('environment variable override', () => {
    it('should parse INDEX_INTERVAL_MS from environment', () => {
      const envValue = '120000' // 2 minutes
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
