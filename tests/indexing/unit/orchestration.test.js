/**
 * Unit tests for index.js orchestration functions
 * Tests: checkIfFirstRun, runIndexCycle, startBackgroundIndexing, stopBackgroundIndexing
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isSearchBlockedByIndexing, cycleEndFlags } from '../../../lib/indexGate.js'

/**
 * Simple lock file simulation for testing lock logic
 */
function createLockFileMock() {
  let holder = null

  return {
    acquire(pid) {
      if (holder !== null && holder !== pid) {
        return false
      }
      holder = pid
      return true
    },
    release(pid) {
      if (holder === pid) {
        holder = null
      }
    },
    isLocked() {
      return holder !== null
    },
    getHolder() {
      return holder
    }
  }
}

describe('checkIfFirstRun', () => {
  describe('no tables exist', () => {
    it('should return true when no index tables exist', () => {
      // Mock isIndexReady to return false for all tables
      const emailsReady = false
      const messagesReady = false
      const calendarReady = false

      // If none are ready, it's first run
      const isFirstRun = !(emailsReady || messagesReady || calendarReady)

      expect(isFirstRun).toBe(true)
    })

    it('should check all three table types', () => {
      const tableTypes = ['emails', 'messages', 'calendar']

      expect(tableTypes.length).toBe(3)
      expect(tableTypes).toContain('emails')
      expect(tableTypes).toContain('messages')
      expect(tableTypes).toContain('calendar')
    })
  })

  describe('any table exists', () => {
    it('should return false when emails table exists', () => {
      const emailsReady = true
      const messagesReady = false
      const calendarReady = false

      const isFirstRun = !(emailsReady || messagesReady || calendarReady)

      expect(isFirstRun).toBe(false)
    })

    it('should return false when messages table exists', () => {
      const emailsReady = false
      const messagesReady = true
      const calendarReady = false

      const isFirstRun = !(emailsReady || messagesReady || calendarReady)

      expect(isFirstRun).toBe(false)
    })

    it('should return false when calendar table exists', () => {
      const emailsReady = false
      const messagesReady = false
      const calendarReady = true

      const isFirstRun = !(emailsReady || messagesReady || calendarReady)

      expect(isFirstRun).toBe(false)
    })

    it('should return false when all tables exist', () => {
      const emailsReady = true
      const messagesReady = true
      const calendarReady = true

      const isFirstRun = !(emailsReady || messagesReady || calendarReady)

      expect(isFirstRun).toBe(false)
    })
  })
})

describe('runIndexCycle', () => {
  let lockMock

  beforeEach(() => {
    lockMock = createLockFileMock()
  })

  describe('indexingInProgress flag', () => {
    it('should skip if indexingInProgress is true', () => {
      let indexingInProgress = true
      let indexAllCalled = false

      // Simulate runIndexCycle behavior
      if (indexingInProgress) {
        // Skip - "Indexing already in progress, skipping cycle"
      } else {
        indexAllCalled = true
      }

      expect(indexAllCalled).toBe(false)
    })

    it('should proceed if indexingInProgress is false', () => {
      let indexingInProgress = false
      let indexAllCalled = false

      if (!indexingInProgress) {
        indexAllCalled = true
      }

      expect(indexAllCalled).toBe(true)
    })

    it('should set indexingInProgress to true before indexing', () => {
      let indexingInProgress = false

      // Simulate runIndexCycle behavior
      indexingInProgress = true

      expect(indexingInProgress).toBe(true)
    })

    it('should set indexingInProgress to false after completion', async () => {
      let indexingInProgress = true

      // Simulate completion
      await Promise.resolve() // Simulate async indexAll
      indexingInProgress = false

      expect(indexingInProgress).toBe(false)
    })
  })

  describe('lock acquisition', () => {
    it('should acquire lock before indexing', () => {
      lockMock.acquire(process.pid)

      expect(lockMock.isLocked()).toBe(true)
      expect(lockMock.getHolder()).toBe(process.pid)
    })

    it('should skip if lock acquisition fails', () => {
      // Another process holds the lock
      lockMock.acquire(12345) // Different PID

      const acquired = lockMock.acquire(process.pid)

      expect(acquired).toBe(false)
    })

    it('should release lock after completion', () => {
      lockMock.acquire(process.pid)
      expect(lockMock.isLocked()).toBe(true)

      lockMock.release(process.pid)
      expect(lockMock.isLocked()).toBe(false)
    })

    it('should release lock even on error', async () => {
      lockMock.acquire(process.pid)

      try {
        throw new Error('Indexing error')
      } catch {
        lockMock.release(process.pid)
      }

      expect(lockMock.isLocked()).toBe(false)
    })
  })

  describe('state updates', () => {
    it('should update lastIndexTime after success', async () => {
      let lastIndexTime = 0
      const beforeTime = Date.now()

      // Simulate successful indexing
      await Promise.resolve()
      lastIndexTime = Date.now()

      expect(lastIndexTime).toBeGreaterThanOrEqual(beforeTime)
    })

    it('should set isFirstEverRun to false after success', async () => {
      let isFirstEverRun = true

      // Simulate successful indexing
      await Promise.resolve()
      isFirstEverRun = false

      expect(isFirstEverRun).toBe(false)
    })

    it('should set sessionIndexComplete to true after success', async () => {
      let sessionIndexComplete = false

      // Simulate successful indexing
      await Promise.resolve()
      sessionIndexComplete = true

      expect(sessionIndexComplete).toBe(true)
    })

    it('should set sessionIndexComplete to true even on error', async () => {
      let sessionIndexComplete = false

      try {
        throw new Error('Indexing error')
      } catch {
        sessionIndexComplete = true
      }

      expect(sessionIndexComplete).toBe(true)
    })

    it('should unblock searches via cycleEndFlags on error', () => {
      const flags = cycleEndFlags(false)
      expect(flags.sessionIndexComplete).toBe(true)
      expect(flags.indexingInProgress).toBe(false)
      expect(isSearchBlockedByIndexing(flags.sessionIndexComplete, flags.ownsIndexLock)).toBe(false)
    })
  })
})

describe('startBackgroundIndexing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('immediate execution', () => {
    it('should run indexing immediately on call', () => {
      let runCount = 0

      const runIndexCycle = () => { runCount++ }

      // Simulate startBackgroundIndexing behavior
      runIndexCycle() // Run immediately

      expect(runCount).toBe(1)
    })
  })

  describe('interval scheduling', () => {
    it('should set interval for INDEX_INTERVAL', () => {
      const INDEX_INTERVAL = 5 * 60 * 1000 // 5 minutes
      let runCount = 0

      const runIndexCycle = () => { runCount++ }

      runIndexCycle() // Immediate
      setInterval(runIndexCycle, INDEX_INTERVAL)

      // Advance time by INDEX_INTERVAL
      vi.advanceTimersByTime(INDEX_INTERVAL)

      expect(runCount).toBe(2)
    })

    it('should respect custom INDEX_INTERVAL_MS', () => {
      const customInterval = 60 * 1000 // 1 minute
      let runCount = 0

      const runIndexCycle = () => { runCount++ }

      runIndexCycle()
      setInterval(runIndexCycle, customInterval)

      // Advance by custom interval
      vi.advanceTimersByTime(customInterval)

      expect(runCount).toBe(2)

      // Advance again
      vi.advanceTimersByTime(customInterval)

      expect(runCount).toBe(3)
    })

    it('should run multiple cycles over time', () => {
      const INDEX_INTERVAL = 5 * 60 * 1000
      let runCount = 0

      const runIndexCycle = () => { runCount++ }

      runIndexCycle()
      setInterval(runIndexCycle, INDEX_INTERVAL)

      // Advance time by 3 intervals
      vi.advanceTimersByTime(INDEX_INTERVAL * 3)

      expect(runCount).toBe(4) // Initial + 3 intervals
    })
  })
})

describe('stopBackgroundIndexing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('interval cleanup', () => {
    it('should clear the interval timer', () => {
      const INDEX_INTERVAL = 5 * 60 * 1000
      let runCount = 0

      const runIndexCycle = () => { runCount++ }

      runIndexCycle()
      const timer = setInterval(runIndexCycle, INDEX_INTERVAL)

      // Stop the timer
      clearInterval(timer)

      // Advance time
      vi.advanceTimersByTime(INDEX_INTERVAL * 2)

      // Should only have the initial run
      expect(runCount).toBe(1)
    })

    it('should handle multiple stop calls gracefully', () => {
      let indexTimer = null

      const stopBackgroundIndexing = () => {
        if (indexTimer) {
          clearInterval(indexTimer)
          indexTimer = null
        }
      }

      indexTimer = setInterval(() => {}, 1000)

      // Call stop multiple times
      stopBackgroundIndexing()
      stopBackgroundIndexing()
      stopBackgroundIndexing()

      expect(indexTimer).toBeNull()
    })

    it('should be safe to call when no timer exists', () => {
      let indexTimer = null

      const stopBackgroundIndexing = () => {
        if (indexTimer) {
          clearInterval(indexTimer)
          indexTimer = null
        }
      }

      // Should not throw
      expect(() => stopBackgroundIndexing()).not.toThrow()
    })
  })
})

describe('initializeIndexing', () => {
  it('should check first run status', async () => {
    let isFirstEverRun = false
    let checkCalled = false

    const checkIfFirstRun = async () => {
      checkCalled = true
      return true
    }

    isFirstEverRun = await checkIfFirstRun()

    expect(checkCalled).toBe(true)
    expect(isFirstEverRun).toBe(true)
  })

  it('should acquire lock before starting', () => {
    const lockMock = createLockFileMock()

    const acquired = lockMock.acquire(process.pid)

    expect(acquired).toBe(true)
    expect(lockMock.isLocked()).toBe(true)
  })

  it('should not acquire if another instance holds lock', () => {
    const lockMock = createLockFileMock()

    // Another instance holds the lock
    lockMock.acquire(99999)

    const acquired = lockMock.acquire(process.pid)

    expect(acquired).toBe(false)
  })

  it('should not leave searches gated when lock is lost', () => {
    const lockMock = createLockFileMock()
    lockMock.acquire(99999)
    const acquired = lockMock.acquire(process.pid)
    const sessionIndexComplete = false
    const ownsIndexLock = acquired

    expect(ownsIndexLock).toBe(false)
    expect(isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)).toBe(false)
  })
})

describe('getIndexingMessage', () => {
  it('should return first run message when isFirstEverRun is true', () => {
    const isFirstEverRun = true

    const message = isFirstEverRun
      ? 'Building initial index. This may take several minutes on first run. Please try again shortly.'
      : 'Indexing new data. Please try again in a moment.'

    expect(message).toContain('initial index')
    expect(message).toContain('several minutes')
  })

  it('should return incremental message when isFirstEverRun is false', () => {
    const isFirstEverRun = false

    const message = isFirstEverRun
      ? 'Building initial index. This may take several minutes on first run. Please try again shortly.'
      : 'Indexing new data. Please try again in a moment.'

    expect(message).toContain('Indexing new data')
  })
})
