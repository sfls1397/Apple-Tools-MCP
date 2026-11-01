/**
 * 3.2.5 indexer memory fixes: capped LanceDB session, indexed-ID cache kept
 * between passes, duplicate-copy tracker, and periodic compaction.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as lancedb from '@lancedb/lancedb'
import {
  LANCE_INDEX_CACHE_MB_DEFAULT,
  LANCE_METADATA_CACHE_MB_DEFAULT,
  LANCE_CONNECT_OPTIONS,
  resolveLanceCacheSizes,
  createLanceSession,
  createLanceTableCache
} from '../../lib/lancedbTables.js'
import {
  INDEX_OPTIMIZE_INTERVAL_MS,
  INDEX_OPTIMIZE_KEEP_VERSIONS_MS,
  createIndexedIdCache,
  createDuplicatePathTracker,
  isIndexOptimizeDue,
  optimizeIndexTables
} from '../../lib/indexMaintenance.js'

const MB = 1024n * 1024n

describe('LanceDB session cache caps', () => {
  it('defaults to a 64 MB index cache and 256 MB metadata cache', () => {
    expect(LANCE_INDEX_CACHE_MB_DEFAULT).toBe(64)
    expect(LANCE_METADATA_CACHE_MB_DEFAULT).toBe(256)
    const sizes = resolveLanceCacheSizes({})
    expect(sizes.indexCacheBytes).toBe(64n * MB)
    expect(sizes.metadataCacheBytes).toBe(256n * MB)
  })

  it('accepts whole-MB env overrides and ignores invalid ones', () => {
    expect(resolveLanceCacheSizes({
      APPLE_TOOLS_LANCE_INDEX_CACHE_MB: '32',
      APPLE_TOOLS_LANCE_METADATA_CACHE_MB: ' 128 '
    })).toMatchObject({ indexCacheMb: 32, metadataCacheMb: 128 })
    for (const bad of ['0', '-5', '1.5', '64MB', 'abc', '999999', '']) {
      expect(resolveLanceCacheSizes({ APPLE_TOOLS_LANCE_INDEX_CACHE_MB: bad }).indexCacheMb).toBe(64)
    }
  })

  it('builds the Session with both caps in bytes', () => {
    const seen = []
    class FakeSession { constructor (...args) { seen.push(args) } }
    createLanceSession(FakeSession, {})
    expect(seen).toEqual([[64n * MB, 256n * MB]])
  })

  it('creates a real lancedb Session the native module accepts', () => {
    const session = createLanceSession(lancedb.Session, {})
    expect(typeof session.sizeBytes()).toBe('bigint')
  })

  it('passes the session to connect() as the third argument', async () => {
    const calls = []
    const session = { tag: 'capped' }
    const cache = createLanceTableCache({
      connect: async (...args) => {
        calls.push(args)
        return { tableNames: async () => [], openTable: async () => null, close () {} }
      },
      indexDir: '/idx',
      session
    })
    await cache.initDB()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['/idx', LANCE_CONNECT_OPTIONS, session])
  })

  it('keeps the two-argument connect when no session is given', async () => {
    const calls = []
    const cache = createLanceTableCache({
      connect: async (...args) => {
        calls.push(args)
        return { tableNames: async () => [], openTable: async () => null, close () {} }
      },
      indexDir: '/idx'
    })
    await cache.initDB()
    expect(calls[0]).toHaveLength(2)
  })

  it('indexer.js wires the capped session into its connection', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../indexer.js'), 'utf8')
    expect(src).toContain('session: createLanceSession(lancedb.Session)')
    expect(src).toContain('lancedb.connect(uri, options, session)')
  })
})

function fakeTable (rows, { version = 1 } = {}) {
  const table = {
    rows,
    v: version,
    queries: [],
    async version () { return table.v },
    query () {
      return {
        select (fields) {
          table.queries.push(fields)
          return { toArray: async () => table.rows.map(r => Object.fromEntries(fields.map(f => [f, r[f]]))) }
        }
      }
    }
  }
  return table
}

describe('createIndexedIdCache', () => {
  it('reads both columns in one query and serves later passes from memory', async () => {
    const table = fakeTable([{ filePath: '/a', messageId: '<1>' }, { filePath: '/b', messageId: '<2>' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    const first = await cache.getIdSets('emails', ['filePath', 'messageId'])
    expect([...first.filePath]).toEqual(['/a', '/b'])
    expect([...first.messageId]).toEqual(['<1>', '<2>'])
    expect(table.queries).toEqual([['filePath', 'messageId']])

    for (let pass = 0; pass < 5; pass++) {
      const again = await cache.getIdSets('emails', ['filePath', 'messageId'])
      expect(again).toBe(first)
    }
    expect(table.queries).toHaveLength(1)
  })

  it('re-reads when the table version moves (another writer)', async () => {
    const table = fakeTable([{ id: '1' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    await cache.getIdSets('messages', ['id'])
    table.rows.push({ id: '2' })
    table.v = 2
    const sets = await cache.getIdSets('messages', ['id'])
    expect([...sets.id]).toEqual(['1', '2'])
    expect(table.queries).toHaveLength(2)
  })

  it('re-reads when the table handle changes (table recreated)', async () => {
    let table = fakeTable([{ id: '1' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    await cache.getIdSets('messages', ['id'])
    table = fakeTable([{ id: '9' }])
    const sets = await cache.getIdSets('messages', ['id'])
    expect([...sets.id]).toEqual(['9'])
  })

  it('folds this process\'s own add into the cache when the version moved by one', async () => {
    const table = fakeTable([{ filePath: '/a', messageId: '<1>' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    await cache.getIdSets('emails', ['filePath', 'messageId'])
    table.rows.push({ filePath: '/c', messageId: '<3>' })
    table.v += 1
    await cache.noteAdded('emails', [{ filePath: '/c', messageId: '<3>' }])
    const sets = await cache.getIdSets('emails', ['filePath', 'messageId'])
    expect(sets.filePath.has('/c')).toBe(true)
    expect(sets.messageId.has('<3>')).toBe(true)
    expect(table.queries).toHaveLength(1)
  })

  it('drops the entry when the version jumped by more than its own commit', async () => {
    const table = fakeTable([{ id: '1' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    await cache.getIdSets('messages', ['id'])
    table.rows.push({ id: '2' }, { id: '3' })
    table.v += 2
    await cache.noteAdded('messages', [{ id: '2' }])
    expect(cache.has('messages')).toBe(false)
    const sets = await cache.getIdSets('messages', ['id'])
    expect(sets.id.has('3')).toBe(true)
    expect(table.queries).toHaveLength(2)
  })

  it('returns empty uncached sets when the table does not exist yet', async () => {
    const cache = createIndexedIdCache({ getTable: async () => null })
    const sets = await cache.getIdSets('emails', ['filePath', 'messageId'])
    expect(sets.filePath.size).toBe(0)
    expect(cache.has('emails')).toBe(false)
  })

  it('invalidate() forces the next read', async () => {
    const table = fakeTable([{ id: '1' }])
    const cache = createIndexedIdCache({ getTable: async () => table })
    await cache.getIdSets('messages', ['id'])
    cache.invalidate()
    await cache.getIdSets('messages', ['id'])
    expect(table.queries).toHaveLength(2)
  })

  it('propagates read errors so callers never index against an empty set', async () => {
    const table = fakeTable([])
    table.query = () => ({ select: () => ({ toArray: async () => { throw new Error('io') } }) })
    const cache = createIndexedIdCache({ getTable: async () => table })
    await expect(cache.getIdSets('emails', ['filePath'])).rejects.toThrow('io')
    expect(cache.has('emails')).toBe(false)
  })
})

describe('createDuplicatePathTracker', () => {
  it('remembers duplicate copies and forgets ones that left the lookback window', () => {
    const tracker = createDuplicatePathTracker()
    tracker.add('/junk/1.emlx')
    tracker.add('/junk/2.emlx')
    expect(tracker.has('/junk/1.emlx')).toBe(true)
    tracker.retainOnly(['/junk/2.emlx', '/inbox/9.emlx'])
    expect(tracker.has('/junk/1.emlx')).toBe(false)
    expect(tracker.has('/junk/2.emlx')).toBe(true)
    expect(tracker.size).toBe(1)
    tracker.clear()
    expect(tracker.size).toBe(0)
  })
})

describe('isIndexOptimizeDue', () => {
  const now = 1_800_000_000_000
  it('never runs after a pass that wrote nothing', () => {
    expect(isIndexOptimizeDue({ lastOptimizeTime: null, now, wroteSomething: false })).toBe(false)
  })
  it('runs on the first writing pass when it has never run', () => {
    expect(isIndexOptimizeDue({ lastOptimizeTime: undefined, now, wroteSomething: true })).toBe(true)
  })
  it('runs once a day', () => {
    expect(INDEX_OPTIMIZE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    expect(isIndexOptimizeDue({ lastOptimizeTime: now - 60_000, now, wroteSomething: true })).toBe(false)
    expect(isIndexOptimizeDue({ lastOptimizeTime: now - INDEX_OPTIMIZE_INTERVAL_MS, now, wroteSomething: true })).toBe(true)
  })
  it('treats a future timestamp (clock change) as due', () => {
    expect(isIndexOptimizeDue({ lastOptimizeTime: now + 1e9, now, wroteSomething: true })).toBe(true)
  })
})

describe('optimizeIndexTables', () => {
  it('compacts each open table with cleanupOlderThan = now - keep window', async () => {
    const seen = []
    const tables = {
      emails: { optimize: async (opts) => { seen.push(['emails', opts]); return { compaction: { fragmentsRemoved: 9, fragmentsAdded: 1 }, prune: { oldVersionsRemoved: 8, bytesRemoved: 3 * 1024 * 1024 } } } },
      messages: null
    }
    const logs = []
    const now = 1_800_000_000_000
    const result = await optimizeIndexTables({ tables, tableNames: ['emails', 'messages', 'calendar'], now, log: (m) => logs.push(m) })
    expect(result).toEqual({ optimized: ['emails'], failed: [] })
    expect(seen[0][1].cleanupOlderThan.getTime()).toBe(now - INDEX_OPTIMIZE_KEEP_VERSIONS_MS)
    expect(logs[0]).toMatch(/Optimized emails: fragments -9 \+1, old versions removed 8, 3 MB freed/)
  })

  it('logs a failure and keeps going instead of failing the pass', async () => {
    const tables = {
      emails: { optimize: async () => { throw new Error('busy') } },
      messages: { optimize: async () => ({}) }
    }
    const logs = []
    const result = await optimizeIndexTables({ tables, tableNames: ['emails', 'messages'], log: (m) => logs.push(m) })
    expect(result).toEqual({ optimized: ['messages'], failed: ['emails'] })
    expect(logs.join('\n')).toContain('Optimize emails failed (index still usable): busy')
  })
})

describe('real LanceDB: capped session, version-checked IDs, compaction', () => {
  it('compacts many small appends and the ID cache tracks real versions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-maint-'))
    try {
      const session = createLanceSession(lancedb.Session, {})
      const db = await lancedb.connect(dir, LANCE_CONNECT_OPTIONS, session)
      const row = (i) => ({ id: String(i), vector: Array.from({ length: 8 }, () => i / 100) })
      let table = await db.createTable('messages', [row(0)])
      const cache = createIndexedIdCache({ getTable: async () => table })

      // Simulate the daemon: read IDs, add one row, fold it in; 20 passes.
      let fullReads = 0
      const origQuery = table.query.bind(table)
      table.query = () => { fullReads++; return origQuery() }
      for (let i = 1; i <= 20; i++) {
        const sets = await cache.getIdSets('messages', ['id'])
        expect(sets.id.has(String(i))).toBe(false)
        await table.add([row(i)])
        await cache.noteAdded('messages', [row(i)])
      }
      expect(fullReads).toBe(1)
      const sets = await cache.getIdSets('messages', ['id'])
      expect(sets.id.size).toBe(21)

      const dataDir = path.join(dir, 'messages.lance', 'data')
      const filesBefore = fs.readdirSync(dataDir).length
      expect(filesBefore).toBeGreaterThanOrEqual(21)

      const logs = []
      const result = await optimizeIndexTables({
        tables: { messages: table },
        tableNames: ['messages'],
        now: Date.now() + 2 * INDEX_OPTIMIZE_KEEP_VERSIONS_MS,
        log: (m) => logs.push(m)
      })
      expect(result.optimized).toEqual(['messages'])
      expect(logs[0]).toMatch(/Optimized messages: fragments -21 \+1/)
      expect(await table.countRows()).toBe(21)
      const filesAfter = fs.readdirSync(dataDir).length
      expect(filesAfter).toBeLessThan(filesBefore)

      // Compaction is a new version: the cache notices and re-reads once.
      cache.invalidate()
      expect((await cache.getIdSets('messages', ['id'])).id.size).toBe(21)
      table.close?.()
      db.close?.()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
