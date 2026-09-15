/**
 * Runtime tests for indexer.lock: live-PID hold, dead-PID takeover,
 * wx takeover mutex, heartbeat, and multi-contender stale-lock races.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createIndexerLock,
  parseLockData,
  formatLockData,
  isProcessAlive,
  getTakeoverMutexPath,
  getTakeoverFencePath,
  DEFAULT_LOCK_TIMEOUT_MS
} from '../../lib/indexerLock.js'

const lockSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../lib/indexerLock.js'),
  'utf8'
)

function makeLockFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-tools-lock-'))
  return {
    dir,
    lockFile: path.join(dir, 'indexer.lock')
  }
}

describe('parseLockData / isProcessAlive', () => {
  it('parses pid:timestamp', () => {
    expect(parseLockData('12:99')).toEqual({ pid: 12, timestamp: 99, raw: '12:99' })
    expect(parseLockData('')).toBeNull()
    expect(parseLockData('nope')).toBeNull()
  })

  it('detects this process as alive and a huge pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(99999999)).toBe(false)
  })
})

describe('takeover does not rename the live lock path', () => {
  it('uses a wx mutex beside indexer.lock instead of rename-aside', () => {
    expect(lockSrc).toContain('TAKEOVER_MUTEX_SUFFIX')
    expect(lockSrc).toContain('.takeover')
    expect(lockSrc).toContain('getTakeoverFencePath')
    expect(lockSrc).not.toMatch(/renameSync\s*\(\s*lockFile/)
    expect(lockSrc).not.toContain('unlinkVerifiedStale')
  })
})

describe('createIndexerLock runtime', () => {
  let dir
  let lockFile
  const logs = []

  beforeEach(() => {
    const made = makeLockFile()
    dir = made.dir
    lockFile = made.lockFile
    logs.length = 0
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('acquires, re-enters, and releases a real lock file', () => {
    const lock = createIndexerLock({
      lockFile,
      pid: 100,
      isAlive: (p) => p === 100,
      now: () => 1_000,
      log: (m) => logs.push(m)
    })
    expect(lock.acquire()).toBe(true)
    expect(lock.ownsLock).toBe(true)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(100, 1_000))
    expect(lock.acquire()).toBe(true)
    lock.release()
    expect(lock.ownsLock).toBe(false)
    expect(fs.existsSync(lockFile)).toBe(false)
    expect(logs.some((m) => m.includes('Released lock file'))).toBe(true)
    expect(fs.existsSync(getTakeoverMutexPath(lockFile))).toBe(false)
  })

  it('does not steal from a live holder after a long sleep (stale timestamp)', () => {
    const holderPid = process.pid
    const oldTs = Date.now() - (45 * 60 * 1000)
    fs.writeFileSync(lockFile, formatLockData(holderPid, oldTs))

    const waiter = createIndexerLock({
      lockFile,
      pid: holderPid + 1,
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
      log: (m) => logs.push(m)
    })

    expect(waiter.acquire()).toBe(false)
    expect(waiter.ownsLock).toBe(false)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(holderPid, oldTs))
    expect(logs.some((m) => m.includes('still running') && m.includes('Not taking over'))).toBe(true)
  })

  it('takes over a lock whose holder PID is dead', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, Date.now() - 1000))
    const lock = createIndexerLock({
      lockFile,
      pid: 200,
      now: () => 50_000,
      isAlive: (p) => p === 200,
      log: (m) => logs.push(m)
    })
    expect(lock.acquire()).toBe(true)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(200, 50_000))
    expect(logs.some((m) => m.includes('Removing stale lock file'))).toBe(true)
    expect(fs.existsSync(getTakeoverMutexPath(lockFile))).toBe(false)
  })

  it('does not unlink a lock that changed before the mutex re-read', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    let lockReads = 0
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      unlinkSync: (p) => fs.unlinkSync(p),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      readFileSync: (p, enc) => {
        if (p === lockFile) {
          lockReads += 1
          if (lockReads === 2) {
            fs.writeFileSync(lockFile, formatLockData(300, 9))
          }
        }
        return fs.readFileSync(p, enc)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 400,
      isAlive: (p) => p === 300,
      fsApi,
      now: () => 10,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
    expect(waiter.ownsLock).toBe(false)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(300, 9))
  })

  it('lets only one waiter win after a dead holder', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    const isAlive = (p) => p === 100 || p === 200
    const a = createIndexerLock({
      lockFile,
      pid: 100,
      isAlive,
      now: () => 10,
      log: (m) => logs.push(m)
    })
    const b = createIndexerLock({
      lockFile,
      pid: 200,
      isAlive,
      now: () => 11,
      log: (m) => logs.push(m)
    })
    expect(a.acquire()).toBe(true)
    expect(b.acquire()).toBe(false)
    expect(parseLockData(fs.readFileSync(lockFile, 'utf8')).pid).toBe(100)
  })

  it('never unlinks indexer.lock when a peer wx-created during takeover', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    const mutexPath = getTakeoverMutexPath(lockFile)
    const unlinkedLockPath = []
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, c, o) => {
        fs.writeFileSync(p, c, o)
        if (p === mutexPath && o?.flag === 'wx') {
          fs.writeFileSync(lockFile, formatLockData(300, 9))
        }
      },
      unlinkSync: (p) => {
        if (p === lockFile) {
          unlinkedLockPath.push(p)
        }
        fs.unlinkSync(p)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 400,
      isAlive: (p) => p === 300,
      now: () => 10,
      fsApi,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
    expect(waiter.ownsLock).toBe(false)
    expect(unlinkedLockPath).toEqual([])
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(300, 9))
  })

  it('does not unlink an orphaned takeover mutex; recovers via a dead-pid wx fence', () => {
    const mutexPath = getTakeoverMutexPath(lockFile)
    const deadMutexPid = 88888888
    const fencePath = getTakeoverFencePath(lockFile, deadMutexPid)
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    fs.writeFileSync(mutexPath, formatLockData(deadMutexPid, 1))
    const unlinked = []
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      unlinkSync: (p) => {
        unlinked.push(p)
        fs.unlinkSync(p)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 200,
      isAlive: (p) => p === 200,
      now: () => 50_000,
      fsApi,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(true)
    expect(waiter.ownsLock).toBe(true)
    expect(unlinked).not.toContain(mutexPath)
    expect(fs.readFileSync(mutexPath, 'utf8')).toBe(formatLockData(deadMutexPid, 1))
    expect(fs.existsSync(fencePath)).toBe(false)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(200, 50_000))
  })

  it('does not steal a live recover fence or displace a peer wx mutex', () => {
    const mutexPath = getTakeoverMutexPath(lockFile)
    const deadMutexPid = 88888888
    const fencePath = getTakeoverFencePath(lockFile, deadMutexPid)
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    fs.writeFileSync(mutexPath, formatLockData(deadMutexPid, 1))
    fs.writeFileSync(fencePath, formatLockData(300, 9))
    const unlinked = []
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      unlinkSync: (p) => {
        unlinked.push(p)
        fs.unlinkSync(p)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 400,
      isAlive: (p) => p === 300,
      now: () => 10,
      fsApi,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
    expect(waiter.ownsLock).toBe(false)
    expect(unlinked).toEqual([])
    expect(fs.readFileSync(mutexPath, 'utf8')).toBe(formatLockData(deadMutexPid, 1))
    expect(fs.readFileSync(fencePath, 'utf8')).toBe(formatLockData(300, 9))
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(99999999, 1))
  })

  it('recovers a two-level crash (orphaned mutex and orphaned fence) without unlinking either', () => {
    const mutexPath = getTakeoverMutexPath(lockFile)
    const deadMutexPid = 88888888
    const deadFencePid = 77777777
    const fencePath = getTakeoverFencePath(lockFile, deadMutexPid)
    const fence2Path = getTakeoverFencePath(lockFile, deadMutexPid, deadFencePid)
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    fs.writeFileSync(mutexPath, formatLockData(deadMutexPid, 1))
    fs.writeFileSync(fencePath, formatLockData(deadFencePid, 1))
    const unlinked = []
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      unlinkSync: (p) => {
        unlinked.push(p)
        fs.unlinkSync(p)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 200,
      isAlive: (p) => p === 200,
      now: () => 50_000,
      fsApi,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(true)
    expect(unlinked).not.toContain(mutexPath)
    expect(unlinked).not.toContain(fencePath)
    expect(unlinked).toContain(fence2Path)
    expect(fs.readFileSync(mutexPath, 'utf8')).toBe(formatLockData(deadMutexPid, 1))
    expect(fs.readFileSync(fencePath, 'utf8')).toBe(formatLockData(deadFencePid, 1))
    expect(fs.existsSync(fence2Path)).toBe(false)
  })

  it('multi-contender stale takeover: at most one ownsLock (rename-aside regression)', () => {
    // Rename-aside failed this pattern (~2/200 with 8 waiters): moving the live
    // path aside let a peer wx-create, then restore/unlink displaced that lock
    // while both kept ownsLock. Pump on mutex/lock wx and lock unlink.
    const waiterPids = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]
    const isAlive = (p) => p !== 99999999 && waiterPids.includes(p)
    const rounds = 200

    for (let round = 0; round < rounds; round++) {
      fs.writeFileSync(lockFile, formatLockData(99999999, 1))
      const mutexPath = getTakeoverMutexPath(lockFile)
      try {
        fs.unlinkSync(mutexPath)
      } catch {
        // no leftover mutex
      }

      const waiters = []
      let pumping = false

      const pumpPeers = (selfPid) => {
        if (pumping) {
          return
        }
        pumping = true
        try {
          for (const w of waiters) {
            if (w.pid !== selfPid) {
              w.lock.acquire()
            }
          }
        } finally {
          pumping = false
        }
      }

      for (const waiterPid of waiterPids) {
        const fsApi = {
          existsSync: (p) => fs.existsSync(p),
          mkdirSync: (p, o) => fs.mkdirSync(p, o),
          readFileSync: (p, enc) => fs.readFileSync(p, enc),
          renameSync: (from, to) => {
            fs.renameSync(from, to)
            if (from === lockFile) {
              pumpPeers(waiterPid)
            }
          },
          writeFileSync: (p, c, o) => {
            fs.writeFileSync(p, c, o)
            if (o?.flag === 'wx' && (p === lockFile || p === mutexPath)) {
              pumpPeers(waiterPid)
            }
          },
          unlinkSync: (p) => {
            fs.unlinkSync(p)
            if (p === lockFile) {
              pumpPeers(waiterPid)
            }
          }
        }
        waiters.push({
          pid: waiterPid,
          lock: createIndexerLock({
            lockFile,
            pid: waiterPid,
            isAlive,
            now: () => 10 + waiterPid,
            fsApi,
            log: () => {}
          })
        })
      }

      waiters[0].lock.acquire()
      for (const w of waiters) {
        w.lock.acquire()
      }

      const winners = waiters.filter((w) => w.lock.ownsLock)
      expect(winners.length, `round ${round} owners`).toBeLessThanOrEqual(1)
      expect(winners.length, `round ${round} should elect an owner`).toBe(1)
      const ownerPid = parseLockData(fs.readFileSync(lockFile, 'utf8')).pid
      expect(ownerPid).toBe(winners[0].pid)
      expect(fs.existsSync(mutexPath)).toBe(false)
    }
  })

  it('multi-contender crash-orphaned takeover mutex: at most one ownsLock', () => {
    // Compare-then-unlink of indexer.lock.takeover let two waiters steal a
    // crash-orphaned mutex and both keep ownsLock. Pump on mutex/fence/lock wx
    // and on mutex/lock unlink. Dead mutex must stay; a live fence must not be
    // deleted by a peer.
    const waiterPids = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]
    const deadLockPid = 99999999
    const deadMutexPid = 88888888
    const isAlive = (p) => waiterPids.includes(p)
    const rounds = 200
    const mutexPath = getTakeoverMutexPath(lockFile)
    const fencePath = getTakeoverFencePath(lockFile, deadMutexPid)

    for (let round = 0; round < rounds; round++) {
      fs.writeFileSync(lockFile, formatLockData(deadLockPid, 1))
      fs.writeFileSync(mutexPath, formatLockData(deadMutexPid, 1))
      try {
        fs.unlinkSync(fencePath)
      } catch {
        // no leftover fence
      }

      const waiters = []
      let pumping = false
      const mutexUnlinks = []

      const pumpPeers = (selfPid) => {
        if (pumping) {
          return
        }
        pumping = true
        try {
          for (const w of waiters) {
            if (w.pid !== selfPid) {
              w.lock.acquire()
            }
          }
        } finally {
          pumping = false
        }
      }

      for (const waiterPid of waiterPids) {
        const fsApi = {
          existsSync: (p) => fs.existsSync(p),
          mkdirSync: (p, o) => fs.mkdirSync(p, o),
          readFileSync: (p, enc) => fs.readFileSync(p, enc),
          writeFileSync: (p, c, o) => {
            fs.writeFileSync(p, c, o)
            if (o?.flag === 'wx' && (p === lockFile || p === mutexPath || p === fencePath)) {
              pumpPeers(waiterPid)
            }
          },
          unlinkSync: (p) => {
            if (p === mutexPath) {
              mutexUnlinks.push(waiterPid)
            }
            fs.unlinkSync(p)
            if (p === lockFile || p === mutexPath || p === fencePath) {
              pumpPeers(waiterPid)
            }
          }
        }
        waiters.push({
          pid: waiterPid,
          lock: createIndexerLock({
            lockFile,
            pid: waiterPid,
            isAlive,
            now: () => 10 + waiterPid,
            fsApi,
            log: () => {}
          })
        })
      }

      waiters[0].lock.acquire()
      for (const w of waiters) {
        w.lock.acquire()
      }

      const winners = waiters.filter((w) => w.lock.ownsLock)
      expect(winners.length, `round ${round} owners`).toBeLessThanOrEqual(1)
      expect(winners.length, `round ${round} should elect an owner`).toBe(1)
      const ownerPid = parseLockData(fs.readFileSync(lockFile, 'utf8')).pid
      expect(ownerPid).toBe(winners[0].pid)
      expect(mutexUnlinks, `round ${round} must not unlink live takeover path`).toEqual([])
      expect(fs.readFileSync(mutexPath, 'utf8')).toBe(formatLockData(deadMutexPid, 1))
      expect(fs.existsSync(fencePath)).toBe(false)
    }
  })

  it('MCP-style owner heartbeats so a long cycle does not look stale', () => {
    let t = 1_000
    let tick = null
    const owner = createIndexerLock({
      lockFile,
      pid: 100,
      isAlive: (p) => p === 100 || p === 200,
      now: () => t,
      setIntervalFn: (fn) => {
        tick = fn
        return 1
      },
      clearIntervalFn: () => {},
      log: (m) => logs.push(m)
    })
    expect(owner.acquire()).toBe(true)
    owner.startHeartbeat(60_000)
    t = 1_000 + 45 * 60 * 1000
    expect(typeof tick).toBe('function')
    tick()
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(100, t))

    const waiter = createIndexerLock({
      lockFile,
      pid: 200,
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
      now: () => t,
      isAlive: (p) => p === 100 || p === 200,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
    expect(parseLockData(fs.readFileSync(lockFile, 'utf8')).pid).toBe(100)
  })

  it('heartbeat refreshes the timestamp without dropping the lock', () => {
    let t = 1_000
    const lock = createIndexerLock({
      lockFile,
      pid: 100,
      isAlive: (p) => p === 100,
      now: () => t,
      log: (m) => logs.push(m)
    })
    expect(lock.acquire()).toBe(true)
    t = 90_000
    expect(lock.refresh()).toBe(true)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(100, 90_000))
    expect(lock.ownsLock).toBe(true)
  })

  it('does not refresh a lock owned by another pid', () => {
    const lock = createIndexerLock({
      lockFile,
      pid: 200,
      isAlive: (p) => p === 100 || p === 200,
      now: () => 5,
      log: (m) => logs.push(m)
    })
    expect(lock.acquire()).toBe(true)
    fs.writeFileSync(lockFile, formatLockData(100, 1))
    expect(lock.refresh()).toBe(false)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(100, 1))
  })
})
