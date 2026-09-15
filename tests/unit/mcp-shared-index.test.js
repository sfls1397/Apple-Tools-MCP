/**
 * MCP stdio must read a shared on-disk index while the indexer daemon holds
 * indexer.lock. The failure mode was initDB() caching an empty {db, tables}
 * after the first connect (tableNames empty / not yet visible), then
 * `if (db) return` forever — isIndexReady() stayed false and mail_recent /
 * messages_recent returned indexUnavailableMessage even though tables existed.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { isSearchBlockedByIndexing, indexUnavailableMessage } from '../../lib/indexGate.js'
import { mcpIndexingStartup } from '../../lib/indexerRuntime.js'
import {
  INDEX_TABLE_NAMES,
  LANCE_CONNECT_OPTIONS,
  lanceTableExistsOnDisk,
  openMissingIndexTables,
  createLanceTableCache
} from '../../lib/lancedbTables.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

function mcpToolResponse({ sessionIndexComplete, ownsIndexLock, indexReady, type }) {
  if (isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)) {
    return 'still indexing'
  }
  if (!indexReady) {
    return indexUnavailableMessage(type)
  }
  return 'search results'
}

function mockConnection(getNames, { openError } = {}) {
  return {
    tableNames: async () => getNames(),
    openTable: async (name) => {
      if (openError) {
        throw new Error(openError)
      }
      return { name }
    },
    close() {}
  }
}

describe('lanceTableExistsOnDisk', () => {
  it('looks for <name>.lance under the index dir', () => {
    const seen = []
    const exists = lanceTableExistsOnDisk('/idx', 'emails', (p) => {
      seen.push(p)
      return p === path.join('/idx', 'emails.lance')
    })
    expect(exists).toBe(true)
    expect(seen[0]).toBe(path.join('/idx', 'emails.lance'))
  })
})

describe('openMissingIndexTables', () => {
  it('opens tables that appear after a first empty tableNames()', async () => {
    let names = []
    const tables = {}
    const db = mockConnection(() => names)

    await openMissingIndexTables({ db, tables, indexDir: '/idx', existsSync: () => false })
    expect(tables.emails).toBeUndefined()

    names = ['emails', 'messages', 'calendar']
    await openMissingIndexTables({ db, tables, indexDir: '/idx', existsSync: () => false })
    expect(tables.emails).toEqual({ name: 'emails' })
    expect(tables.messages).toEqual({ name: 'messages' })
    expect(tables.calendar).toEqual({ name: 'calendar' })
  })

  it('reconnects when .lance dirs exist but the catalog lists nothing', async () => {
    const logs = []
    let connects = 0
    const first = mockConnection(() => [])
    const second = mockConnection(() => ['emails'])
    const tables = {}

    const result = await openMissingIndexTables({
      db: first,
      tables,
      indexDir: '/idx',
      existsSync: (p) => p.endsWith('emails.lance'),
      log: (m) => logs.push(m),
      reconnect: async () => {
        connects += 1
        return second
      }
    })

    expect(result.reconnected).toBe(true)
    expect(connects).toBe(1)
    expect(tables.emails).toEqual({ name: 'emails' })
    expect(logs.some((m) => m.includes('reconnecting'))).toBe(true)
  })

  it('does not reconnect on a genuine empty index (no .lance dirs)', async () => {
    let reconnects = 0
    const tables = {}
    await openMissingIndexTables({
      db: mockConnection(() => []),
      tables,
      indexDir: '/idx',
      existsSync: () => false,
      reconnect: async () => {
        reconnects += 1
        return mockConnection(() => [])
      }
    })
    expect(reconnects).toBe(0)
    expect(tables.emails).toBeUndefined()
  })
})

describe('createLanceTableCache / isIndexReady', () => {
  it('does not cache an empty first connect forever', async () => {
    let names = []
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => names)
    })

    expect(await cache.isIndexReady('emails')).toBe(false)
    names = ['emails', 'messages', 'calendar']
    expect(await cache.isIndexReady('emails')).toBe(true)
    expect(await cache.isIndexReady('messages')).toBe(true)
    expect(await cache.isIndexReady('calendar')).toBe(true)
  })

  it('reconnects when on-disk tables exist but the first catalog is empty', async () => {
    let connects = 0
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: (p) =>
        INDEX_TABLE_NAMES.some((n) => p.endsWith(`${n}.lance`)),
      log: () => {},
      connect: async () => {
        connects += 1
        const names = connects === 1 ? [] : [...INDEX_TABLE_NAMES]
        return mockConnection(() => names)
      }
    })

    expect(await cache.isIndexReady('emails')).toBe(true)
    expect(await cache.isIndexReady('messages')).toBe(true)
    expect(await cache.isIndexReady('calendar')).toBe(true)
    expect(connects).toBe(2)
  })

  it('does not return empty tables to a concurrent caller during first connect', async () => {
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(mockConnection(() => ['emails', 'messages', 'calendar']))
          }, 20)
        })
    })

    const [a, b, c] = await Promise.all([
      cache.isIndexReady('emails'),
      cache.isIndexReady('messages'),
      cache.isIndexReady('calendar')
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(c).toBe(true)
  })

  it('retries openTable on a later check after a transient open failure', async () => {
    let shouldFail = true
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      log: () => {},
      connect: async () => ({
        tableNames: async () => ['emails'],
        openTable: async (name) => {
          if (shouldFail) {
            throw new Error('table locked')
          }
          return { name }
        },
        close() {}
      })
    })

    expect(await cache.isIndexReady('emails')).toBe(false)
    shouldFail = false
    expect(await cache.isIndexReady('emails')).toBe(true)
  })
})

describe('MCP stdio + daemon lock + on-disk index', () => {
  it('reports ready and does not return indexUnavailable when another process holds the lock', async () => {
    const startup = mcpIndexingStartup(() => false)
    expect(startup).toEqual({
      startBackground: false,
      ownsIndexLock: false,
      startHeartbeat: false,
      reason: 'lock-held'
    })
    expect(isSearchBlockedByIndexing(false, startup.ownsIndexLock)).toBe(false)

    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => [...INDEX_TABLE_NAMES])
    })

    for (const type of INDEX_TABLE_NAMES) {
      const ready = await cache.isIndexReady(type)
      expect(ready).toBe(true)
      const response = mcpToolResponse({
        sessionIndexComplete: false,
        ownsIndexLock: startup.ownsIndexLock,
        indexReady: ready,
        type
      })
      expect(response).toBe('search results')
      expect(response).not.toBe(indexUnavailableMessage(type))
      expect(response).not.toBe('still indexing')
    }
  })

  it('lost-lock with no tables is unavailable, not still-indexing', async () => {
    const startup = mcpIndexingStartup(() => false)
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => [])
    })

    expect(await cache.isIndexReady('emails')).toBe(false)
    expect(
      mcpToolResponse({
        sessionIndexComplete: false,
        ownsIndexLock: startup.ownsIndexLock,
        indexReady: false,
        type: 'emails'
      })
    ).toBe(indexUnavailableMessage('emails'))
  })

  it('local-fallback still starts background indexing when the lock is free', () => {
    const fallback = mcpIndexingStartup(() => true)
    expect(fallback).toEqual({
      startBackground: true,
      ownsIndexLock: true,
      startHeartbeat: true,
      reason: 'local-fallback'
    })
    expect(isSearchBlockedByIndexing(false, fallback.ownsIndexLock)).toBe(true)
  })
})

describe('source wiring', () => {
  const indexerSrc = fs.readFileSync(path.join(root, 'indexer.js'), 'utf8')
  const searchSrc = fs.readFileSync(path.join(root, 'search.js'), 'utf8')
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

  it('does not early-return an empty initDB cache', () => {
    const tablesSrc = fs.readFileSync(path.join(root, 'lib/lancedbTables.js'), 'utf8')
    expect(indexerSrc).not.toMatch(/if\s*\(\s*db\s*\)\s*return\s*\{\s*db,\s*tables\s*\}/)
    expect(indexerSrc).toContain('createLanceTableCache')
    expect(indexerSrc).toContain('LANCE_CONNECT_OPTIONS')
    expect(tablesSrc).toContain('readConsistencyInterval')
    expect(tablesSrc).toContain('openMissingIndexTables')
  })

  it('MCP search uses the shared indexer table handles', () => {
    expect(searchSrc).toContain('getOpenTable')
    expect(searchSrc).not.toMatch(/lancedb\.connect/)
  })

  it('index-backed tools still gate on isIndexReady after lost-lock', () => {
    expect(indexSrc).toContain('isIndexReady("emails")')
    expect(indexSrc).toContain('isIndexReady("messages")')
    expect(indexSrc).toContain('isIndexReady("calendar")')
    expect(indexSrc).toContain('indexUnavailableMessage')
    expect(indexSrc).toContain('ownsIndexLock = false')
  })

  it('does not bump package version', () => {
    expect(pkg.version).toBe('1.2.0')
    expect(LANCE_CONNECT_OPTIONS.readConsistencyInterval).toBe(0)
  })
})
