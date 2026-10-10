/**
 * Unit tests for mail_links (decoded links in one message).
 *
 * Messages are synthetic RFC822 text wrapped the way Mail stores .emlx
 * files; the locate test builds a throwaway Mail folder tree. Nothing here
 * reads real Mail data.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  emlxMessageBytes,
  decodeQuotedPrintable,
  mimeTextParts,
  htmlLinks,
  textLinks,
  messageLinks,
  messageDataDir,
  locateEmlx,
  mailLinks
} from '../../lib/mailLinks.js'

const ACCT = '4C4A53E8-CD12-47E0-AFBE-F058004EB1D5'
const SIGN_IN = 'https://links.example.com/tr/cl/AbCdEf0123456789-_xyz?u=1&v=2'

function emlx(rfc822) {
  const body = Buffer.from(rfc822, 'utf8')
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, Buffer.from('<?xml version="1.0"?><plist><dict/></plist>\n')])
}

/** Quoted-printable with a soft break in the middle of the href, as mailers send it. */
const QP_MESSAGE = [
  'From: Example <noreply@example.com>',
  'Subject: Your Sign-in Link',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Open the email in a browser that shows links.',
  '--b1',
  'Content-Type: text/html; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<p>Hi</p><a href=3D"https://links.example.com/tr/cl/AbCdEf0123456789-_xyz?u=3D=',
  '1&amp;v=3D2" style=3D"color:#fff"><span>Sign In to Example</span></a>',
  '<a href=3D"mailto:help@example.com">Help</a> <a href=3D"https://example.com/=',
  'privacy">Privacy &amp; Terms</a>',
  '--b1--',
  ''
].join('\r\n')

describe('emlx and MIME decoding', () => {
  it('reads only the counted RFC822 bytes, not the trailing plist', () => {
    const msg = emlxMessageBytes(emlx('Subject: x\n\nbody'))
    expect(msg.toString()).toBe('Subject: x\n\nbody')
  })

  it('decodes quoted-printable soft breaks and escapes', () => {
    expect(decodeQuotedPrintable(Buffer.from('a=3Db=\r\nc=C3=A9')).toString('utf8')).toBe('a=bcé')
  })

  it('returns the text leaves of a multipart message', () => {
    const parts = mimeTextParts(emlxMessageBytes(emlx(QP_MESSAGE)))
    expect(parts.map((p) => p.type)).toEqual(['text/plain', 'text/html'])
  })

  it('decodes a base64 HTML part inside nested multiparts', () => {
    const html = Buffer.from(`<a href="${SIGN_IN.replace('&', '&amp;')}">Sign In</a>`).toString('base64')
    const msg = [
      'Content-Type: multipart/mixed; boundary=outer',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary=inner',
      '',
      '--inner',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      html.slice(0, 40),
      html.slice(40),
      '--inner--',
      '--outer',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--outer--',
      ''
    ].join('\n')
    expect(messageLinks(Buffer.from(msg))).toEqual([{ text: 'Sign In', url: SIGN_IN }])
  })
})

describe('link extraction', () => {
  it('rebuilds a quoted-printable href and keeps visible text', () => {
    const links = messageLinks(emlxMessageBytes(emlx(QP_MESSAGE)))
    expect(links).toEqual([
      { text: 'Sign In to Example', url: SIGN_IN },
      { text: 'Privacy & Terms', url: 'https://example.com/privacy' }
    ])
  })

  it('skips non-http links and anchors without href', () => {
    expect(htmlLinks('<a name="top">x</a><a href="javascript:alert(1)">y</a><abbr>z</abbr><a href=\'https://a.example/\'>ok</a>')).toEqual([
      { text: 'ok', url: 'https://a.example/' }
    ])
  })

  it('handles unquoted hrefs, > inside quoted attributes, and a missing </a>', () => {
    expect(htmlLinks('<a title="a>b" href=https://a.example/x>one</a><a href="https://b.example/">two')).toEqual([
      { text: 'one', url: 'https://a.example/x' },
      { text: 'two', url: 'https://b.example/' }
    ])
  })

  it('finds bare URLs in plain text and trims trailing punctuation', () => {
    expect(textLinks('Go to https://a.example/path?x=1. Or (https://b.example/).')).toEqual([
      { text: '', url: 'https://a.example/path?x=1' },
      { text: '', url: 'https://b.example/' }
    ])
  })

  it('stays linear on a long run of unmatched "<a" openings', () => {
    const start = Date.now()
    htmlLinks('<a '.repeat(200000))
    expect(Date.now() - start).toBeLessThan(2000)
  })
})

describe('locating the message file', () => {
  it('shards by id/1000 digits reversed', () => {
    expect(messageDataDir(73690)).toBe(path.join('Data', '3', '7', 'Messages'))
    expect(messageDataDir(512)).toBe(path.join('Data', 'Messages'))
  })

  it('finds .emlx or .partial.emlx under nested mailboxes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-links-'))
    try {
      const indexPath = path.join(root, 'V10', 'MailData', 'Envelope Index')
      fs.mkdirSync(path.dirname(indexPath), { recursive: true })
      fs.writeFileSync(indexPath, '')
      const inbox = path.join(root, 'V10', ACCT, 'INBOX.mbox', 'STORE-1', 'Data', '3', '7', 'Messages')
      fs.mkdirSync(inbox, { recursive: true })
      fs.writeFileSync(path.join(inbox, '73691.partial.emlx'), 'x')
      const nested = path.join(root, 'V10', ACCT, 'Work.mbox', 'Projects 2026.mbox', 'STORE-2', 'Data', 'Messages')
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(nested, '42.emlx'), 'x')

      const local = path.join(root, 'V10', 'Mailboxes', 'Receipts.mbox', 'STORE-3', 'Data', 'Messages')
      fs.mkdirSync(local, { recursive: true })
      fs.writeFileSync(path.join(local, '7.emlx'), 'x')

      expect(locateEmlx(73691, `imap://${ACCT}/INBOX`, { indexPath })).toEqual({ file: path.join(inbox, '73691.partial.emlx'), mailboxFound: true })
      expect(locateEmlx(42, `imap://${ACCT}/Work/Projects%202026`, { indexPath })).toEqual({ file: path.join(nested, '42.emlx'), mailboxFound: true })
      expect(locateEmlx(7, 'local:///Receipts', { indexPath })).toEqual({ file: path.join(local, '7.emlx'), mailboxFound: true })
      expect(locateEmlx(73690, `imap://${ACCT}/INBOX`, { indexPath })).toEqual({ file: null, mailboxFound: true })
      expect(locateEmlx(42, 'imap://not-an-account/Nowhere', { indexPath })).toEqual({ file: null, mailboxFound: false })
      expect(locateEmlx(42, `imap://${ACCT}/..%2F..%2Fetc`, { indexPath })).toEqual({ file: null, mailboxFound: false })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('mail_links tool', () => {
  const query = (rows) => () => rows

  it('returns the decoded links for an id', () => {
    const out = JSON.parse(
      mailLinks({ id: 73691 }, {
        indexPath: '/x/V10/MailData/Envelope Index',
        query: query([{ id: 73691, mailbox_url: `imap://${ACCT}/INBOX` }]),
        locate: () => ({ file: '/x/73691.partial.emlx', mailboxFound: true }),
        readFile: () => emlx(QP_MESSAGE)
      })
    )
    expect(out).toMatchObject({ id: 73691, found: true, downloaded: true, count: 2 })
    expect(out.links[0]).toEqual({ text: 'Sign In to Example', url: SIGN_IN })
  })

  it('says when Mail has the message but not its file yet', () => {
    const out = JSON.parse(
      mailLinks({ id: 5 }, { indexPath: '/x', query: query([{ id: 5, mailbox_url: `imap://${ACCT}/INBOX` }]), locate: () => ({ file: null, mailboxFound: true }) })
    )
    expect(out).toMatchObject({ found: true, downloaded: false })
  })

  it('says retrying will not help when the mailbox folder cannot be found', () => {
    const out = JSON.parse(
      mailLinks({ id: 5 }, { indexPath: '/x', query: query([{ id: 5, mailbox_url: 'local:///Gone' }]), locate: () => ({ file: null, mailboxFound: false }) })
    )
    expect(out).toMatchObject({ found: true, located: false })
    expect(out.downloaded).toBeUndefined()
  })

  it('says when the id is not in Mail', () => {
    expect(JSON.parse(mailLinks({ id: 5 }, { indexPath: '/x', query: query([]) }))).toMatchObject({ found: false })
  })

  it('rejects a missing or non-integer id', () => {
    expect(() => mailLinks({}, { indexPath: '/x', query: query([]) })).toThrow(/mail_links: id/)
    expect(() => mailLinks({ id: '1; DROP' }, { indexPath: '/x', query: query([]) })).toThrow(/mail_links: id/)
  })
})
