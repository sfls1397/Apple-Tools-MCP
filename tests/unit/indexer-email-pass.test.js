/**
 * End-to-end indexEmails() passes against a temporary Mail folder and index
 * (fake HOME, mocked embedder, real LanceDB):
 * - an IMAP copy skipped as a duplicate Message-ID does not come back on the
 *   next pass, so a quiet pass takes the early exit
 * - quiet passes read no ID columns at all (cache kept between passes)
 * - the summary counts only rows actually added, not skipped copies
 * - indexAll() compacts once after a writing pass, then waits a day
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => async (texts) => {
    const list = Array.isArray(texts) ? texts : [texts]
    const data = new Float32Array(list.length * 384)
    list.forEach((t, i) => { data[i * 384] = (t.length % 97) / 97 })
    return { data }
  }
}))

const saved = {}
let tmp
let indexer
let logs = []
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

function summary () {
  const text = logs.join('\n')
  const last = text.lastIndexOf('Email indexing summary:')
  return last >= 0 ? text.slice(last) : ''
}

describe('indexEmails passes (fake Mail folder)', () => {
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-email-pass-'))
    for (const k of ['HOME', 'APPLE_TOOLS_INDEX_DIR', 'APPLE_TOOLS_META_FILE']) saved[k] = process.env[k]
    process.env.HOME = tmp
    process.env.APPLE_TOOLS_INDEX_DIR = path.join(tmp, 'index')
    process.env.APPLE_TOOLS_META_FILE = path.join(tmp, 'index-meta.json')

    const acct = path.join(tmp, 'Library', 'Mail', 'V10', 'ACCT')
    writeEmlx(path.join(acct, 'INBOX.mbox', 'Messages', '1.emlx'), { messageId: '<one@example.com>', subject: 'First fixture' })
    writeEmlx(path.join(acct, 'INBOX.mbox', 'Messages', '2.emlx'), { messageId: '<two@example.com>', subject: 'Second fixture' })
    // Same Message-ID as 1.emlx in another folder (IMAP copy)
    writeEmlx(path.join(acct, 'Archive.mbox', 'Messages', '3.emlx'), { messageId: '<one@example.com>', subject: 'First fixture' })

    origError = console.error
    console.error = (...args) => { logs.push(args.join(' ')) }
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

  it('first pass indexes the two unique emails and counts the copy as skipped, not indexed', async () => {
    logs = []
    const result = await indexer.indexEmails()
    expect(result.added).toBe(2)
    expect(result.indexed).toBe(2)
    const s = summary()
    expect(s).toContain('Files to index: 3')
    expect(s).toContain('Successfully indexed: 2')
    expect(s).toContain('Skipped - duplicate messageId: 1')
    expect(s).toContain('Discrepancy: 0')
  })

  it('second pass skips the known copy before parsing and takes the early exit with no ID reads', async () => {
    const table = await indexer.getOpenTable('emails')
    let idReads = 0
    const origQuery = table.query.bind(table)
    table.query = (...a) => { idReads++; return origQuery(...a) }
    try {
      logs = []
      const result = await indexer.indexEmails()
      expect(result).toEqual({ indexed: 2, added: 0 })
      const text = logs.join('\n')
      expect(text).toContain('Known duplicate copies (already indexed by Message-ID): 1')
      expect(text).toContain('Need to index: 0 emails')
      expect(text).not.toContain('Email indexing summary:')
      expect(idReads).toBe(0)
    } finally {
      table.query = origQuery
    }
  })

  it('a pass with one new email adds exactly one row without re-reading the ID columns', async () => {
    writeEmlx(path.join(tmp, 'Library', 'Mail', 'V10', 'ACCT', 'INBOX.mbox', 'Messages', '4.emlx'), { messageId: '<four@example.com>', subject: 'Fourth fixture' })
    const table = await indexer.getOpenTable('emails')
    let idReads = 0
    const origQuery = table.query.bind(table)
    table.query = (...a) => { idReads++; return origQuery(...a) }
    try {
      logs = []
      const result = await indexer.indexEmails()
      expect(result).toEqual({ indexed: 3, added: 1 })
      const s = summary()
      expect(s).toContain('Files to index: 1')
      expect(s).toContain('Successfully indexed: 1')
      expect(s).toContain('Discrepancy: 0')
      expect(idReads).toBe(0)
      expect(await table.countRows()).toBe(3)
    } finally {
      table.query = origQuery
    }
  })

  it('indexAll compacts after a writing pass and not again the same day', async () => {
    const inbox = path.join(tmp, 'Library', 'Mail', 'V10', 'ACCT', 'INBOX.mbox', 'Messages')
    writeEmlx(path.join(inbox, '5.emlx'), { messageId: '<five@example.com>', subject: 'Fifth fixture' })
    logs = []
    await indexer.indexAll()
    let text = logs.join('\n')
    expect(text).toContain('Optimizing index tables')
    expect(text).toMatch(/Optimized emails: fragments -\d+ \+1/)
    const meta = JSON.parse(fs.readFileSync(process.env.APPLE_TOOLS_META_FILE, 'utf8'))
    expect(typeof meta.lastIndexOptimizeTime).toBe('number')
    const table = await indexer.getOpenTable('emails')
    expect(await table.countRows()).toBe(4)

    writeEmlx(path.join(inbox, '6.emlx'), { messageId: '<six@example.com>', subject: 'Sixth fixture' })
    logs = []
    await indexer.indexAll()
    text = logs.join('\n')
    expect(text).toContain('Successfully indexed: 1')
    expect(text).not.toContain('Optimizing index tables')
    expect(await (await indexer.getOpenTable('emails')).countRows()).toBe(5)
  })
})
