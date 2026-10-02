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
  buildFindSentBySubjectScript
} from '../../lib/mailWrite.js'

const scripts = {
  inReplyTo: buildFindSentByInReplyToScript('abc@example.com'),
  forward: buildFindSentForwardScript('abc@example.com', ['a@example.com']),
  recipientAndSubject: buildFindSentByRecipientAndSubjectScript('Status update', ['a@example.com'], 'id@example.com'),
  subject: buildFindSentBySubjectScript('Status update', ['a@example.com'])
}

describe('Sent/Outbox verify scripts', () => {
  it.each(Object.entries(scripts))('%s uses Mail\'s outbox term', (_name, script) => {
    expect(script).not.toContain('outgoing mailbox')
  })

  it.runIf(process.platform === 'darwin').each(Object.entries(scripts))('%s compiles with osacompile', (_name, script) => {
    expect(() => execFileSync('osacompile', ['-o', '/dev/null', '-e', script], { stdio: 'pipe' })).not.toThrow()
  })
})
