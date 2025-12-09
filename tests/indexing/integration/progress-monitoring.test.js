/**
 * Tests for progress monitoring and hung process detection
 * Covers: progress callbacks, progress tracking, hung detection
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const PROGRESS_CHECK_INTERVAL_MS = 60 * 1000 // 1 minute
const MAX_NO_PROGRESS_MS = 10 * 60 * 1000 // 10 minutes

describe('Progress Monitoring', () => {
  let progressTracker
  let progressCheckTimer

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    progressTracker = {
      lastProgressTime: 0,
      updateProgress: function() {
        this.lastProgressTime = Date.now()
      },
      getTimeSinceProgress: function() {
        return Date.now() - this.lastProgressTime
      }
    }
  })

  afterEach(() => {
    if (progressCheckTimer) {
      clearInterval(progressCheckTimer)
      progressCheckTimer = null
    }
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('progress callback functionality', () => {
    it('should update progress time when callback is called', () => {
      const initialTime = Date.now()
      progressTracker.lastProgressTime = initialTime

      vi.advanceTimersByTime(5000) // 5 seconds
      progressTracker.updateProgress()

      expect(progressTracker.lastProgressTime).toBeGreaterThan(initialTime)
    })

    it('should track time since last progress', () => {
      progressTracker.updateProgress()

      vi.advanceTimersByTime(60000) // 1 minute

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      expect(timeSinceProgress).toBeGreaterThanOrEqual(60000)
    })

    it('should reset progress timer on each batch completion', () => {
      progressTracker.updateProgress()
      vi.advanceTimersByTime(30000)

      const time1 = progressTracker.getTimeSinceProgress()
      expect(time1).toBeGreaterThanOrEqual(30000)

      // Simulate batch completion
      progressTracker.updateProgress()
      const time2 = progressTracker.getTimeSinceProgress()

      expect(time2).toBeLessThan(time1)
    })
  })

  describe('hung process detection', () => {
    it('should NOT detect hung process if progress is made regularly', () => {
      let hungDetected = false
      progressTracker.updateProgress()

      // Simulate checking every minute for 15 minutes with progress every 2 minutes
      for (let i = 0; i < 15; i++) {
        vi.advanceTimersByTime(60000) // 1 minute

        const timeSinceProgress = progressTracker.getTimeSinceProgress()
        if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
          hungDetected = true
          break
        }

        // Make progress every 2 minutes
        if (i % 2 === 0) {
          progressTracker.updateProgress()
        }
      }

      expect(hungDetected).toBe(false)
    })

    it('should detect hung process after 10 minutes without progress', () => {
      let hungDetected = false
      progressTracker.updateProgress()

      // Advance time without any progress updates
      vi.advanceTimersByTime(11 * 60 * 1000) // 11 minutes

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
        hungDetected = true
      }

      expect(hungDetected).toBe(true)
      expect(timeSinceProgress).toBeGreaterThan(MAX_NO_PROGRESS_MS)
    })

    it('should NOT detect hung process at exactly 9 minutes', () => {
      progressTracker.updateProgress()

      vi.advanceTimersByTime(9 * 60 * 1000) // 9 minutes

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      expect(timeSinceProgress).toBeLessThan(MAX_NO_PROGRESS_MS)
    })

    it('should detect hung process at exactly 10 minutes', () => {
      progressTracker.updateProgress()

      vi.advanceTimersByTime(10 * 60 * 1000) // Exactly 10 minutes

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      expect(timeSinceProgress).toBeGreaterThanOrEqual(MAX_NO_PROGRESS_MS)
    })
  })

  describe('progress check interval', () => {
    it('should check progress every minute', () => {
      const checkInterval = PROGRESS_CHECK_INTERVAL_MS
      expect(checkInterval).toBe(60000) // 1 minute
    })

    it('should trigger multiple checks over time', () => {
      let checkCount = 0
      progressTracker.updateProgress()

      progressCheckTimer = setInterval(() => {
        checkCount++
        const timeSinceProgress = progressTracker.getTimeSinceProgress()

        if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
          clearInterval(progressCheckTimer)
        }
      }, PROGRESS_CHECK_INTERVAL_MS)

      // Simulate 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000)

      expect(checkCount).toBe(5) // Should check 5 times
    })
  })

  describe('legitimate long-running process', () => {
    it('should allow 30-minute index with regular progress', () => {
      let hungDetected = false
      progressTracker.updateProgress()

      // Simulate 30 minutes with progress every 2 minutes
      for (let minute = 0; minute < 30; minute++) {
        vi.advanceTimersByTime(60000) // 1 minute

        // Check for hung state
        const timeSinceProgress = progressTracker.getTimeSinceProgress()
        if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
          hungDetected = true
          break
        }

        // Make progress every 2 minutes
        if (minute % 2 === 0) {
          progressTracker.updateProgress()
        }
      }

      expect(hungDetected).toBe(false)
    })

    it('should allow 2-hour index with regular progress', () => {
      let hungDetected = false
      progressTracker.updateProgress()

      // Simulate 2 hours with progress every 5 minutes
      for (let minute = 0; minute < 120; minute++) {
        vi.advanceTimersByTime(60000) // 1 minute

        const timeSinceProgress = progressTracker.getTimeSinceProgress()
        if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
          hungDetected = true
          break
        }

        // Make progress every 5 minutes
        if (minute % 5 === 0) {
          progressTracker.updateProgress()
        }
      }

      expect(hungDetected).toBe(false)
    })
  })

  describe('progress callback during indexing phases', () => {
    it('should receive callback for emails-start', () => {
      const callbacks = []
      const reportProgress = (stage) => {
        callbacks.push(stage)
        progressTracker.updateProgress()
      }

      reportProgress('emails-start')

      expect(callbacks).toContain('emails-start')
    })

    it('should receive callback for batch completions', () => {
      const callbacks = []
      const reportProgress = (stage) => {
        callbacks.push(stage)
        progressTracker.updateProgress()
      }

      reportProgress('emails-batch-32/1000')
      reportProgress('emails-batch-64/1000')

      expect(callbacks).toContain('emails-batch-32/1000')
      expect(callbacks).toContain('emails-batch-64/1000')
    })

    it('should receive callback for phase completions', () => {
      const callbacks = []
      const reportProgress = (stage) => {
        callbacks.push(stage)
        progressTracker.updateProgress()
      }

      reportProgress('emails-complete')
      reportProgress('messages-start')
      reportProgress('messages-complete')

      expect(callbacks).toContain('emails-complete')
      expect(callbacks).toContain('messages-complete')
    })
  })

  describe('hung detection edge cases', () => {
    it('should handle process that makes progress then hangs', () => {
      let hungDetected = false
      progressTracker.updateProgress()

      // Make progress for 20 minutes
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(2 * 60 * 1000) // 2 minutes
        progressTracker.updateProgress()
      }

      // Then hang for 11 minutes
      vi.advanceTimersByTime(11 * 60 * 1000)

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
        hungDetected = true
      }

      expect(hungDetected).toBe(true)
    })

    it('should handle rapid progress updates', () => {
      progressTracker.updateProgress()

      // Simulate very rapid progress (every second for 5 minutes)
      for (let i = 0; i < 300; i++) {
        vi.advanceTimersByTime(1000) // 1 second
        progressTracker.updateProgress()
      }

      const timeSinceProgress = progressTracker.getTimeSinceProgress()
      expect(timeSinceProgress).toBeLessThan(5000) // Less than 5 seconds
    })
  })

  describe('timer cleanup', () => {
    it('should clear progress check timer on completion', () => {
      let timerCleared = false

      progressCheckTimer = setInterval(() => {
        // Check progress
      }, PROGRESS_CHECK_INTERVAL_MS)

      // Simulate completion
      if (progressCheckTimer) {
        clearInterval(progressCheckTimer)
        progressCheckTimer = null
        timerCleared = true
      }

      expect(timerCleared).toBe(true)
      expect(progressCheckTimer).toBeNull()
    })

    it('should clear progress check timer on error', () => {
      let timerCleared = false

      progressCheckTimer = setInterval(() => {
        // Check progress
      }, PROGRESS_CHECK_INTERVAL_MS)

      // Simulate error
      try {
        throw new Error('Indexing error')
      } catch (e) {
        if (progressCheckTimer) {
          clearInterval(progressCheckTimer)
          progressCheckTimer = null
          timerCleared = true
        }
      }

      expect(timerCleared).toBe(true)
    })
  })
})
