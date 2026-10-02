/**
 * The Sent/Outbox verify scripts must compile against Mail's dictionary.
 *
 * Until 3.0.7 they said `outgoing mailbox`, which isn't a Mail term (it's
 * `outbox`). osascript rejected every one with -2741 before running, the
 * failure was swallowed as "not found", and every real mail_send /
 * mail_reply / mail_forward came back "unconfirmed" even when it landed
 * in Sent. Mocked-osascript tests can't catch that, so compile them here.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import {
  buildFindSentByInReplyToScript,
  buildFindSentForwardScript,
  buildFindSentByRecipientAndSubjectScript,
  buildFindSentBySubjectScript,
  buildReplyScript,
  buildForwardScript
} from '../../lib/mailWrite.js'

const scripts = {
  inReplyTo: buildFindSentByInReplyToScript('abc@example.com'),
  forward: buildFindSentForwardScript('abc@example.com', ['a@example.com']),
  recipientAndSubject: buildFindSentByRecipientAndSubjectScript('Status update', ['a@example.com'], 'id@example.com'),
  subject: buildFindSentBySubjectScript('Status update', ['a@example.com'])
}

const writeScripts = {
  reply: buildReplyScript({
    messageId: 'abc@example.com',
    body: 'Thanks\n---\nTXID: 1',
    replyAll: false,
    sendNow: true
  }),
  forward: buildForwardScript({
    messageId: 'abc@example.com',
    to: ['a@example.com'],
    body: 'FYI',
    sendNow: true
  })
}

describe('Sent/Outbox verify scripts', () => {
  it.each(Object.entries(scripts))('%s uses Mail\'s outbox term', (_name, script) => {
    expect(script).not.toContain('outgoing mailbox')
  })

  it.runIf(process.platform === 'darwin').each(Object.entries(scripts))('%s compiles with osacompile', (_name, script) => {
    expect(() => execFileSync('osacompile', ['-o', '/dev/null', '-e', script], { stdio: 'pipe' })).not.toThrow()
  })
})

describe('reply/forward body-fill scripts', () => {
  it.each(Object.entries(writeScripts))('%s pastes the intro and does not set AppleScript content', (_name, script) => {
    expect(script).toContain('atmFillMailBody')
    expect(script).toContain('with opening window')
    expect(script).toContain(', false)')
    expect(script).not.toContain('set content to')
    expect(script).not.toMatch(/content:/)
    expect(script).not.toContain('without opening window')
    expect(script).toContain('delete the')
  })

  it.runIf(process.platform === 'darwin').each(Object.entries(writeScripts))('%s compiles with osacompile', (_name, script) => {
    expect(() => execFileSync('osacompile', ['-o', '/dev/null', '-e', script], { stdio: 'pipe' })).not.toThrow()
  })
})
