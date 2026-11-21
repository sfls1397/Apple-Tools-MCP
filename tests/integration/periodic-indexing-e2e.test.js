
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TEST_TIMEOUT = 5 * 60 * 1000
const UNIQUE_MARKER = `periodic-test-${Date.now()}-${Math.random().toString(36).substring(7)}`
const ENV_KEYS = ['HOME', 'APPLE_TOOLS_INDEX_DIR', 'APPLE_TOOLS_META_FILE']

function writeEmlx (file, { messageId, subject, body }) {
  const text = [
    'From: Sender Example <sender@example.com>',
    'To: Me Example <me@example.com>',
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    '',
    body
  ].join('\n')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${Buffer.byteLength(text)}\n${text}`)
}

describe.skipIf(!process.env.RUN_E2E_TESTS)('Periodic Indexing E2E (temp HOME and index)', () => {
  const saved = {}
  let tmp
  let inbox
  let indexer
  let search

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-periodic-e2e-'))
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    process.env.HOME = tmp
    process.env.APPLE_TOOLS_INDEX_DIR = path.join(tmp, 'index')
    process.env.APPLE_TOOLS_META_FILE = path.join(tmp, 'index-meta.json')
    inbox = path.join(tmp, 'Library', 'Mail', 'V10', 'ACCT', 'INBOX.mbox', 'UUID', 'Data', 'Messages')
    writeEmlx(path.join(inbox, '1.emlx'), {
      messageId: '<existing@example.com>',
      subject: 'Quarterly garden club newsletter',
      body: 'Tomato seedlings, compost tips and the spring plant swap schedule.'
    })

    vi.resetModules()
    indexer = await import('../../indexer.js')
    search = await import('../../search.js')
    expect(indexer.INDEX_DIR).toBe(path.join(tmp, 'index'))

    const first = await indexer.indexEmails()
    expect(first.added).toBe(1)
  }, TEST_TIMEOUT)

  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('the next periodic pass indexes a newly arrived email and mail_search finds its marker', async () => {
    writeEmlx(path.join(inbox, '2.emlx'), {
      messageId: `<${UNIQUE_MARKER}@example.com>`,
      subject: `Test Email - ${UNIQUE_MARKER}`,
      body: `This is a test email for periodic indexing verification.\n\nUnique ID: ${UNIQUE_MARKER}`
    })

    const pass = await indexer.indexEmails()
    expect(pass.added).toBe(1)

    const result = await search.searchEmails(UNIQUE_MARKER, { limit: 10 })
    expect(result.success).toBe(true)
    const hit = result.results.find(r => r.subject.includes(UNIQUE_MARKER))
    expect(hit).toBeTruthy()
    expect(hit.filePath).toBe(path.join(inbox, '2.emlx'))
    expect(hit.filePath.startsWith(tmp)).toBe(true)
  }, TEST_TIMEOUT)

  it('finds the new email by meaning, ahead of the unrelated one', async () => {
    const result = await search.searchEmails('periodic indexing verification test', { limit: 10 })
    expect(result.success).toBe(true)
    expect(result.results.length).toBeGreaterThan(0)
    expect(result.results[0].subject).toContain(UNIQUE_MARKER)
  }, TEST_TIMEOUT)

  it('a quiet pass adds nothing', async () => {
    expect(await indexer.indexEmails()).toMatchObject({ added: 0 })
  }, TEST_TIMEOUT)
})
