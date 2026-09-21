/**
 * BA AC: MCP query tools must succeed against an existing on-disk vector-index
 * while the indexer daemon holds the lock (not gated only on this process’s
 * first-index cycle). Source:
 * https://app.notion.com/p/3dc6f1b360ee81e7956ed6199c5cf9a5
 *
 * Root cause: initDB() cached the first LanceDB connect even when tableNames
 * was empty, so isIndexReady() stayed false and mail_recent / messages_recent
 * returned indexUnavailableMessage.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  isSearchBlockedByIndexing,
  indexUnavailableMessage,
  indexQueryGate,
  BUILDING_INITIAL_INDEX_MESSAGE,
  INDEXING_NEW_DATA_MESSAGE
} from '../../lib/indexGate.js'
import { mcpIndexingStartup, beginIndexCycle } from '../../lib/indexerRuntime.js'
import {
  INDEX_TABLE_NAMES,
  LANCE_CONNECT_OPTIONS,
  lanceTableExistsOnDisk,
  openMissingIndexTables,
  createLanceTableCache
} from '../../lib/lancedbTables.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

const INDEX_BACKED_TOOLS = [
  'mail_search',
  'mail_recent',
  'mail_date',
  'mail_senders',
  'mail_thread',
  'messages_search',
  'messages_recent',
  'messages_conversation',
  'calendar_search',
  'smart_search',
  'person_search'
]

function toolOutcome(gate) {
  if (gate.ok) {
    return 'search results'
  }
  return gate.message
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
  it('looks for <name>.lance under the index dir only', () => {
    const seen = []
    const exists = lanceTableExistsOnDisk('/idx', 'emails', (p) => {
      seen.push(p)
      return p === path.join('/idx', 'emails.lance')
    })
    expect(exists).toBe(true)
    expect(seen[0]).toBe(path.join('/idx', 'emails.lance'))
  })

  it('does not walk names outside emails/messages/calendar', () => {
    expect(lanceTableExistsOnDisk('/idx', '../etc/passwd', () => true)).toBe(false)
    expect(lanceTableExistsOnDisk('/idx', 'secrets', () => true)).toBe(false)
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
    expect(logs.join('\n')).not.toMatch(/token|password|api[_-]?key/i)
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

describe('createLanceTableCache / isIndexReady (on-disk readiness, not local cycle)', () => {
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

  it('serializes reconnect so parallel isIndexReady cannot close each other\'s connection', async () => {
    let connects = 0
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: (p) =>
        INDEX_TABLE_NAMES.some((n) => p.endsWith(`${n}.lance`)),
      log: () => {},
      connect: async () => {
        connects += 1
        const id = connects
        const names = id === 1 ? [] : [...INDEX_TABLE_NAMES]
        const conn = {
          id,
          closed: false,
          tableNames: async () => {
            if (conn.closed) {
              throw new Error(`use after close #${id}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 15))
            if (conn.closed) {
              throw new Error(`use after close #${id}`)
            }
            return names
          },
          openTable: async (name) => {
            if (conn.closed) {
              throw new Error(`use after close #${id}`)
            }
            return { name }
          },
          close() {
            conn.closed = true
          }
        }
        return conn
      }
    })

    const results = await Promise.all([
      cache.isIndexReady('emails'),
      cache.isIndexReady('messages'),
      cache.isIndexReady('calendar')
    ])
    expect(results).toEqual([true, true, true])
    expect(cache.db.closed).toBe(false)
    expect(connects).toBe(2)
  })

  it('does not assign a connection that completed after reset', async () => {
    let finishFirst
    let firstConn
    let connects = 0
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: () => {
        connects += 1
        if (connects === 1) {
          return new Promise((resolve) => {
            firstConn = mockConnection(() => ['emails'])
            firstConn.closed = false
            firstConn.close = () => {
              firstConn.closed = true
            }
            finishFirst = () => resolve(firstConn)
          })
        }
        return Promise.resolve(mockConnection(() => ['emails']))
      }
    })

    const pending = cache.initDB()
    cache.reset()
    finishFirst()
    await pending

    expect(firstConn.closed).toBe(true)
    expect(cache.db).not.toBe(firstConn)
    expect(await cache.isIndexReady('emails')).toBe(true)
    expect(cache.db).not.toBe(firstConn)
  })

  it('failed connect rejects to the caller without an unhandledRejection', async () => {
    const unhandled = []
    const onUnhandled = (reason) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let connects = 0
      const cache = createLanceTableCache({
        indexDir: '/idx',
        mkdirSync: () => {},
        existsSync: () => false,
        connect: async () => {
          connects += 1
          if (connects === 1) {
            throw new Error('connect failed')
          }
          return mockConnection(() => ['emails'])
        }
      })

      await expect(cache.isIndexReady('emails')).rejects.toThrow('connect failed')
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])

      expect(await cache.isIndexReady('emails')).toBe(true)
      expect(connects).toBe(2)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('AC: readiness with daemon holding the lock', () => {
  it('mail_recent / messages_recent / search tools succeed when tables exist and this process never indexed', async () => {
    const startup = mcpIndexingStartup(() => false)
    expect(startup).toEqual({
      startBackground: false,
      ownsIndexLock: false,
      startHeartbeat: false,
      reason: 'lock-held'
    })

    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => [...INDEX_TABLE_NAMES])
    })

    const typeByTool = {
      mail_search: 'emails',
      mail_recent: 'emails',
      mail_date: 'emails',
      mail_senders: 'emails',
      mail_thread: 'emails',
      messages_search: 'messages',
      messages_recent: 'messages',
      messages_conversation: 'messages',
      calendar_search: 'calendar',
      smart_search: 'emails',
      person_search: 'emails'
    }

    for (const tool of INDEX_BACKED_TOOLS) {
      const type = typeByTool[tool]
      const ready = await cache.isIndexReady(type)
      expect(ready, tool).toBe(true)
      const gate = indexQueryGate({
        sessionIndexComplete: false,
        ownsIndexLock: startup.ownsIndexLock,
        indexReady: ready,
        type,
        isFirstEverRun: true
      })
      const outcome = toolOutcome(gate)
      expect(outcome, tool).toBe('search results')
      expect(outcome, tool).not.toBe(indexUnavailableMessage(type))
      expect(outcome, tool).not.toBe(BUILDING_INITIAL_INDEX_MESSAGE)
      expect(outcome, tool).not.toBe(INDEXING_NEW_DATA_MESSAGE)
      expect(String(outcome), tool).not.toMatch(/index not available/i)
      expect(String(outcome), tool).not.toMatch(/building initial index/i)
    }
  })

  it('session readiness is on-disk tables, not this process completing a lock-held cycle', async () => {
    expect(isSearchBlockedByIndexing(false, false)).toBe(false)
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => ['emails', 'messages', 'calendar'])
    })
    expect(await cache.isIndexReady('emails')).toBe(true)
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: false,
      indexReady: true,
      type: 'emails'
    })
    expect(gate.ok).toBe(true)
  })

  it('missing or unusable index still refuses — does not invent empty search results', async () => {
    const startup = mcpIndexingStartup(() => false)
    const cache = createLanceTableCache({
      indexDir: '/idx',
      mkdirSync: () => {},
      existsSync: () => false,
      connect: async () => mockConnection(() => [])
    })

    expect(await cache.isIndexReady('emails')).toBe(false)
    expect(await cache.isIndexReady('messages')).toBe(false)
    expect(await cache.isIndexReady('calendar')).toBe(false)

    for (const type of INDEX_TABLE_NAMES) {
      const gate = indexQueryGate({
        sessionIndexComplete: false,
        ownsIndexLock: startup.ownsIndexLock,
        indexReady: false,
        type
      })
      expect(gate.ok).toBe(false)
      expect(gate.message).toBe(indexUnavailableMessage(type))
      expect(gate.message).not.toBe('search results')
      expect(gate.message).not.toBe(BUILDING_INITIAL_INDEX_MESSAGE)
    }
  })

  it('local-fallback still starts when no daemon holds the lock', () => {
    const fallback = mcpIndexingStartup(() => true)
    expect(fallback).toEqual({
      startBackground: true,
      ownsIndexLock: true,
      startHeartbeat: true,
      reason: 'local-fallback'
    })
    expect(isSearchBlockedByIndexing(false, fallback.ownsIndexLock)).toBe(true)
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: true,
      indexReady: false,
      type: 'emails',
      isFirstEverRun: true
    })
    expect(gate.message).toBe(BUILDING_INITIAL_INDEX_MESSAGE)
  })

  it('overlapping daemon cycles still skip; readers use cross-process catalog freshness', () => {
    const nested = beginIndexCycle(true, () => {})
    expect(nested).toEqual({ started: false, indexingInProgress: true })
    expect(LANCE_CONNECT_OPTIONS.readConsistencyInterval).toBe(0)
  })
})

describe('AC: regression / packaging / security', () => {
  const indexerSrc = fs.readFileSync(path.join(root, 'indexer.js'), 'utf8')
  const searchSrc = fs.readFileSync(path.join(root, 'search.js'), 'utf8')
  const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
  const tablesSrc = fs.readFileSync(path.join(root, 'lib/lancedbTables.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))

  it('does not early-return an empty initDB cache', () => {
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

  it('query tools use requireIndex / indexQueryGate against isIndexReady', () => {
    expect(indexSrc).toContain('requireIndex')
    expect(indexSrc).toContain('indexQueryGate')
    expect(indexSrc).toContain('isIndexReady("emails")')
    expect(indexSrc).toContain('isIndexReady("messages")')
    expect(indexSrc).toContain('isIndexReady("calendar")')
    expect(indexSrc).toContain('ownsIndexLock = false')
    expect(indexSrc).toContain('requireIndex("emails")')
    expect(indexSrc).toContain('requireIndex("messages")')
    expect(indexSrc).toContain('requireIndex("calendar")')
  })

  it('does not statically import @xenova/transformers (Linux sharp-safe)', () => {
    expect(indexerSrc).not.toMatch(/^import\s+.*@xenova\/transformers/m)
    expect(indexerSrc).toContain('await import("@xenova/transformers")')
  })

  it('real embedding idx tests skip when Xenova/sharp cannot load', () => {
    const helper = fs.readFileSync(path.join(root, 'tests/indexing/helpers/real-data.js'), 'utf8')
    expect(helper).toContain('export function embedderAvailable')
    expect(helper).toContain("process.platform !== 'darwin'")
    const cacheSrc = fs.readFileSync(path.join(root, 'tests/indexing/caching/real-embedding-cache.test.js'), 'utf8')
    expect(cacheSrc).toContain('skipIf(!sources.embedder)')
  })

  it('package version is 2.0.9 and dependencies are unchanged', () => {
    expect(pkg.version).toBe('2.0.9')
    expect(lock.version).toBe('2.0.9')
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@lancedb/lancedb',
      '@modelcontextprotocol/sdk',
      '@xenova/transformers',
      'chrono-node'
    ])
  })

  it('index dir checks stay under the configured index directory', () => {
    expect(tablesSrc).toContain('INDEX_TABLE_NAMES.includes(name)')
    expect(tablesSrc).toContain('${name}.lance')
    expect(indexerSrc).toContain('.apple-tools-mcp')
    expect(indexerSrc).toContain('vector-index')
  })
})
