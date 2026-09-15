/**
 * Runtime tests for indexer.lock: live-PID hold, dead-PID takeover,
 * CAS unlink, heartbeat, and the stale-lock / long-sleep race.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  createIndexerLock,
  parseLockData,
  formatLockData,
  isProcessAlive,
  DEFAULT_LOCK_TIMEOUT_MS
} from '../../lib/indexerLock.js'

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
  })

  it('does not CAS-unlink a lock that changed under us', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    let reads = 0
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      renameSync: (from, to) => fs.renameSync(from, to),
      unlinkSync: (p) => fs.unlinkSync(p),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      readFileSync: (p, enc) => {
        const value = fs.readFileSync(p, enc)
        reads += 1
        if (reads === 2) {
          fs.writeFileSync(lockFile, formatLockData(300, 9))
          return fs.readFileSync(p, enc)
        }
        return value
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 400,
      isAlive: () => false,
      fsApi,
      now: () => 10,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
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

  it('does not unlink a replacement lock installed between stale compare and delete', () => {
    fs.writeFileSync(lockFile, formatLockData(99999999, 1))
    const unlinkedPaths = []
    const fsApi = {
      existsSync: (p) => fs.existsSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      renameSync: (from, to) => {
        fs.renameSync(from, to)
        if (from === lockFile && !fs.existsSync(lockFile)) {
          fs.writeFileSync(lockFile, formatLockData(300, 9), { flag: 'wx' })
        }
      },
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      writeFileSync: (p, c, o) => fs.writeFileSync(p, c, o),
      unlinkSync: (p) => {
        unlinkedPaths.push(p)
        if (p === lockFile) {
          fs.writeFileSync(lockFile, formatLockData(300, 9))
        }
        fs.unlinkSync(p)
      }
    }
    const waiter = createIndexerLock({
      lockFile,
      pid: 400,
      isAlive: () => false,
      now: () => 10,
      fsApi,
      log: (m) => logs.push(m)
    })
    expect(waiter.acquire()).toBe(false)
    expect(waiter.ownsLock).toBe(false)
    expect(unlinkedPaths).not.toContain(lockFile)
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(formatLockData(300, 9))
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
