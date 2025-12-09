/**
 * Performance test mocks
 * Lightweight mocks optimized for performance testing
 */

import { vi } from 'vitest'

const EMBEDDING_DIM = 384

/**
 * Create a fast mock embedder for performance testing
 */
export function createFastEmbedder() {
  // Pre-allocate buffer for efficiency
  const buffer = new Float32Array(EMBEDDING_DIM * 128) // Max batch size

  const embedder = vi.fn().mockImplementation(async (texts, options) => {
    const count = Array.isArray(texts) ? texts.length : 1
    const data = buffer.subarray(0, count * EMBEDDING_DIM)

    // Fast deterministic fill
    for (let i = 0; i < count * EMBEDDING_DIM; i++) {
      data[i] = Math.sin(i) * 0.1
    }

    return { data }
  })

  return {
    embedder,
    pipeline: vi.fn().mockResolvedValue(embedder)
  }
}

/**
 * Create an in-memory LanceDB mock for performance testing
 */
export function createLanceDBMock() {
  const tables = new Map()

  const createSearchBuilder = (records, limit = 20) => {
    const builder = {
      filter: vi.fn().mockImplementation(() => builder),
      select: vi.fn().mockImplementation(() => builder),
      limit: vi.fn().mockImplementation((n) => {
        limit = n
        return builder
      }),
      execute: vi.fn().mockImplementation(async () => {
        return records.slice(0, limit).map((r, i) => ({
          ...r,
          _distance: 0.1 + i * 0.01
        }))
      }),
      toArray: vi.fn().mockImplementation(async () => {
        return records.slice(0, limit).map((r, i) => ({
          ...r,
          _distance: 0.1 + i * 0.01
        }))
      })
    }
    return builder
  }

  const createTableMock = (records) => ({
    query: () => ({
      select: () => ({
        toArray: vi.fn().mockResolvedValue(records)
      }),
      limit: (n) => ({
        toArray: vi.fn().mockResolvedValue(records.slice(0, n))
      }),
      toArray: vi.fn().mockResolvedValue(records)
    }),
    search: vi.fn().mockImplementation((vector) => createSearchBuilder(records)),
    add: vi.fn().mockImplementation(async (newRecords) => {
      records.push(...newRecords)
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    createIndex: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockImplementation(() => records.length)
  })

  return {
    connect: vi.fn().mockResolvedValue({
      tableNames: vi.fn().mockImplementation(() =>
        Promise.resolve([...tables.keys()])
      ),
      createTable: vi.fn().mockImplementation(async (name, records) => {
        const tableRecords = [...records]
        tables.set(name, tableRecords)
        return createTableMock(tableRecords)
      }),
      openTable: vi.fn().mockImplementation(async (name) => {
        return createTableMock(tables.get(name) || [])
      }),
      dropTable: vi.fn().mockImplementation(async (name) => {
        tables.delete(name)
      })
    }),
    tables,
    reset: () => tables.clear()
  }
}

/**
 * Create mock SQLite results
 */
export function createSQLiteMock(data = {}) {
  return {
    safeSqlite3Json: vi.fn().mockImplementation((db, query) => {
      if (db.includes('chat.db')) {
        return data.messages || []
      }
      if (db.includes('Calendar')) {
        return data.events || []
      }
      if (db.includes('AddressBook')) {
        return data.contacts || []
      }
      return []
    }),
    safeSqlite3: vi.fn().mockReturnValue('')
  }
}

/**
 * Create mock file system
 */
export function createFileSystemMock(files = {}) {
  return {
    existsSync: vi.fn().mockImplementation((path) => {
      return files[path] !== undefined || path.includes('.apple-tools-mcp')
    }),
    readFileSync: vi.fn().mockImplementation((path) => {
      if (files[path]) return files[path]
      if (path.includes('index-meta.json')) return '{}'
      throw new Error(`ENOENT: ${path}`)
    }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({
      isFile: () => true,
      mtime: new Date()
    }),
    readdirSync: vi.fn().mockReturnValue([])
  }
}

/**
 * Create mock shell commands
 */
export function createShellMock(options = {}) {
  return {
    execAsync: vi.fn().mockImplementation(async (cmd) => {
      if (cmd.includes('mdfind')) {
        return { stdout: options.mdfindResults || '', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    }),
    safeOsascript: vi.fn().mockReturnValue('')
  }
}

/**
 * Create mock MCP server transport
 */
export function createMCPTransportMock() {
  const messages = []

  return {
    send: vi.fn().mockImplementation((msg) => {
      messages.push(msg)
    }),
    receive: vi.fn(),
    messages,
    clear: () => { messages.length = 0 }
  }
}

/**
 * Create comprehensive mock setup for testing
 */
export function createPerformanceMocks(data = {}) {
  return {
    embedder: createFastEmbedder(),
    lancedb: createLanceDBMock(),
    sqlite: createSQLiteMock(data),
    fs: createFileSystemMock(data.files || {}),
    shell: createShellMock(data),
    transport: createMCPTransportMock()
  }
}

/**
 * Simple timer for latency simulation
 */
export function simulateLatency(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs)
  return new Promise(resolve => setTimeout(resolve, delay))
}

/**
 * Create a mock with controllable latency
 */
export function withLatency(mockFn, minMs = 1, maxMs = 5) {
  return vi.fn().mockImplementation(async (...args) => {
    await simulateLatency(minMs, maxMs)
    return mockFn(...args)
  })
}
