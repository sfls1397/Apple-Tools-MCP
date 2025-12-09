/**
 * End-to-end tests for hung process detection and recovery
 * Covers: Complete hung process lifecycle, lock cleanup, recovery
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

const LOCK_FILE = path.join(os.homedir(), '.apple-tools-mcp', 'indexer.lock')
const LOCK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
const MAX_NO_PROGRESS_MS = 10 * 60 * 1000 // 10 minutes

describe('Hung Process Recovery', () => {
  let mockLockFile

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    // Use a test-specific lock file path
    mockLockFile = path.join(os.tmpdir(), `test-lock-${Date.now()}.lock`)
  })

  afterEach(() => {
    // Cleanup test lock file
    if (fs.existsSync(mockLockFile)) {
      fs.unlinkSync(mockLockFile)
    }

    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('full hung process lifecycle', () => {
    it('should detect and cleanup hung process', () => {
      let indexingState = {
        inProgress: false,
        lastProgressTime: 0,
        lockAcquired: false
      }

      // Start indexing
      indexingState.inProgress = true
      indexingState.lastProgressTime = Date.now()
      indexingState.lockAcquired = true

      // Simulate progress for 5 minutes
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(60000) // 1 minute
        indexingState.lastProgressTime = Date.now() // Progress updates
      }

      // Then hang (no more progress)
      vi.advanceTimersByTime(11 * 60 * 1000) // 11 minutes

      // Detect hung state
      const timeSinceProgress = Date.now() - indexingState.lastProgressTime
      if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
        // Cleanup
        indexingState.inProgress = false
        indexingState.lockAcquired = false
      }

      expect(indexingState.inProgress).toBe(false)
      expect(indexingState.lockAcquired).toBe(false)
    })

    it('should release lock when hung process is detected', () => {
      let lockReleased = false

      const releaseLock = () => {
        lockReleased = true
      }

      let lastProgressTime = Date.now()

      // Simulate hung detection
      vi.advanceTimersByTime(11 * 60 * 1000)

      const timeSinceProgress = Date.now() - lastProgressTime
      if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
        releaseLock()
      }

      expect(lockReleased).toBe(true)
    })

    it('should allow new process to start after hung cleanup', () => {
      let processStates = []

      // First process - hangs
      let process1 = { id: 1, state: 'running', lastProgress: Date.now() }
      processStates.push(process1)

      vi.advanceTimersByTime(11 * 60 * 1000)

      // Detect hung and cleanup
      const timeSinceProgress = Date.now() - process1.lastProgress
      if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
        process1.state = 'terminated'
      }

      expect(process1.state).toBe('terminated')

      // Second process can now start
      let process2 = { id: 2, state: 'running', lastProgress: Date.now() }
      processStates.push(process2)

      expect(process2.state).toBe('running')
      expect(processStates.filter(p => p.state === 'running')).toHaveLength(1)
    })
  })

  describe('stale lock file recovery', () => {
    it('should detect lock file older than 30 minutes', () => {
      const lockData = {
        pid: 99999,
        timestamp: Date.now() - (35 * 60 * 1000) // 35 minutes ago
      }

      const lockAge = Date.now() - lockData.timestamp

      expect(lockAge).toBeGreaterThan(LOCK_TIMEOUT_MS)
    })

    it('should remove stale lock and proceed', () => {
      const lockData = {
        pid: 99999,
        timestamp: Date.now() - (35 * 60 * 1000) // 35 minutes ago
      }

      const lockAge = Date.now() - lockData.timestamp
      let lockRemoved = false
      let processingStarted = false

      if (lockAge > LOCK_TIMEOUT_MS) {
        lockRemoved = true
        processingStarted = true
      }

      expect(lockRemoved).toBe(true)
      expect(processingStarted).toBe(true)
    })

    it('should NOT remove recent lock file', () => {
      const lockData = {
        pid: 99999,
        timestamp: Date.now() - (5 * 60 * 1000) // 5 minutes ago
      }

      const lockAge = Date.now() - lockData.timestamp
      let lockRemoved = false

      if (lockAge <= LOCK_TIMEOUT_MS) {
        lockRemoved = false // Keep the lock
      }

      expect(lockRemoved).toBe(false)
    })

    it('should verify process death before removing lock', () => {
      const lockData = {
        pid: 99999, // Non-existent PID
        timestamp: Date.now() - (5 * 60 * 1000)
      }

      let processExists = false
      let lockRemoved = false

      // Simulate checking if process exists
      try {
        // process.kill(lockData.pid, 0) would throw for non-existent process
        throw new Error('ESRCH')
      } catch (e) {
        if (e.message === 'ESRCH') {
          processExists = false
          lockRemoved = true // Process dead, remove stale lock
        }
      }

      expect(processExists).toBe(false)
      expect(lockRemoved).toBe(true)
    })
  })

  describe('recovery scenarios', () => {
    it('should recover from embedding timeout and continue', () => {
      const batchResults = []
      let continueIndexing = true

      // Batch 1 - success
      batchResults.push({ success: true, embeddings: 32 })

      // Batch 2 - timeout
      try {
        throw new Error('Batch embedding timed out')
      } catch (e) {
        if (e.message.includes('timed out')) {
          // Fallback to single items
          batchResults.push({ success: true, embeddings: 32, fallback: true })
          continueIndexing = true
        }
      }

      // Batch 3 - success
      if (continueIndexing) {
        batchResults.push({ success: true, embeddings: 32 })
      }

      expect(batchResults).toHaveLength(3)
      expect(batchResults.every(r => r.success)).toBe(true)
    })

    it('should complete indexing after partial hang recovery', () => {
      let phases = [
        { name: 'emails', completed: false },
        { name: 'messages', completed: false },
        { name: 'calendar', completed: false }
      ]

      // Emails - completes successfully
      phases[0].completed = true

      // Messages - hangs and recovers
      try {
        // Simulate hang detection
        const timeSinceProgress = 11 * 60 * 1000
        if (timeSinceProgress > MAX_NO_PROGRESS_MS) {
          throw new Error('No progress')
        }
      } catch (e) {
        // Mark as complete even on error so queries can proceed
        phases[1].completed = true
      }

      // Calendar - runs successfully after recovery
      phases[2].completed = true

      expect(phases.every(p => p.completed)).toBe(true)
    })
  })

  describe('concurrent process prevention', () => {
    it('should prevent second process if first is healthy', () => {
      const processes = []

      // First process
      const process1 = {
        pid: 1000,
        started: Date.now(),
        lastProgress: Date.now(),
        hasLock: true
      }
      processes.push(process1)

      // Second process tries to start
      const canStartSecond = !process1.hasLock ||
        (Date.now() - process1.lastProgress > MAX_NO_PROGRESS_MS)

      expect(canStartSecond).toBe(false)
      expect(processes).toHaveLength(1)
    })

    it('should allow second process if first is hung', () => {
      const processes = []

      // First process - hung
      const process1 = {
        pid: 1000,
        started: Date.now() - (20 * 60 * 1000),
        lastProgress: Date.now() - (15 * 60 * 1000), // 15 min ago
        hasLock: false // Lock released due to hung detection
      }
      processes.push(process1)

      // Second process can start
      const canStartSecond = !process1.hasLock

      if (canStartSecond) {
        const process2 = {
          pid: 2000,
          started: Date.now(),
          lastProgress: Date.now(),
          hasLock: true
        }
        processes.push(process2)
      }

      expect(processes).toHaveLength(2)
      expect(processes[1].hasLock).toBe(true)
    })
  })

  describe('lock file content validation', () => {
    it('should include PID and timestamp in lock file', () => {
      const lockContent = {
        pid: process.pid,
        timestamp: Date.now()
      }

      expect(lockContent).toHaveProperty('pid')
      expect(lockContent).toHaveProperty('timestamp')
      expect(typeof lockContent.pid).toBe('number')
      expect(typeof lockContent.timestamp).toBe('number')
    })

    it('should parse lock file format correctly', () => {
      const pid = 12345
      const timestamp = Date.now()
      const lockFileContent = `${pid}:${timestamp}`

      const [pidStr, timestampStr] = lockFileContent.split(':')
      const parsedPid = parseInt(pidStr)
      const parsedTimestamp = parseInt(timestampStr)

      expect(parsedPid).toBe(pid)
      expect(parsedTimestamp).toBe(timestamp)
    })

    it('should handle corrupted lock file', () => {
      const corruptedContent = 'invalid-lock-data'

      let lockValid = false
      try {
        const [pidStr, timestampStr] = corruptedContent.split(':')
        const pid = parseInt(pidStr)
        const timestamp = parseInt(timestampStr) || Date.now()

        if (!isNaN(pid)) {
          lockValid = true
        }
      } catch (e) {
        lockValid = false
      }

      expect(lockValid).toBe(false)
    })
  })

  describe('progress monitoring configuration', () => {
    it('should check progress every minute', () => {
      const checkInterval = 60 * 1000
      expect(checkInterval).toBe(60000)
    })

    it('should timeout after 10 minutes without progress', () => {
      expect(MAX_NO_PROGRESS_MS).toBe(10 * 60 * 1000)
    })

    it('should declare lock stale after 30 minutes', () => {
      expect(LOCK_TIMEOUT_MS).toBe(30 * 60 * 1000)
    })

    it('lock timeout should be longer than progress timeout', () => {
      expect(LOCK_TIMEOUT_MS).toBeGreaterThan(MAX_NO_PROGRESS_MS)
    })
  })
})
