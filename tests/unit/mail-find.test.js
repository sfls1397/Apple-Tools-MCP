/**
 * Unit tests for mail_find (exact lookup in Mail's Envelope Index).
 *
 * The query tests run against a throwaway SQLite file with the slice of
 * Mail's schema the lookup reads, built with the sqlite3 CLI, so they need
 * no Mail data and never touch the real Envelope Index.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  parseMailboxUrl,
  mailboxKind,
  validateFindArgs,
  buildFindQuery,
  findMail,
  locateMessageCopies,
  mailFind,
  envelopeIndexPath
} from '../../lib/mailFind.js'

const ACCT = '4C4A53E8-CD12-47E0-AFBE-F058004EB1D5'
const NOW = Date.parse('2026-10-01T12:00:00Z')
const HOUR = 3600
const nowSec = NOW / 1000

const SCHEMA = `
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, global_message_id INTEGER, sender INTEGER, subject_prefix TEXT, subject INTEGER NOT NULL, date_received INTEGER, mailbox INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY, message INTEGER NOT NULL, address INTEGER NOT NULL, type INTEGER, position INTEGER);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id_header TEXT);
INSERT INTO mailboxes VALUES (1, 'imap://${ACCT}/INBOX'), (2, 'imap://${ACCT}/Sent%20Messages'), (3, 'imap://${ACCT}/Deleted%20Messages'), (4, 'imap://${ACCT}/Work/Projects%202026');
INSERT INTO addresses VALUES (1, 'me@me.com', ''), (2, 'me@icloud.com', ''), (3, 'stranger@example.com', ''), (4, 'other@example.com', '');
INSERT INTO subjects VALUES (1, '[Network] Internet down'), (2, '[Network] Internet back'), (3, 'Lunch?'), (4, '[Network] spoof from a stranger'), (5, '50% off_sale''s here');
INSERT INTO message_global_data VALUES (1, '<a1@me.com>'), (2, '<a2@me.com>'), (3, '<lunch@example.com>'), (4, '<spoof@example.com>'), (5, '<sale@example.com>'), (6, '<old@me.com>');
-- a1: old alert, copy in Sent and INBOX
INSERT INTO messages VALUES (10, 1, 1, '', 1, ${nowSec - 30 * HOUR}, 2, 0), (11, 1, 1, '', 1, ${nowSec - 30 * HOUR + 15}, 1, 0);
-- a2: fresh alert (2h old)
INSERT INTO messages VALUES (12, 2, 1, '', 2, ${nowSec - 2 * HOUR}, 2, 0), (13, 2, 1, '', 2, ${nowSec - 2 * HOUR + 15}, 1, 0);
-- old alert already in Trash
INSERT INTO messages VALUES (14, 6, 1, '', 1, ${nowSec - 40 * HOUR}, 3, 0);
-- not an alert
INSERT INTO messages VALUES (15, 3, 3, '', 3, ${nowSec - 50 * HOUR}, 1, 0);
-- [Network] prefix but from a stranger, and with two recipients
INSERT INTO messages VALUES (16, 4, 3, '', 4, ${nowSec - 50 * HOUR}, 1, 0);
-- LIKE metacharacters in the subject, filed in a nested mailbox
INSERT INTO messages VALUES (17, 5, 4, '', 5, ${nowSec - 50 * HOUR}, 4, 0);
-- deleted row Mail has not purged yet
INSERT INTO messages VALUES (18, 1, 1, '', 1, ${nowSec - 30 * HOUR}, 1, 1);
INSERT INTO recipients (message, address, type, position) VALUES
  (10, 2, 0, 0), (11, 2, 0, 0), (12, 2, 0, 0), (13, 2, 0, 0), (14, 2, 0, 0),
  (15, 2, 0, 0), (16, 2, 0, 0), (16, 4, 0, 1), (17, 2, 0, 0), (18, 2, 0, 0);
`

let dir
let dbPath
const opts = () => ({ dbPath, now: NOW })
const find = (args) => {
  const { filters, error } = validateFindArgs(args, { now: NOW })
  if (error) throw new Error(error)
  return findMail(filters, { dbPath }).messages
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-find-'))
  dbPath = path.join(dir, 'Envelope Index')
  const r = spawnSync('sqlite3', [dbPath], { input: SCHEMA, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(r.stderr)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('mailbox URLs', () => {
  it('parses account id and decodes nested mailbox paths', () => {
    expect(parseMailboxUrl(`imap://${ACCT}/Sent%20Messages`)).toEqual({ scheme: 'imap', accountId: ACCT, mailboxPath: 'Sent Messages' })
    expect(parseMailboxUrl(`imap://${ACCT}/Work/Projects%202026`).mailboxPath).toBe('Work/Projects 2026')
    expect(parseMailboxUrl(`imap://${ACCT}/%5BGmail%5D/Trash`).mailboxPath).toBe('[Gmail]/Trash')
  })

  it('leaves local mailboxes without an account id', () => {
    expect(parseMailboxUrl('local:///Archive').accountId).toBeNull()
    expect(parseMailboxUrl('not a url')).toBeNull()
  })

  it('classifies mailbox kinds by leaf name', () => {
    expect(mailboxKind('INBOX')).toBe('inbox')
    expect(mailboxKind('Sent Messages')).toBe('sent')
    expect(mailboxKind('Deleted Messages')).toBe('trash')
    expect(mailboxKind('[Gmail]/Trash')).toBe('trash')
    expect(mailboxKind('Work/Projects 2026')).toBe('other')
  })

  it('finds the newest V<n> Envelope Index', () => {
    const mailDir = path.join(dir, 'Mail')
    for (const v of ['V9', 'V10']) fs.mkdirSync(path.join(mailDir, v, 'MailData'), { recursive: true })
    fs.writeFileSync(path.join(mailDir, 'V9', 'MailData', 'Envelope Index'), '')
    expect(envelopeIndexPath(mailDir)).toBe(path.join(mailDir, 'V9', 'MailData', 'Envelope Index'))
    fs.writeFileSync(path.join(mailDir, 'V10', 'MailData', 'Envelope Index'), '')
    expect(envelopeIndexPath(mailDir)).toBe(path.join(mailDir, 'V10', 'MailData', 'Envelope Index'))
    expect(envelopeIndexPath(path.join(dir, 'missing'))).toBeNull()
  })
})

describe('validateFindArgs', () => {
  it('needs at least one narrowing filter', () => {
    expect(validateFindArgs({ older_than_hours: 24 }).error).toContain('at least one')
  })

  it('rejects bad input instead of guessing', () => {
    expect(validateFindArgs({ to: 'not an address' }).error).toContain('to')
    expect(validateFindArgs({ subject_prefix: 'x', mailboxes: ['outbox'] }).error).toContain('mailboxes')
    expect(validateFindArgs({ subject_prefix: 'x', received_after: 'yesterday-ish' }).error).toContain('received_after')
    expect(validateFindArgs({ subject_prefix: 'x', older_than_hours: -1 }).error).toContain('older_than_hours')
    expect(validateFindArgs({ subject_prefix: 'x', limit: 5000 }).error).toContain('limit')
    expect(validateFindArgs({ message_ids: ['bad id with spaces'] }).error).toContain('Message-ID')
    expect(validateFindArgs({ subject_prefix: 'x', to_only: true }).error).toContain('to_only')
  })

  it('turns older_than_hours into a cutoff and keeps the earlier of two cutoffs', () => {
    const { filters } = validateFindArgs({ subject_prefix: 'x', older_than_hours: 24 }, { now: NOW })
    expect(filters.receivedBefore).toBe(nowSec - 24 * HOUR)
    const both = validateFindArgs({ subject_prefix: 'x', older_than_hours: 1, received_before: '2026-09-01T00:00:00Z' }, { now: NOW })
    expect(both.filters.receivedBefore).toBe(Date.parse('2026-09-01T00:00:00Z') / 1000)
  })

  it('escapes quotes and LIKE wildcards so input is always literal', () => {
    const { filters } = validateFindArgs({ subject_contains: "50% off_sale's" })
    const sql = buildFindQuery(filters)
    expect(sql).toContain("LIKE '%50\\% off\\_sale''s%' ESCAPE '\\'")
  })
})

describe('findMail against an Envelope Index fixture', () => {
  it('matches alert emails exactly: prefix, from me, sole recipient, older than 24h, outside Trash', () => {
    const rows = find({ subject_prefix: '[Network] ', from_me: true, to: 'me@icloud.com', to_only: true, older_than_hours: 24 })
    expect(rows.map((r) => r.id).sort()).toEqual([10, 11])
    const inbox = rows.find((r) => r.id === 11)
    expect(inbox).toMatchObject({
      message_id: 'a1@me.com',
      subject: '[Network] Internet down',
      from: 'me@me.com',
      to: ['me@icloud.com'],
      mailbox: 'inbox',
      mailbox_path: 'INBOX',
      account_id: ACCT
    })
    expect(inbox.received).toBe(new Date((nowSec - 30 * HOUR + 15) * 1000).toISOString())
  })

  it('includes fresh alerts when no age filter is given, and Trash only on request', () => {
    expect(find({ subject_prefix: '[Network] ', from_me: true }).map((r) => r.id).sort()).toEqual([10, 11, 12, 13])
    expect(find({ subject_prefix: '[Network] ', from_me: true, include_trash: true }).map((r) => r.id)).toContain(14)
    expect(find({ subject_prefix: '[Network] ', mailboxes: ['trash'] }).map((r) => r.id)).toEqual([14])
    expect(find({ subject_prefix: '[Network] ', from_me: true, mailboxes: ['sent'] }).map((r) => r.id).sort()).toEqual([10, 12])
  })

  it('does not count a stranger as me, nor a two-recipient message as to_only', () => {
    const prefixOnly = find({ subject_prefix: '[Network] ' }).map((r) => r.id)
    expect(prefixOnly).toContain(16)
    expect(find({ subject_prefix: '[Network] ', from_me: true }).map((r) => r.id)).not.toContain(16)
    expect(find({ subject_prefix: '[Network] ', to: 'me@icloud.com', to_only: true }).map((r) => r.id)).not.toContain(16)
  })

  it('treats LIKE metacharacters literally', () => {
    expect(find({ subject_contains: '50% off_sale' }).map((r) => r.id)).toEqual([17])
    expect(find({ subject_contains: '50x off' })).toEqual([])
  })

  it('reports truncation', () => {
    const { filters } = validateFindArgs({ subject_prefix: '[Network] ', limit: 1 })
    const out = findMail(filters, { dbPath })
    expect(out.messages).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('mailFind returns JSON text and throws on bad args', () => {
    const parsed = JSON.parse(mailFind({ message_ids: ['<a2@me.com>'] }, opts()))
    expect(parsed.count).toBe(2)
    expect(parsed.truncated).toBe(false)
    expect(() => mailFind({}, opts())).toThrow('mail_find:')
  })

  it('locateMessageCopies splits live copies from ids with nothing outside Trash', () => {
    const { copies, missingIds } = locateMessageCopies(['a1@me.com', 'old@me.com', 'nope@me.com'], { dbPath })
    expect(copies.map((c) => c.id).sort()).toEqual([10, 11])
    expect(missingIds).toEqual(['old@me.com', 'nope@me.com'])
  })

  it('explains Full Disk Access when the index cannot be opened', () => {
    const { filters } = validateFindArgs({ subject_prefix: 'x' })
    expect(() => findMail(filters, { dbPath: path.join(dir, 'no-such-dir', 'Envelope Index') })).toThrow('Full Disk Access')
  })
})
