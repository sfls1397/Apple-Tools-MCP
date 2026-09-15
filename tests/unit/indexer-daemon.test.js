/**
 * Source-level wiring for C+F+G: indexer daemon vs MCP stdio, interval clamp,
 * config, and the 1.2.0 version advertisement.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))

describe('package version 1.2.0', () => {
  it('is 1.2.0 in package.json, lockfile, and startup logs', () => {
    expect(pkg.version).toBe('1.2.0')
    expect(lock.version).toBe('1.2.0')
    expect(lock.packages[''].version).toBe('1.2.0')
    expect(indexSrc).toContain('PACKAGE_VERSION')
    expect(indexSrc).toContain('Apple Tools MCP server running (v${PACKAGE_VERSION})')
    expect(indexSrc).toContain('Apple Tools MCP indexer running (v${PACKAGE_VERSION})')
    expect(indexSrc).not.toMatch(/version:\s*["']2\.0\.0["']/)
  })
})

describe('indexer entrypoint (C)', () => {
  it('exposes apple-tools-indexer bin and --mode=indexer', () => {
    expect(pkg.bin['apple-tools-mcp']).toBe('./index.js')
    expect(pkg.bin['apple-tools-indexer']).toBe('./index.js')
    expect(pkg.scripts.indexer).toBe('node index.js --mode=indexer')
    expect(lock.packages[''].bin['apple-tools-indexer']).toBe('index.js')
    expect(indexSrc).toContain('isIndexerMode')
    expect(indexSrc).toContain('--mode=indexer')
  })

  it('does not start MCP stdio in indexer mode', () => {
    expect(indexSrc).toMatch(/if\s*\(!INDEXER_MODE\)\s*\{\s*main\(\)/)
  })

  it('exits on stdin close only for MCP stdio, not the indexer daemon', () => {
    expect(indexSrc).toContain('Client disconnected. Exiting.')
    expect(indexSrc).toMatch(/if\s*\(!INDEXER_MODE\)\s*\{\s*process\.stdin\.on\("close"/)
  })

  it('lets the indexer daemon own indexer.lock across cycles', () => {
    expect(indexSrc).toContain('Indexer daemon acquired indexer.lock')
    expect(indexSrc).toContain('startLockHeartbeat')
    expect(indexSrc).toMatch(/if \(INDEXER_MODE\) \{\s*ownsIndexLock = true;\s*return;/)
  })

  it('skips overlapping index cycles', () => {
    expect(indexSrc).toContain('Indexing already in progress, skipping cycle')
  })

  it('falls back to local indexing when MCP does not hold the lock', () => {
    expect(indexSrc).toContain('Server will run without background indexing.')
    expect(indexSrc).toContain('local fallback when no daemon is running')
  })
})

describe('interval clamp + config (F+G)', () => {
  const configSrc = fs.readFileSync(path.join(root, 'lib/config.js'), 'utf8')

  it('resolves interval from config with env override and logs effective value', () => {
    expect(indexSrc).toContain('loadResolvedIndexInterval')
    expect(indexSrc).toContain('logResolvedInterval')
    expect(indexSrc).toContain('resolvedIndexInterval')
    expect(configSrc).toContain('Effective index refresh interval')
    expect(configSrc).toContain('INDEX_INTERVAL_MS')
    expect(configSrc).toContain('config.json')
    expect(configSrc).toContain('MIN_INDEX_INTERVAL_MS = 15 * 1000')
    expect(configSrc).toContain('MAX_INDEX_INTERVAL_MS = 6 * 60 * 60 * 1000')
  })
})
