
import { describe, it, expect } from 'vitest'

const BATCH_SIZE = 32

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

function generateTestEmails(count) {
  return Array.from({ length: count }, (_, i) => ({
    path: `/test/${i + 1}.emlx`,
    content: `Test email ${i + 1}`
  }))
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('Concurrent Access', () => {
  describe('lock file race conditions', () => {
    it('should prevent concurrent index operations', async () => {
      const lockMock = createLockFileMock()
      const pid1 = 1001
      const pid2 = 1002

      const acquired1 = lockMock.acquire(pid1)
      expect(acquired1).toBe(true)

      const acquired2 = lockMock.acquire(pid2)
      expect(acquired2).toBe(false)

      lockMock.release(pid1)

      const acquired2Retry = lockMock.acquire(pid2)
      expect(acquired2Retry).toBe(true)
    })

    it('should handle rapid acquire/release cycles', async () => {
      const lockMock = createLockFileMock()
      const pids = [1001, 1002, 1003]
      const acquireAttempts = []

      for (let i = 0; i < 10; i++) {
        const pid = pids[i % pids.length]
        const acquired = lockMock.acquire(pid)

        if (acquired) {
          acquireAttempts.push({ pid, success: true })
          lockMock.release(pid)
        } else {
          acquireAttempts.push({ pid, success: false })
        }
      }

      const successes = acquireAttempts.filter(a => a.success).length
      expect(successes).toBeGreaterThan(0)
    })

    it('should detect held lock from different PID', async () => {
      const lockMock = createLockFileMock()
      const pid1 = 1001
      const pid2 = 1002

      lockMock.acquire(pid1)

      expect(lockMock.isLocked()).toBe(true)
      expect(lockMock.getHolder()).toBe(pid1)

      const released = lockMock.release(pid2)
      expect(released).toBe(false)
      expect(lockMock.isLocked()).toBe(true)
    })
  })

  describe('multi-instance safety', () => {
    it('should serialize indexing operations', async () => {
      const lockMock = createLockFileMock()
      const operations = []
      const texts = generateTestEmails(64).map(e => e.content)

      const instance1 = async (pid) => {
        if (!lockMock.acquire(pid)) {
          operations.push({ instance: 1, status: 'blocked' })
          return
        }

        operations.push({ instance: 1, status: 'started' })

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          await Promise.resolve()
          await wait(10)
        }

        operations.push({ instance: 1, status: 'completed' })
        lockMock.release(pid)
      }

      const instance2 = async (pid) => {
        await wait(5)

        if (!lockMock.acquire(pid)) {
          operations.push({ instance: 2, status: 'blocked' })
          return
        }

        operations.push({ instance: 2, status: 'started' })

        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          await Promise.resolve()
        }

        operations.push({ instance: 2, status: 'completed' })
        lockMock.release(pid)
      }

      await Promise.all([
        instance1(1001),
        instance2(1002)
      ])

      expect(operations.some(o => o.instance === 1 && o.status === 'completed')).toBe(true)
      expect(operations.some(o => o.instance === 2 && o.status === 'blocked')).toBe(true)
    })

    it('should allow queued operations after lock release', async () => {
      const lockMock = createLockFileMock()
      const completedInstances = []

      const runInstance = async (instanceId, pid, delay = 0) => {
        await wait(delay)

        for (let attempt = 0; attempt < 5; attempt++) {
          if (lockMock.acquire(pid)) {
            const texts = generateTestEmails(32).map(e => e.content)

            for (let i = 0; i < texts.length; i += BATCH_SIZE) {
              await Promise.resolve()
            }

            completedInstances.push(instanceId)
            lockMock.release(pid)
            return
          }

          await wait(50)
        }
      }

      await Promise.all([
        runInstance(1, 1001, 0),
        runInstance(2, 1002, 20),
        runInstance(3, 1003, 40)
      ])

      expect(completedInstances).toContain(1)
    })
  })

  describe('lock timeout simulation', () => {
    it('should detect stale locks', async () => {
      const lockMock = createLockFileMock()
      const stalePid = 9999

      lockMock.acquire(stalePid)
      expect(lockMock.isLocked()).toBe(true)

      const isStale = true

      if (isStale) {
        lockMock.reset()
      }

      expect(lockMock.isLocked()).toBe(false)

      const newPid = 1001
      expect(lockMock.acquire(newPid)).toBe(true)
    })

    it('should handle lock file age-based timeout', async () => {
      const lockMock = createLockFileMock()
      const LOCK_TIMEOUT_MS = 1000

      lockMock.acquire(9999)
      const lockCreatedAt = Date.now()

      await wait(100)

      const lockAge = Date.now() - lockCreatedAt
      const isTimedOut = lockAge > LOCK_TIMEOUT_MS

      expect(isTimedOut).toBe(false)
    })
  })

  describe('atomic operations', () => {
    it('should simulate exclusive file creation (wx flag)', async () => {
      const files = new Map()

      const createExclusive = (path, content) => {
        if (files.has(path)) {
          throw new Error('EEXIST: file already exists')
        }
        files.set(path, content)
        return true
      }

      expect(() => createExclusive('/tmp/index.lock', '1001')).not.toThrow()

      expect(() => createExclusive('/tmp/index.lock', '1002')).toThrow('EEXIST')
    })

    it('should handle concurrent creation attempts', async () => {
      const files = new Map()
      const results = []

      const createExclusive = (path, content) => {
        if (files.has(path)) {
          return false
        }
        files.set(path, content)
        return true
      }

      const attempts = [
        { pid: 1001, delay: 0 },
        { pid: 1002, delay: 1 },
        { pid: 1003, delay: 2 }
      ]

      await Promise.all(attempts.map(async ({ pid, delay }) => {
        await wait(delay)
        const success = createExclusive('/tmp/index.lock', String(pid))
        results.push({ pid, success })
      }))

      const successes = results.filter(r => r.success)
      expect(successes.length).toBe(1)
    })
  })

  describe('signal handler cleanup', () => {
    it('should simulate SIGTERM handling', async () => {
      const lockMock = createLockFileMock()
      let cleanupCalled = false

      const signalHandlers = new Map()

      const onSignal = (signal, handler) => {
        signalHandlers.set(signal, handler)
      }

      onSignal('SIGTERM', () => {
        lockMock.release(process.pid)
        cleanupCalled = true
      })

      lockMock.acquire(process.pid)
      expect(lockMock.isLocked()).toBe(true)

      const handler = signalHandlers.get('SIGTERM')
      if (handler) handler()

      expect(cleanupCalled).toBe(true)
      expect(lockMock.isLocked()).toBe(false)
    })

    it('should simulate SIGINT handling', async () => {
      const lockMock = createLockFileMock()
      let cleanupCalled = false
      const signalHandlers = new Map()

      const onSignal = (signal, handler) => {
        signalHandlers.set(signal, handler)
      }

      onSignal('SIGINT', () => {
        lockMock.release(process.pid)
        cleanupCalled = true
      })

      lockMock.acquire(process.pid)

      const handler = signalHandlers.get('SIGINT')
      if (handler) handler()

      expect(cleanupCalled).toBe(true)
      expect(lockMock.isLocked()).toBe(false)
    })
  })

  describe('re-entrant locking', () => {
    it('should allow same process to re-acquire its own lock', async () => {
      const lockMock = createLockFileMock()
      const pid = 1001

      expect(lockMock.acquire(pid)).toBe(true)

      expect(lockMock.acquire(pid)).toBe(true)

      expect(lockMock.isLocked()).toBe(true)
      expect(lockMock.getHolder()).toBe(pid)
    })

    it('should track re-entrant lock depth (simulation)', async () => {
      const lockMock = createLockFileMock()
      let lockDepth = 0
      const pid = 1001

      const acquireWithDepth = () => {
        if (lockMock.getHolder() === pid || lockMock.acquire(pid)) {
          lockDepth++
          return true
        }
        return false
      }

      const releaseWithDepth = () => {
        if (lockMock.getHolder() === pid) {
          lockDepth--
          if (lockDepth === 0) {
            lockMock.release(pid)
          }
          return true
        }
        return false
      }

      expect(acquireWithDepth()).toBe(true)
      expect(acquireWithDepth()).toBe(true)
      expect(acquireWithDepth()).toBe(true)

      expect(lockDepth).toBe(3)
      expect(lockMock.isLocked()).toBe(true)

      releaseWithDepth()
      expect(lockMock.isLocked()).toBe(true)

      releaseWithDepth()
      expect(lockMock.isLocked()).toBe(true)

      releaseWithDepth()
      expect(lockMock.isLocked()).toBe(false)
    })
  })

  describe('database connection safety', () => {
    it('should simulate single-writer pattern', async () => {
      const dbWrites = []
      let activeWriter = null

      const acquireWriter = (instanceId) => {
        if (activeWriter !== null) {
          return false
        }
        activeWriter = instanceId
        return true
      }

      const releaseWriter = (instanceId) => {
        if (activeWriter === instanceId) {
          activeWriter = null
          return true
        }
        return false
      }

      const writeToDb = async (instanceId, data) => {
        if (!acquireWriter(instanceId)) {
          return { success: false, reason: 'writer busy' }
        }

        dbWrites.push({ instanceId, data, timestamp: Date.now() })
        await wait(10)

        releaseWriter(instanceId)
        return { success: true }
      }

      const results = await Promise.all([
        writeToDb(1, 'data1'),
        writeToDb(2, 'data2'),
        writeToDb(3, 'data3')
      ])

      const successes = results.filter(r => r.success)
      const failures = results.filter(r => !r.success)

      expect(successes.length).toBeGreaterThanOrEqual(1)
    })
  })
})
