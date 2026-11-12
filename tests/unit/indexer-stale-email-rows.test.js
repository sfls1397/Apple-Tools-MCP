/**
 * Stale email rows (fake HOME, mocked embedder, real LanceDB): Mail renames a
 * mailbox's UUID folder and renumbers its files (a move to a new Mac), a
 * .partial.emlx finishes downloading, and one message is deleted.
 * - moved messages are re-pathed by Message-ID and keep their embedding
 *   (no new embed calls), with no duplicate rows
 * - the deleted message's row is removed
 * - a relocated file older than the incremental lookback is still indexed
 * - every indexed path exists afterwards (what mail_read needs)
 * - quiet passes after that take the early exit with no ID reads
 * - an empty Mail scan never empties the index
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const embedCalls = { texts: 0 }
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (texts) => {
    const list = Array.isArray(texts) ? texts : [texts]
    embedCalls.texts += list.length
    const data = new Float32Array(list.length * 384)
    list.forEach((t, i) => { data[i * 384] = (t.length % 97) / 97; data[i * 384 + 1] = 0.5 })
    return { data }
  }
}))

const saved = {}
let tmp
let acct
let indexer
let origError

function writeEmlx (file, { messageId, subject }) {
  const body = [
    'From: Sender Example <sender@example.com>',
    'To: Me Example <me@example.com>',
    `Subject: ${subject}`,
    'Date: Sat, 31 Oct 2026 20:00:00 -0500',
    `Message-ID: ${messageId}`,
    '',
    'Fixture body text long enough to be indexed by the email indexer.'
  ].join('\n')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${Buffer.byteLength(body)}\n${body}`)
}

function ageFile (file, days) {
  const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  fs.utimesSync(file, t, t)
}

async function rows () {
  const table = await indexer.getOpenTable('emails')
  return table.query().toArray()
}

describe('stale email rows after Mail moves its folders', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-stale-email-'))
    for (const k of ['HOME', 'APPLE_TOOLS_INDEX_DIR', 'APPLE_TOOLS_META_FILE', 'APPLE_TOOLS_INDEX_DAYS_BACK']) saved[k] = process.env[k]
    process.env.HOME = tmp
    // Production default (no DAYS_BACK cap), so the incremental lookback applies
    process.env.APPLE_TOOLS_INDEX_DAYS_BACK = '0'
    process.env.APPLE_TOOLS_INDEX_DIR = path.join(tmp, 'index')
    process.env.APPLE_TOOLS_META_FILE = path.join(tmp, 'index-meta.json')

    acct = path.join(tmp, 'Library', 'Mail', 'V10', 'ACCT')
    const old = path.join(acct, 'INBOX.mbox', 'OLD-UUID', 'Data', 'Messages')
    writeEmlx(path.join(old, '101.emlx'), { messageId: '<one@example.com>', subject: 'First fixture' })
    writeEmlx(path.join(old, '102.partial.emlx'), { messageId: '<two@example.com>', subject: 'Second fixture' })
    writeEmlx(path.join(old, '103.emlx'), { messageId: '<three@example.com>', subject: 'Third fixture' })
    writeEmlx(path.join(acct, 'Sent Messages.mbox', 'OLD-UUID', 'Data', 'Messages', '104.emlx'), { messageId: '<four@example.com>', subject: 'Fourth fixture' })

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

  it('first pass indexes four emails', async () => {
    const result = await indexer.indexEmails()
    expect(result).toMatchObject({ indexed: 4, added: 4 })
  })

  it('re-paths moved mail without re-embedding, drops deleted mail, and indexes old relocated files', async () => {
    const before = new Map((await rows()).map(r => [r.messageId, Array.from(r.vector)]))

    // Move: new mailbox UUID, new file numbers, partial now complete,
    // <three> deleted, and a relocated message that was never indexed.
    fs.rmSync(path.join(acct, 'INBOX.mbox', 'OLD-UUID'), { recursive: true })
    fs.rmSync(path.join(acct, 'Sent Messages.mbox', 'OLD-UUID'), { recursive: true })
    const inbox = path.join(acct, 'INBOX.mbox', 'NEW-UUID', 'Data', '9', 'Messages')
    const sent = path.join(acct, 'Sent Messages.mbox', 'NEW-UUID', 'Data', 'Messages')
    const moved = [
      [path.join(inbox, '901.emlx'), { messageId: '<one@example.com>', subject: 'First fixture' }],
      [path.join(inbox, '902.emlx'), { messageId: '<two@example.com>', subject: 'Second fixture' }],
      [path.join(sent, '904.emlx'), { messageId: '<four@example.com>', subject: 'Fourth fixture' }],
      // An IMAP copy of <one> in Junk: the INBOX copy must win
      [path.join(acct, 'Junk.mbox', 'NEW-UUID', 'Data', 'Messages', '905.emlx'), { messageId: '<one@example.com>', subject: 'First fixture' }],
      [path.join(inbox, '906.emlx'), { messageId: '<six@example.com>', subject: 'Sixth fixture never indexed' }]
    ]
    for (const [file, msg] of moved) {
      writeEmlx(file, msg)
      ageFile(file, 30) // older than the incremental lookback
    }

    embedCalls.texts = 0
    const result = await indexer.indexEmails()
    expect(result.repathed).toBe(3)
    expect(result.removed).toBe(1)
    expect(result.added).toBe(1) // only <six> needed an embedding
    expect(embedCalls.texts).toBe(1)

    const after = await rows()
    expect(after).toHaveLength(4)
    const byId = new Map(after.map(r => [r.messageId, r]))
    expect([...byId.keys()].sort()).toEqual(['<four@example.com>', '<one@example.com>', '<six@example.com>', '<two@example.com>'])
    expect(byId.get('<one@example.com>').filePath).toBe(path.join(inbox, '901.emlx'))
    expect(byId.get('<one@example.com>').mailbox).toBe('INBOX')
    expect(byId.get('<two@example.com>').filePath).toBe(path.join(inbox, '902.emlx'))
    expect(byId.get('<four@example.com>').filePath).toBe(path.join(sent, '904.emlx'))
    expect(byId.get('<four@example.com>').isSent).toBe(true)
    for (const id of ['<one@example.com>', '<two@example.com>', '<four@example.com>']) {
      expect(Array.from(byId.get(id).vector)).toEqual(before.get(id))
    }
    // What mail_read needs: every hit's file exists
    for (const r of after) expect(fs.existsSync(r.filePath)).toBe(true)
  })

  it('the next quiet pass takes the early exit with no ID reads', async () => {
    const table = await indexer.getOpenTable('emails')
    let idReads = 0
    const origQuery = table.query.bind(table)
    table.query = (...a) => { idReads++; return origQuery(...a) }
    try {
      embedCalls.texts = 0
      const result = await indexer.indexEmails()
      expect(result).toEqual({ indexed: 4, added: 0 })
      expect(idReads).toBe(0)
      expect(embedCalls.texts).toBe(0)
    } finally {
      table.query = origQuery
    }
  })

  it('a path with a backslash or quote is re-pathed, and an unreadable mailbox keeps its rows', async () => {
    // A mailbox whose folder name has a backslash and a quote
    const odd = path.join(acct, "Odd\\Box's.mbox", 'OLD-UUID', 'Data', 'Messages')
    writeEmlx(path.join(odd, '701.emlx'), { messageId: '<seven@example.com>', subject: 'Seventh fixture' })
    let result = await indexer.indexEmails()
    expect(result.added).toBe(1)
    fs.rmSync(path.join(acct, "Odd\\Box's.mbox", 'OLD-UUID'), { recursive: true })
    const moved = path.join(acct, "Odd\\Box's.mbox", 'NEW-UUID', 'Data', 'Messages', '702.emlx')
    writeEmlx(moved, { messageId: '<seven@example.com>', subject: 'Seventh fixture' })
    result = await indexer.indexEmails()
    expect(result.repathed).toBe(1)
    expect(result.removed).toBe(0)
    expect((await rows()).find(r => r.messageId === '<seven@example.com>').filePath).toBe(moved)

    // EACCES on one mailbox: its files still exist, so they are not stale
    const sentDir = path.join(acct, 'Sent Messages.mbox')
    fs.chmodSync(sentDir, 0o000)
    try {
      result = await indexer.indexEmails()
      expect(result.removed).toBeUndefined()
      expect(await rows()).toHaveLength(5)
    } finally {
      fs.chmodSync(sentDir, 0o755)
    }
  })

  it('an empty Mail scan never empties the index', async () => {
    // Every .emlx gone but the folder readable (e.g. Mail mid-rebuild)
    fs.rmSync(path.join(tmp, 'Library', 'Mail', 'V10'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'Library', 'Mail', 'V10'))
    const result = await indexer.indexEmails()
    expect(result.removed).toBeUndefined()
    expect(await rows()).toHaveLength(5)
  })
})
