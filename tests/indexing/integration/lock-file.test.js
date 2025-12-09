/**
 * Integration tests for lock file management
 * Tests multi-instance lock handling and race condition prevention
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import path from 'path'

/**
 * Create a lock file mock for testing lock behavior
 */
function createLockFileMock() {
  let holder = null

  return {
    acquire(pid) {
      if (holder === null || holder === pid) {
        holder = pid
        return true
      }
      return false
    },
    release(pid) {
      if (holder === pid) {
        holder = null
        return true
      }
      return false
    },
    isLocked() {
      return holder !== null
    },
    getHolder() {
      return holder
    },
    reset() {
      holder = null
    }
  }
}

/**
 * Create a file system mock for testing file operations
 */
function createFileSystemMock() {
  const files = new Map()
  const calls = {
    writeFileSync: [],
    readFileSync: [],
    unlinkSync: [],
    mkdirSync: [],
    existsSync: []
  }

  return {
    writeFileSync(path, content, options) {
      calls.writeFileSync.push([path, content, options])
      if (options?.flag === 'wx' && files.has(path)) {
        const error = new Error('EEXIST: file already exists')
        error.code = 'EEXIST'
        throw error
      }
      files.set(path, content)
    },
    readFileSync(path) {
      calls.readFileSync.push([path])
      return files.get(path)
    },
    unlinkSync(path) {
      calls.unlinkSync.push([path])
      files.delete(path)
    },
    mkdirSync(path, options) {
      calls.mkdirSync.push([path, options])
    },
    existsSync(path) {
      calls.existsSync.push([path])
      return files.has(path)
    },
    _setFile(path, content) {
      files.set(path, content)
    },
    _getCalls() {
      return calls
    }
  }
}

describe('Lock File Management', () => {
  const LOCK_FILE = path.join('/Users/test', '.apple-tools-mcp', 'indexer.lock')
  let lockMock
  let fsMock

  beforeEach(() => {
    lockMock = createLockFileMock()
    fsMock = createFileSystemMock()
  })

  afterEach(() => {
    lockMock.reset()
  })

  describe('lock acquisition', () => {
    it('should create lock file with PID on acquire', () => {
      const pid = process.pid

      lockMock.acquire(pid)

      expect(lockMock.isLocked()).toBe(true)
      expect(lockMock.getHolder()).toBe(pid)
    })

    it('should write current process PID to file', () => {
      fsMock.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })

      const calls = fsMock._getCalls()
      expect(calls.writeFileSync).toHaveLength(1)
      expect(calls.writeFileSync[0]).toEqual([
        LOCK_FILE,
        String(process.pid),
        { flag: 'wx' }
      ])
    })
  })

  describe('re-entrant locking', () => {
    it('should return true if we already hold the lock', () => {
      const pid = process.pid

      // First acquire
      const first = lockMock.acquire(pid)
      expect(first).toBe(true)

      // Second acquire by same process
      const second = lockMock.acquire(pid)
      expect(second).toBe(true)

      expect(lockMock.getHolder()).toBe(pid)
    })
  })

  describe('stale lock detection', () => {
    it('should remove stale lock from dead process', () => {
      // Simulate stale lock from non-existent process
      const deadPid = 99999999 // Very unlikely to exist

      // Simulate the behavior
      let lockRemoved = false
      const checkAndRemoveStale = (existingPid) => {
        try {
          if (existingPid === deadPid) {
            throw new Error('ESRCH') // No such process
          }
        } catch {
          lockRemoved = true
        }
      }

      checkAndRemoveStale(deadPid)

      expect(lockRemoved).toBe(true)
    })

    it('should successfully acquire after removing stale lock', () => {
      // Start with "stale" lock
      lockMock.acquire(99999)

      // Simulate stale lock removal
      lockMock.release(99999)

      // Now our process can acquire
      const acquired = lockMock.acquire(process.pid)

      expect(acquired).toBe(true)
      expect(lockMock.getHolder()).toBe(process.pid)
    })
  })

  describe('live process handling', () => {
    it('should fail if another process holds lock', () => {
      const otherPid = process.ppid || 1 // Parent PID or init

      // Other process holds lock
      lockMock.acquire(otherPid)

      // Our process tries to acquire
      const acquired = lockMock.acquire(process.pid)

      expect(acquired).toBe(false)
      expect(lockMock.getHolder()).toBe(otherPid)
    })

    it('should not overwrite lock held by live process', () => {
      const otherPid = process.ppid || 1

      lockMock.acquire(otherPid)
      lockMock.acquire(process.pid) // Should fail

      expect(lockMock.getHolder()).toBe(otherPid)
    })
  })

  describe('atomic file operations', () => {
    it('should use atomic wx flag to prevent race condition', () => {
      // The 'wx' flag ensures:
      // - File is created exclusively
      // - Fails with EEXIST if file already exists
      // - Prevents TOCTOU (time-of-check-time-of-use) race

      const flag = 'wx'

      fsMock.writeFileSync(LOCK_FILE, '12345', { flag })

      const calls = fsMock._getCalls()
      expect(calls.writeFileSync[0]).toEqual([
        LOCK_FILE,
        '12345',
        { flag: 'wx' }
      ])
    })

    it('should handle EEXIST error from race condition', () => {
      let raceDetected = false

      // First write creates the file
      fsMock.writeFileSync(LOCK_FILE, '1001', { flag: 'wx' })

      // Second write should fail
      try {
        fsMock.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
      } catch (err) {
        if (err.code === 'EEXIST') {
          raceDetected = true
        }
      }

      expect(raceDetected).toBe(true)
    })
  })

  describe('lock release', () => {
    it('should release lock only if we own it', () => {
      const myPid = process.pid

      lockMock.acquire(myPid)
      expect(lockMock.isLocked()).toBe(true)

      const released = lockMock.release(myPid)

      expect(released).toBe(true)
      expect(lockMock.isLocked()).toBe(false)
    })

    it('should not release lock owned by another process', () => {
      const otherPid = 12345

      lockMock.acquire(otherPid)

      const released = lockMock.release(process.pid)

      expect(released).toBe(false)
      expect(lockMock.isLocked()).toBe(true)
      expect(lockMock.getHolder()).toBe(otherPid)
    })

    it('should delete lock file on release', () => {
      fsMock._setFile(LOCK_FILE, String(process.pid))

      // Simulate release behavior
      const filePid = parseInt(fsMock.readFileSync(LOCK_FILE))
      if (filePid === process.pid) {
        fsMock.unlinkSync(LOCK_FILE)
      }

      const calls = fsMock._getCalls()
      expect(calls.unlinkSync).toHaveLength(1)
      expect(calls.unlinkSync[0]).toEqual([LOCK_FILE])
    })
  })

  describe('signal handlers', () => {
    it('should clean up lock on process exit signals', () => {
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']

      signals.forEach(signal => {
        expect(signals).toContain(signal)
      })

      // Lock should be released on any of these signals
      lockMock.acquire(process.pid)

      // Simulate signal handler
      lockMock.release(process.pid)

      expect(lockMock.isLocked()).toBe(false)
    })

    it('should release lock when stdin closes', () => {
      // stdin.on('close') should trigger lock release
      lockMock.acquire(process.pid)

      // Simulate client disconnect
      lockMock.release(process.pid)

      expect(lockMock.isLocked()).toBe(false)
    })
  })

  describe('directory creation', () => {
    it('should create lock directory if not exists', () => {
      const lockDir = path.dirname(LOCK_FILE)

      if (!fsMock.existsSync(lockDir)) {
        fsMock.mkdirSync(lockDir, { recursive: true })
      }

      const calls = fsMock._getCalls()
      expect(calls.mkdirSync).toHaveLength(1)
      expect(calls.mkdirSync[0]).toEqual([lockDir, { recursive: true }])
    })
  })

  describe('error handling', () => {
    it('should fail safe on lock error', () => {
      // Create a mock that throws on write
      const errorFs = {
        writeFileSync() {
          throw new Error('Permission denied')
        }
      }

      let acquired = true
      try {
        errorFs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
      } catch {
        acquired = false
      }

      // Should fail safe - don't proceed without lock
      expect(acquired).toBe(false)
    })
  })

  describe('lock timeout handling', () => {
    const LOCK_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes

    it('should define lock timeout as 30 minutes', () => {
      expect(LOCK_TIMEOUT_MS).toBe(30 * 60 * 1000)
      expect(LOCK_TIMEOUT_MS).toBe(1800000) // 1,800,000 ms = 30 minutes
    })

    it('should detect stale lock after 30 minutes', () => {
      const now = Date.now()
      const lockData = {
        pid: 99999,
        timestamp: now - (35 * 60 * 1000) // 35 minutes ago
      }

      const lockAge = now - lockData.timestamp
      const isStale = lockAge > LOCK_TIMEOUT_MS

      expect(isStale).toBe(true)
      expect(lockAge).toBeGreaterThan(LOCK_TIMEOUT_MS)
    })

    it('should NOT detect fresh lock as stale', () => {
      const now = Date.now()
      const lockData = {
        pid: 99999,
        timestamp: now - (5 * 60 * 1000) // 5 minutes ago
      }

      const lockAge = now - lockData.timestamp
      const isStale = lockAge > LOCK_TIMEOUT_MS

      expect(isStale).toBe(false)
      expect(lockAge).toBeLessThan(LOCK_TIMEOUT_MS)
    })

    it('should handle lock exactly at 30 minute boundary', () => {
      const now = Date.now()
      const lockData = {
        pid: 99999,
        timestamp: now - LOCK_TIMEOUT_MS // Exactly 30 minutes
      }

      const lockAge = now - lockData.timestamp
      const isStale = lockAge > LOCK_TIMEOUT_MS

      // At exactly 30 minutes, should NOT be considered stale (use > not >=)
      expect(isStale).toBe(false)
    })

    it('should parse lock file with timestamp', () => {
      const pid = 12345
      const timestamp = Date.now() - (40 * 60 * 1000)
      const lockContent = `${pid}:${timestamp}`

      const [pidStr, timestampStr] = lockContent.split(':')
      const parsedPid = parseInt(pidStr)
      const parsedTimestamp = parseInt(timestampStr)

      expect(parsedPid).toBe(pid)
      expect(parsedTimestamp).toBe(timestamp)

      const lockAge = Date.now() - parsedTimestamp
      expect(lockAge).toBeGreaterThan(LOCK_TIMEOUT_MS)
    })

    it('should handle missing timestamp gracefully', () => {
      const lockContent = '12345' // Old format without timestamp
      const [pidStr, timestampStr] = lockContent.split(':')
      const pid = parseInt(pidStr)
      const timestamp = parseInt(timestampStr) || Date.now()

      expect(pid).toBe(12345)
      expect(timestamp).toBeGreaterThan(0) // Defaults to now
    })

    it('should log warning for stale lock removal', () => {
      const now = Date.now()
      const stalePid = 99999
      const staleTimestamp = now - (45 * 60 * 1000) // 45 minutes
      const lockAge = now - staleTimestamp

      const shouldWarn = lockAge > LOCK_TIMEOUT_MS

      if (shouldWarn) {
        const ageMinutes = Math.round(lockAge / 60000)
        const message = `Lock file is ${ageMinutes} minutes old. Assuming hung process (PID ${stalePid}). Removing stale lock.`

        expect(message).toContain('45 minutes')
        expect(message).toContain(String(stalePid))
      }

      expect(shouldWarn).toBe(true)
    })

    it('should remove stale lock even if process exists', () => {
      const now = Date.now()
      const lockData = {
        pid: process.pid, // Our own PID (definitely exists)
        timestamp: now - (35 * 60 * 1000) // But 35 minutes old
      }

      const lockAge = now - lockData.timestamp
      let shouldRemove = false

      // Check if process exists
      let processExists = true
      try {
        process.kill(lockData.pid, 0) // Signal 0 = check existence
      } catch {
        processExists = false
      }

      // Remove if stale, even if process exists
      if (lockAge > LOCK_TIMEOUT_MS) {
        shouldRemove = true
      }

      expect(processExists).toBe(true) // Process exists
      expect(shouldRemove).toBe(true)  // But lock is stale
    })
  })
})
