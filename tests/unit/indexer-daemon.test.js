/**
 * Runtime tests for indexer daemon vs MCP stdio paths.
 * Packaging/version stays as file checks; daemon behavior uses the real helpers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { cycleEndFlags } from '../../lib/indexGate.js'
import { isIndexerMode } from '../../lib/processMode.js'
import {
  shouldConnectMcpStdio,
  shouldExitOnStdinClose,
  bindStdinCloseExit,
  beginIndexCycle,
  applyIndexerCycleEnd,
  mcpIndexingStartup,
  waitForIndexerLock,
  beginOwnedIndexing
} from '../../lib/indexerRuntime.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')

describe('package version 2.1.0', () => {
  it('is 2.1.0 in package.json, lockfile, and startup logs', () => {
    expect(pkg.version).toBe('2.1.0')
    expect(lock.version).toBe('2.1.0')
    expect(lock.packages[''].version).toBe('2.1.0')
    expect(indexSrc).toContain('PACKAGE_VERSION')
    expect(indexSrc).toContain('Apple Tools MCP server running (v${PACKAGE_VERSION})')
    expect(indexSrc).toContain('Apple Tools MCP indexer running (v${PACKAGE_VERSION})')
    expect(indexSrc).toContain('const wasRunning = Boolean(indexTimer || progressCheckTimer)')
    expect(indexSrc).not.toContain('maybeNotifyIndexerRunning')
    expect(indexSrc).not.toContain('display notification')
    // The advertised version still comes from package.json, never a literal.
    expect(indexSrc).not.toMatch(/version:\s*["']2\.0\.[0-9]["']/)
  })

  it('exposes apple-tools-indexer bin and --mode=indexer', () => {
    expect(pkg.bin['apple-tools-mcp']).toBe('bin/apple-tools-mcp.js')
    expect(pkg.bin['apple-tools-indexer']).toBe('bin/apple-tools-indexer.js')
    expect(pkg.scripts.indexer).toBe('node index.js --mode=indexer')
    expect(pkg.scripts.permissions).toBe('node index.js permissions')
    expect(pkg.scripts.postinstall).toBe('node scripts/postinstall.js')
    expect(pkg.scripts['build-index']).toMatch(/rebuildIndex/)
    expect(lock.packages[''].bin['apple-tools-indexer']).toBe('bin/apple-tools-indexer.js')
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode=indexer'])).toBe(true)
    expect(isIndexerMode(['node', '/usr/local/bin/apple-tools-indexer'])).toBe(true)
  })
})

describe('MCP stdio vs indexer daemon runtime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('does not start MCP stdio in indexer mode', () => {
    expect(shouldConnectMcpStdio(true)).toBe(false)
    expect(shouldConnectMcpStdio(false)).toBe(true)
  })

  it('exits on stdin close only for MCP stdio, not the indexer daemon', () => {
    expect(shouldExitOnStdinClose(true)).toBe(false)
    expect(shouldExitOnStdinClose(false)).toBe(true)

    const mcpStdin = new EventEmitter()
    let mcpExited = false
    expect(bindStdinCloseExit(mcpStdin, false, () => { mcpExited = true }).bound).toBe(true)
    mcpStdin.emit('close')
    expect(mcpExited).toBe(true)

    const daemonStdin = new EventEmitter()
    let daemonExited = false
    expect(bindStdinCloseExit(daemonStdin, true, () => { daemonExited = true }).bound).toBe(false)
    daemonStdin.emit('close')
    expect(daemonExited).toBe(false)
  })

  it('lets the indexer daemon keep indexer.lock across cycles', () => {
    let released = 0
    const daemonEnd = applyIndexerCycleEnd({
      success: true,
      indexerMode: true,
      cycleEndFlags,
      releaseLock: () => { released += 1 }
    })
    expect(daemonEnd.ownsIndexLock).toBe(true)
    expect(daemonEnd.released).toBe(false)
    expect(daemonEnd.sessionIndexComplete).toBe(true)
    expect(released).toBe(0)

    const mcpEnd = applyIndexerCycleEnd({
      success: true,
      indexerMode: false,
      cycleEndFlags,
      releaseLock: () => { released += 1 }
    })
    expect(mcpEnd.ownsIndexLock).toBe(false)
    expect(mcpEnd.released).toBe(true)
    expect(released).toBe(1)
  })

  it('skips overlapping index cycles', () => {
    const logs = []
    const first = beginIndexCycle(false, (m) => logs.push(m))
    expect(first).toEqual({ started: true, indexingInProgress: true })

    const nested = beginIndexCycle(true, (m) => logs.push(m))
    expect(nested).toEqual({ started: false, indexingInProgress: true })
    expect(logs).toContain('Indexing already in progress, skipping cycle')
  })

  it('falls back to local indexing when MCP does not hold the lock', () => {
    const fallback = mcpIndexingStartup(() => true)
    expect(fallback).toEqual({
      startBackground: true,
      ownsIndexLock: true,
      startHeartbeat: true,
      reason: 'local-fallback'
    })

    const skipped = mcpIndexingStartup(() => false)
    expect(skipped).toEqual({
      startBackground: false,
      ownsIndexLock: false,
      startHeartbeat: false,
      reason: 'lock-held'
    })
  })

  it('starts lock heartbeat when MCP local-fallback owns the lock', () => {
    const calls = []
    beginOwnedIndexing({
      startHeartbeat: () => calls.push('heartbeat'),
      startBackground: () => calls.push('background')
    })
    expect(calls).toEqual(['heartbeat', 'background'])

    const fallback = mcpIndexingStartup(() => true)
    expect(fallback.startHeartbeat).toBe(true)
    if (fallback.startHeartbeat) {
      beginOwnedIndexing({
        startHeartbeat: () => calls.push('mcp-heartbeat'),
        startBackground: () => calls.push('mcp-background')
      })
    }
    expect(calls).toEqual(['heartbeat', 'background', 'mcp-heartbeat', 'mcp-background'])
  })

  it('retries until the daemon acquires indexer.lock', () => {
    vi.useFakeTimers()
    const logs = []
    let attempts = 0
    let acquired = false
    waitForIndexerLock(
      () => {
        attempts += 1
        return attempts >= 3
      },
      {
        retryMs: 1000,
        onAcquired: () => { acquired = true },
        log: (m) => logs.push(m),
        setTimeoutFn: (fn, ms) => setTimeout(fn, ms)
      }
    )
    expect(acquired).toBe(false)
    expect(logs[0]).toBe('Indexer daemon waiting for indexer.lock...')
    vi.advanceTimersByTime(1000)
    expect(acquired).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(acquired).toBe(true)
    expect(logs).toContain('Indexer daemon acquired indexer.lock')
    vi.useRealTimers()
  })
})

describe('index.js wires the runtime helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('imports lock and runtime modules instead of inlining daemon policy', () => {
    expect(indexSrc).toContain('createIndexerLock')
    expect(indexSrc).toContain('bindStdinCloseExit')
    expect(indexSrc).toContain('beginIndexCycle')
    expect(indexSrc).toContain('applyIndexerCycleEnd')
    expect(indexSrc).toContain('mcpIndexingStartup')
    expect(indexSrc).toContain('waitForIndexerLock')
    expect(indexSrc).toContain('beginOwnedIndexing')
    expect(indexSrc).toContain('startHeartbeat: startLockHeartbeat')
    expect(indexSrc).toContain('local fallback when no daemon is running')
  })
})
