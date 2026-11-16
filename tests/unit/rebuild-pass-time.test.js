/**
 * rebuild_index (rebuildIndex) records lastIndexPassTime like indexAll does,
 * but only for a clean rebuild of all three sources: a partial rebuild leaves
 * the other sources as old as they were, and a source whose read was skipped
 * (no Full Disk Access, no store) leaves its table empty, so that rebuild is
 * not clean either (fake HOME with empty Mail/Messages/Calendar stores, mocked
 * embedder, no data).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (texts) => {
    const list = Array.isArray(texts) ? texts : [texts]
    return { data: new Float32Array(list.length * 384) }
  }
}))

const saved = {}
let tmp
let metaFile
let indexer
let origError

// Empty stores with the tables the indexer reads: readable, nothing to index.
const MESSAGES_SCHEMA = `
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER, handle_id INTEGER, text TEXT, attributedBody BLOB);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
`
const CALENDAR_SCHEMA = `
CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE Location (ROWID INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY, summary TEXT, description TEXT, location_id INTEGER, start_date REAL,
  end_date REAL, all_day INTEGER, calendar_id INTEGER);
CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, occurrence_date REAL, occurrence_end_date REAL);
CREATE TABLE Identity (ROWID INTEGER PRIMARY KEY, display_name TEXT);
CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY, owner_id INTEGER, identity_id INTEGER, email TEXT, status INTEGER, entity_type INTEGER);
`
const STORES = ['Library/Mail', 'Library/Messages', 'Library/Group Containers/group.com.apple.calendar']

function writeDb (file, sql) {
  fs.rmSync(file, { force: true })
  const result = spawnSync('sqlite3', [file], { input: sql, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`sqlite3 failed: ${result.stderr}`)
}

function makeStores () {
  for (const dir of STORES) fs.mkdirSync(path.join(tmp, dir), { recursive: true })
  writeDb(path.join(tmp, STORES[1], 'chat.db'), MESSAGES_SCHEMA)
  writeDb(path.join(tmp, STORES[2], 'Calendar.sqlitedb'), CALENDAR_SCHEMA)
}

function removeStores () {
  fs.rmSync(path.join(tmp, 'Library'), { recursive: true, force: true })
}

function readMeta () {
  return fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {}
}

describe('rebuildIndex records the index pass time', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-rebuild-pass-'))
    for (const k of ['HOME', 'APPLE_TOOLS_INDEX_DIR', 'APPLE_TOOLS_META_FILE']) saved[k] = process.env[k]
    process.env.HOME = tmp
    process.env.APPLE_TOOLS_INDEX_DIR = path.join(tmp, 'index')
    metaFile = path.join(tmp, 'index-meta.json')
    process.env.APPLE_TOOLS_META_FILE = metaFile
    origError = console.error
    console.error = () => {}
    vi.resetModules()
    indexer = await import('../../indexer.js')
  })

  afterAll(() => {
    console.error = origError
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('isFullIndexPass needs all three sources and no errors', () => {
    expect(indexer.isFullIndexPass(['emails', 'messages', 'calendar'], [])).toBe(true)
    expect(indexer.isFullIndexPass(['calendar', 'emails', 'messages'])).toBe(true)
    expect(indexer.isFullIndexPass(['emails', 'messages'], [])).toBe(false)
    expect(indexer.isFullIndexPass(['emails', 'messages', 'calendar'], [{ source: 'emails' }])).toBe(false)
    expect(indexer.isFullIndexPass(undefined, [])).toBe(false)
  })

  it('a partial rebuild leaves the pass time alone', async () => {
    makeStores()
    fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000 }))
    const result = await indexer.rebuildIndex(['calendar'])
    expect(result.errors).toEqual([])
    expect(readMeta().lastIndexPassTime).toBe(1000)
  })

  it('a clean full rebuild records it, keeping the other meta fields', async () => {
    makeStores()
    fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000, lastIndexOptimizeTime: 7 }))
    const before = Date.now()
    const result = await indexer.rebuildIndex()
    expect(result.errors).toEqual([])
    const meta = readMeta()
    expect(meta.lastIndexPassTime).toBeGreaterThanOrEqual(before)
    expect(meta.lastIndexOptimizeTime).toBe(7)
    expect(indexer.getLastIndexPassTime()).toBe(meta.lastIndexPassTime)
  })

  it('a full rebuild with a skipped source read is not a full pass', async () => {
    for (const lost of STORES) {
      makeStores()
      fs.rmSync(path.join(tmp, lost), { recursive: true, force: true })
      fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000 }))
      const result = await indexer.rebuildIndex()
      expect(result.errors.map((e) => [e.source, e.phase])).toEqual([[
        { 'Library/Mail': 'emails', 'Library/Messages': 'messages' }[lost] || 'calendar', 'read'
      ]])
      expect(readMeta().lastIndexPassTime).toBe(1000)
    }
  })

  it('a full rebuild where every source read was skipped records nothing', async () => {
    removeStores()
    fs.writeFileSync(metaFile, JSON.stringify({ lastIndexPassTime: 1000 }))
    const result = await indexer.rebuildIndex()
    expect(result.errors.map((e) => [e.source, e.phase])).toEqual([
      ['emails', 'read'], ['messages', 'read'], ['calendar', 'read']
    ])
    expect(result.indexed.emails.error).toBeTruthy()
    expect(readMeta().lastIndexPassTime).toBe(1000)
  })
})
