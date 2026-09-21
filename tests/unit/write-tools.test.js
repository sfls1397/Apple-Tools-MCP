/**
 * Unit tests for the 2.0.0 write tools.
 *
 * osascript is mocked the way the rest of the suite mocks shell wrappers, so
 * these run anywhere: they assert on the AppleScript that would run, on
 * escaping, and on the dry_run / confirm gates that keep it from running.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { MAIL_TCC_GUIDANCE, MAIL_SEND_TIMEOUT_GUIDANCE } from '../../lib/appleScript.js'

const osascript = vi.hoisted(() => vi.fn(() => ''))

vi.mock('../../lib/shell.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, safeOsascript: osascript }
})

import {
  mailCompose,
  mailReply,
  mailForward,
  mailMark,
  mailArchive,
  mailTrash,
  resolveMailMessageId,
  probeMailAutomation,
  buildMailAutomationProbeScript,
  buildFindSentByInReplyToScript,
  buildFindSentBySubjectScript,
  buildFindSentForwardScript,
  recoverIfInSent,
  isMailHardTcc,
  isMailSendTimeout
} from '../../lib/mailWrite.js'
import { messagesSend, validateAttachmentPath, lookupChat, probeMessagesAutomation, buildMessagesAutomationProbeScript } from '../../lib/messagesWrite.js'
import {
  calendarAdd,
  calendarEdit,
  calendarRemove,
  calendarRsvp,
  calendarListCalendars,
  probeCalendarAutomation,
  buildCalendarAutomationProbeScript,
  buildRecurrenceRule,
  buildRemoveEventScript,
  buildEventKitRemoveScript,
  buildEventKitAddScript,
  parseEventKitAddOutput,
  eventKitLookupIds,
  parseEventKitCalendarList,
  mergeCalendarSources,
  describeCalendarRemoveFailure,
  validateAlerts,
  defaultEndParts
} from '../../lib/calendarWrite.js'
import { setEventKitSession } from '../../lib/eventKitSession.js'
import {
  contactsAdd,
  contactsEdit,
  contactsRemove,
  probeContactsAutomation,
  buildContactsAutomationProbeScript,
  buildContactsProbeCleanupScript
} from '../../lib/contactsWrite.js'
import {
  WRITE_TOOL_DEFINITIONS,
  WRITE_TOOL_NAMES,
  WRITE_TOOL_HANDLERS,
  SMOKE_ONLY_AUTOMATION_PROBES,
  isWriteTool,
  executeWriteToolLocally,
  dispatchWriteTool
} from '../../lib/writeTools.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

beforeEach(() => {
  osascript.mockReset()
  osascript.mockReturnValue('')
  setEventKitSession(null)
})

function lastScript() {
  expect(osascript).toHaveBeenCalled()
  return osascript.mock.calls[osascript.mock.calls.length - 1][0]
}

// ============ MAIL ============

describe('mail_send', () => {
  it('sends to a single recipient and reports what happened', () => {
    const result = mailCompose({ to: ['peter@example.com'], subject: 'Status', body: 'All good' })

    expect(result.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(1)
    const script = lastScript()
    expect(script).toContain('make new outgoing message')
    expect(script).toContain('address:"peter@example.com"')
    expect(script).toContain('send newMessage')
    expect(result.message).toContain('peter@example.com')
    expect(result.message).toContain('Status')
  })

  it('refuses to invent a recipient', () => {
    const result = mailCompose({ subject: 'Status', body: 'All good' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('never invents recipients')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('blocks a multi-recipient send until confirmed', () => {
    const args = { to: ['a@example.com', 'b@example.com'], subject: 'Hi', body: 'Hello' }

    const blocked = mailCompose(args)
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()

    const confirmed = mailCompose({ ...args, confirm: true })
    expect(confirmed.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(1)
  })

  it('counts cc and bcc toward the multi-recipient gate', () => {
    const result = mailCompose({
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Hi',
      body: 'Hello'
    })
    expect(result.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('previews without sending on dry_run', () => {
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'Hello', dry_run: true })
    expect(result.message).toContain('DRY RUN')
    expect(result.message).toContain('a@example.com')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('escapes quotes and newlines in the body instead of injecting AppleScript', () => {
    mailCompose({
      to: ['a@example.com'],
      subject: 'Hi',
      body: 'x" & do shell script "whoami" & "\nend tell'
    })
    const script = lastScript()
    expect(script).not.toContain('do shell script "whoami"')
    expect(script).toContain('\\" & do shell script \\"whoami\\"')
    expect(script).not.toMatch(/\nend tell\n.*do shell/)
  })

  it('sends HTML when body_format is html, keeping a plain-text alternative', () => {
    const result = mailCompose({
      to: ['a@example.com'],
      subject: 'Report',
      body: '<p>All <b>good</b></p>',
      body_format: 'html'
    })

    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('set html content of newMessage to "<p>All <b>good</b></p>"')
    // content carries the tag-stripped text so non-HTML clients still read it.
    expect(script).toContain('content:"All good"')
  })

  it('defaults to a plain text body', () => {
    mailCompose({ to: ['a@example.com'], subject: 'Report', body: 'All good' })
    const script = lastScript()
    expect(script).toContain('content:"All good"')
    expect(script).not.toContain('html content')
  })

  it('rejects an unknown body_format', () => {
    const result = mailCompose({ to: ['a@example.com'], subject: 'x', body: 'y', body_format: 'markdown' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('body_format must be')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('does not echo the body when Mail fails', () => {
    osascript.mockImplementation(() => {
      throw new Error('Mail got an error: secret body text here')
    })
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'secret body text here' })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('secret body text here')
    expect(result.message).toContain('mail_send failed')
  })

  it('treats a hung send as a timeout, verifies Sent, and does not label it TCC', () => {
    osascript
      .mockImplementationOnce(() => {
        throw new Error('spawnSync osascript ETIMEDOUT')
      })
      .mockImplementationOnce(() => 'NOT_FOUND')
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'Hello' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).toContain('find/reply/send hang')
    expect(result.message).toContain('not a TCC / Automation deny')
    expect(result.message).toContain('Check Sent')
    expect(result.message).toContain('before retrying')
    expect(result.message).not.toContain('macOS denied Mail automation')
    expect(result.message).not.toContain('could not be reached')
    expect(osascript).toHaveBeenCalledTimes(2)
    const verifyScript = osascript.mock.calls[1][0]
    expect(verifyScript).toContain('subject is "Hi"')
    expect(verifyScript).toContain('sent mailbox')
  })

  it('returns success when a hung send is already in Sent', () => {
    osascript
      .mockImplementationOnce(() => {
        throw new Error('spawnSync osascript ETIMEDOUT')
      })
      .mockImplementationOnce(() => 'FOUND')
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'Hello' })
    expect(result.ok).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.message).toContain('mail_send: sent')
    expect(result.message).toContain('verified in Sent')
    expect(result.message).not.toContain('TCC')
    expect(result.message).not.toContain('timed out')
  })

  it('labels a hard Mail deny as TCC and does not Sent-check', () => {
    osascript.mockImplementation(() => {
      throw new Error('Not authorized to send Apple events to Mail. (-1743)')
    })
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'Hello' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).not.toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).toContain('TCC / Automation deny')
    expect(result.message).not.toContain('find/reply/send hang')
    expect(osascript).toHaveBeenCalledTimes(1)
  })
})

describe('mail_automation_probe', () => {
  it('composes then deletes and never sends', () => {
    const script = buildMailAutomationProbeScript()
    expect(script).toContain('make new outgoing message')
    expect(script).toContain('delete probe')
    expect(script).not.toContain('send ')

    const result = probeMailAutomation()
    expect(result.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(result.message).toContain('nothing was sent')
  })

  it('maps a compose hang to timeout guidance, not MAIL_TCC_GUIDANCE', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = probeMailAutomation()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('timeout')
    expect(result.message).toContain('mail_automation_probe failed')
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).not.toContain('could not be reached')
  })
})

describe('contacts_automation_probe', () => {
  it('creates then deletes a throwaway person and never leaves the probe name without cleanup', () => {
    const script = buildContactsAutomationProbeScript()
    expect(script).toContain('tell application "Contacts"')
    expect(script).toContain('make new person')
    expect(script).toContain('delete probe')
    expect(script).toContain('save')
    expect(script).not.toContain('dry_run')

    const cleanup = buildContactsProbeCleanupScript()
    expect(cleanup).toContain('every person whose first name is "ATM"')
    expect(cleanup).toContain('Permissions Probe')

    const result = probeContactsAutomation()
    expect(result.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(2)
    expect(result.message).toContain('throwaway contact')
  })

  it('maps a hang to Contacts Automation denied', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = probeContactsAutomation()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('contacts_automation_probe failed')
    expect(result.kind).toBe('timeout')
  })
})

describe('calendar_automation_probe', () => {
  it('lists calendars and never creates an event', () => {
    const script = buildCalendarAutomationProbeScript()
    expect(script).toContain('tell application "Calendar"')
    expect(script).toContain('get name of every calendar')
    expect(script).not.toContain('make new event')
    expect(script).not.toContain('dry_run')

    const result = probeCalendarAutomation()
    expect(result.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(result.message).toContain('no events created')
  })

  it('maps a hang to Calendar Automation denied', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = probeCalendarAutomation()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('calendar_automation_probe failed')
    expect(result.kind).toBe('timeout')
  })
})

describe('messages_automation_probe', () => {
  it('enumerates accounts and never sends', () => {
    const script = buildMessagesAutomationProbeScript()
    expect(script).toContain('tell application "Messages"')
    expect(script).toContain('service type of acc')
    expect(script).not.toContain('send ')

    const result = probeMessagesAutomation()
    expect(result.ok).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(result.message).toContain('nothing was sent')
  })

  it('maps a hang to Messages Automation denied', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = probeMessagesAutomation()
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('timeout')
    expect(result.message).toContain('messages_automation_probe failed')
    expect(result.message).toContain('TCC / Automation deny')
    expect(result.message).not.toContain('could not be reached')
  })
})

describe('mail_draft', () => {
  it('saves instead of sending and skips the recipient gate', () => {
    const result = mailCompose(
      { to: ['a@example.com', 'b@example.com'], subject: 'Hi', body: 'Hello' },
      { draft: true }
    )
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('save newMessage')
    expect(script).not.toContain('send newMessage')
  })

  it('maps a hung draft compose to timeout guidance, not MAIL_TCC_GUIDANCE', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = mailCompose(
      { to: ['a@example.com'], subject: 'Hi', body: 'Hello' },
      { draft: true }
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(osascript).toHaveBeenCalledTimes(1)
  })
})

describe('mail_reply and mail_forward', () => {
  it('replies to a resolved message id', () => {
    const result = mailReply({ message_id: '<abc@example.com>', body: 'Thanks' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('atmFindMessage("abc@example.com")')
    expect(script).toContain('reply theMessage without opening window without reply to all')
    expect(script).toContain('send theReply')
  })

  it('treats reply-all as a multi-recipient send', () => {
    const result = mailReply({ message_id: 'abc@example.com', body: 'Thanks', reply_all: true })
    expect(result.planned).toBe(true)
    expect(result.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('requires a message id', () => {
    const result = mailReply({ body: 'Thanks' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('message_id is required')
  })

  it('returns success when a hung reply is already in Sent', () => {
    osascript
      .mockImplementationOnce(() => {
        throw new Error('spawnSync osascript ETIMEDOUT')
      })
      .mockImplementationOnce(() => 'FOUND')
    const result = mailReply({ message_id: '<abc@example.com>', body: 'Thanks' })
    expect(result.ok).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.message).toContain('mail_reply: reply sent')
    expect(result.message).toContain('verified in Sent')
    expect(result.message).not.toContain('TCC')
    expect(result.message).not.toContain('timed out')
    const verifyScript = osascript.mock.calls[1][0]
    expect(verifyScript).toContain('In-Reply-To:')
    expect(verifyScript).toContain('abc@example.com')
    expect(verifyScript).toContain('"Re: "')
    expect(verifyScript).toContain('atmFindMessage')
    expect(verifyScript).toContain('sent mailbox')
    expect(verifyScript).toContain('outgoing mailbox')
  })

  it('does not label a missed Sent-verify hang as TCC and tells clients to Sent-check', () => {
    osascript
      .mockImplementationOnce(() => {
        throw new Error('Mail got an error: AppleEvent timed out. (-1712)')
      })
      .mockImplementationOnce(() => 'NOT_FOUND')
    const result = mailReply({ message_id: 'abc@example.com', body: 'Thanks' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('mail_reply failed')
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).toContain('find/reply/send hang')
    expect(result.message).toContain('-1743')
    expect(result.message).toContain('-10004')
    expect(result.message).toContain('Check Sent')
    expect(result.message).toContain('before retrying')
    expect(result.message).toContain('not a TCC / Automation deny')
    expect(result.message).not.toContain('macOS denied Mail automation')
  })

  it('labels a hard Mail deny on reply as TCC and skips Sent-verify', () => {
    osascript.mockImplementation(() => {
      throw new Error('Not authorized to send Apple events to Mail. (-10004)')
    })
    const result = mailReply({ message_id: 'abc@example.com', body: 'Thanks' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).not.toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).toContain('TCC / Automation deny')
    expect(result.message).not.toContain('verified in Sent')
    expect(result.message).not.toContain('find/reply/send hang')
    expect(osascript).toHaveBeenCalledTimes(1)
  })

  it('maps a pre-send find/reply hang to timeout guidance, not MAIL_TCC_GUIDANCE', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = mailReply({ message_id: 'abc@example.com', body: 'Thanks', save_as_draft: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(result.message).toContain('find/reply/open before send')
    expect(osascript).toHaveBeenCalledTimes(1)
  })

  it('forwards to a validated recipient', () => {
    const result = mailForward({ message_id: 'abc@example.com', to: ['c@example.com'], body: 'FYI' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('forward theMessage without opening window')
    expect(script).toContain('address:"c@example.com"')
  })

  it('returns success when a hung forward is already in Sent', () => {
    osascript
      .mockImplementationOnce(() => {
        throw new Error('spawnSync osascript ETIMEDOUT')
      })
      .mockImplementationOnce(() => 'FOUND')
    const result = mailForward({ message_id: 'abc@example.com', to: ['c@example.com'], body: 'FYI' })
    expect(result.ok).toBe(true)
    expect(result.recovered).toBe(true)
    expect(result.message).toContain('mail_forward: forwarded')
    expect(result.message).toContain('verified in Sent')
    const verifyScript = osascript.mock.calls[1][0]
    expect(verifyScript).toContain('Fwd:')
    expect(verifyScript).toContain('Begin forwarded message')
    expect(verifyScript).toContain('c@example.com')
    expect(verifyScript).toContain('A reply to the original is not this forward')
  })

  it('maps a pre-send forward/open hang to timeout guidance, not MAIL_TCC_GUIDANCE', () => {
    osascript.mockImplementation(() => {
      throw new Error('Mail got an error: AppleEvent timed out. (-1712)')
    })
    const result = mailForward({
      message_id: 'abc@example.com',
      to: ['c@example.com'],
      body: 'FYI',
      save_as_draft: true
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
    expect(osascript).toHaveBeenCalledTimes(1)
  })
})

describe('mail Sent verify helpers', () => {
  it('builds an In-Reply-To Sent scan, a Re: fallback scan, and a subject Sent scan', () => {
    const byReply = buildFindSentByInReplyToScript('abc@example.com')
    expect(byReply).toContain('In-Reply-To:')
    expect(byReply).toContain('<abc@example.com>')
    expect(byReply).toContain('"Re: "')
    expect(byReply).toContain('subj is ("Re: " & origSubject)')
    expect(byReply).toContain('The original, not the reply we just sent')
    expect(byReply).toContain('atmFindMessage')
    expect(byReply).toContain('sent mailbox')
    expect(byReply).toContain('outgoing mailbox')
    expect(byReply).toContain('source of msg')
    expect(byReply).not.toContain('subj contains origSubject')
    expect(byReply).not.toContain('Begin forwarded message')

    const bySubject = buildFindSentBySubjectScript('Status update')
    expect(bySubject).toContain('subject is "Status update"')
    expect(bySubject).toContain('sent mailbox')
  })

  it('builds a forward Sent scan that skips reply headers', () => {
    const byForward = buildFindSentForwardScript('abc@example.com', ['c@example.com'])
    expect(byForward).toContain('Fwd:')
    expect(byForward).toContain('Begin forwarded message')
    expect(byForward).toContain('c@example.com')
    expect(byForward).toContain('A reply to the original is not this forward')
    expect(byForward).toContain('The original, not the forward we just sent')
    expect(byForward).toContain('if exactFwd then return')
    expect(byForward).toContain('if looksForward and mentionsOrigId then return')
    expect(byForward).toContain('atmFindMessage')
    expect(byForward).not.toContain('subj contains origSubject')
    expect(byForward).not.toContain('looksForward and (mentionsOrig or hitTo)')
  })

  it('treats FOUND as a recovery hit and verify failure as not recovered', () => {
    osascript.mockImplementationOnce(() => 'FOUND')
    expect(recoverIfInSent({ inReplyTo: 'abc@example.com' })).toEqual({ found: true })

    osascript.mockImplementationOnce(() => 'FOUND')
    expect(recoverIfInSent({ inReplyTo: 'abc@example.com', forwardTo: ['c@example.com'] })).toEqual({ found: true })
    expect(osascript.mock.calls[osascript.mock.calls.length - 1][0]).toContain('Begin forwarded message')

    osascript.mockImplementationOnce(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    expect(recoverIfInSent({ subject: 'Hi' })).toBeNull()
  })

  it('distinguishes hard TCC deny codes from send timeouts', () => {
    expect(isMailHardTcc({ kind: 'tcc', error: 'Not authorized (-1743)' })).toBe(true)
    expect(isMailHardTcc({ kind: 'timeout', error: 'spawnSync osascript ETIMEDOUT' })).toBe(false)
    expect(isMailSendTimeout({ kind: 'timeout', error: 'spawnSync osascript ETIMEDOUT' })).toBe(true)
    expect(isMailSendTimeout({ kind: 'tcc', error: 'Not authorized (-1743)' })).toBe(false)
    expect(isMailSendTimeout({ kind: 'timeout', error: 'Not authorized (-1743) and ETIMEDOUT' })).toBe(false)
  })
})

describe('mail_mark, mail_archive, mail_trash', () => {
  it('marks read and unread', () => {
    mailMark({ message_id: 'abc@example.com', status: 'unread' })
    expect(lastScript()).toContain('set read status of theMessage to false')

    mailMark({ message_id: 'abc@example.com' })
    expect(lastScript()).toContain('set read status of theMessage to true')
  })

  it('rejects an unknown status', () => {
    const result = mailMark({ message_id: 'abc@example.com', status: 'starred' })
    expect(result.ok).toBe(false)
    expect(osascript).not.toHaveBeenCalled()
  })

  it('maps a find/open hang to timeout guidance, not MAIL_TCC_GUIDANCE', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = mailMark({ message_id: 'abc@example.com' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(MAIL_SEND_TIMEOUT_GUIDANCE)
    expect(result.message).not.toContain(MAIL_TCC_GUIDANCE)
  })

  it('moves to Archive', () => {
    const result = mailArchive({ message_id: 'abc@example.com' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('mailbox "Archive" of acct')
    expect(script).toContain('set mailbox of theMessage to targetBox')
  })

  it('never trashes without confirm', () => {
    const blocked = mailTrash({ message_id: 'abc@example.com' })
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(blocked.message).toContain('abc@example.com')
    expect(osascript).not.toHaveBeenCalled()

    const confirmed = mailTrash({ message_id: 'abc@example.com', confirm: true })
    expect(confirmed.ok).toBe(true)
    expect(lastScript()).toContain('mailbox "Trash" of acct')
  })
})

describe('resolveMailMessageId', () => {
  it('rejects a path outside the Mail directory', () => {
    const resolved = resolveMailMessageId({ filePath: '/etc/passwd.emlx' })
    expect(resolved.messageId).toBeNull()
    expect(resolved.error).toContain('file_path rejected')
  })

  it('rejects a non-emlx file', () => {
    const resolved = resolveMailMessageId({ filePath: path.join(process.env.HOME, 'Library/Mail/x.txt') })
    expect(resolved.messageId).toBeNull()
    expect(resolved.error).toContain('file_path rejected')
  })
})

// ============ MESSAGES ============

describe('messages_send', () => {
  it('sends an iMessage to one handle', () => {
    const result = messagesSend({ to: ['+15551234567'], text: 'On my way' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('participant "+15551234567"')
    expect(script).toContain('send "On my way" to theTarget')
    expect(result.message).toContain('+15551234567')
  })

  it('reports a hung send timeout as TCC / Automation denied, not app unavailable', () => {
    osascript.mockImplementation(() => {
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = messagesSend({ to: ['+15551234567'], text: 'On my way' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('TCC / Automation deny')
    expect(result.message).toContain('node → Messages')
    expect(result.message).not.toContain('could not be reached')
  })

  it('refuses an invalid handle rather than guessing', () => {
    const result = messagesSend({ to: ['not a phone'], text: 'hi' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('invalid recipient')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('requires confirmation for multiple handles', () => {
    const result = messagesSend({ to: ['+15551234567', 'peter@example.com'], text: 'hi' })
    expect(result.planned).toBe(true)
    expect(result.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('verifies chat_id against the Messages database', () => {
    const queryFn = vi.fn(() => [])
    const result = messagesSend(
      { chat_id: 'iMessage;+;chat999', text: 'hi' },
      { queryFn, dbPath: path.join(root, 'package.json') }
    )
    expect(result.ok).toBe(false)
    expect(result.message).toContain('was not found in the Messages database')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('requires confirmation for a group chat', () => {
    const queryFn = vi.fn(() => [{ guid: 'iMessage;+;chat1', displayName: 'Family', participantCount: 4 }])
    const deps = { queryFn, dbPath: path.join(root, 'package.json') }

    const blocked = messagesSend({ chat_id: 'iMessage;+;chat1', text: 'hi' }, deps)
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('4 participants')
    expect(osascript).not.toHaveBeenCalled()

    const confirmed = messagesSend({ chat_id: 'iMessage;+;chat1', text: 'hi', confirm: true }, deps)
    expect(confirmed.ok).toBe(true)
    expect(lastScript()).toContain('chat id "iMessage;+;chat1"')
  })

  it('requires text or an attachment', () => {
    const result = messagesSend({ to: ['+15551234567'] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('provide text, attachment_path, or both')
  })

  it('rejects an attachment path that does not exist', () => {
    const result = messagesSend({ to: ['+15551234567'], attachment_path: '/tmp/definitely-not-here-93812.png' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('does not exist')
  })

  it('attaches an existing absolute file path', () => {
    const existing = path.join(root, 'package.json')
    const result = messagesSend({ to: ['+15551234567'], text: 'file', attachment_path: existing })
    expect(result.ok).toBe(true)
    expect(lastScript()).toContain(`send (POSIX file "${existing}") to theTarget`)
  })

  it('rejects a relative attachment path', () => {
    expect(validateAttachmentPath('relative/file.png').error).toContain('absolute path')
  })

  it('reports a database read failure instead of sending', () => {
    const queryFn = vi.fn(() => {
      throw new Error('database is locked')
    })
    const result = lookupChat('iMessage;+;chat1', { queryFn, dbPath: path.join(root, 'package.json') })
    expect(result.found).toBe(false)
    expect(result.error).toContain('database is locked')
  })
})

// ============ CALENDAR ============

describe('recurrence and alerts', () => {
  it('builds an RRULE from structured arguments', () => {
    expect(buildRecurrenceRule({ frequency: 'weekly', interval: 2, by_day: ['MO', 'WE'], count: 10 }).rule)
      .toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10')
  })

  it('supports until and rejects count+until together', () => {
    expect(buildRecurrenceRule({ frequency: 'daily', until: '2026-12-31 09:00' }).rule).toMatch(/FREQ=DAILY;UNTIL=\d{8}T\d{6}Z/)
    expect(buildRecurrenceRule({ frequency: 'daily', count: 3, until: '2026-12-31 09:00' }).error).toContain('not both')
  })

  it('accepts a raw RRULE but rejects junk', () => {
    expect(buildRecurrenceRule({ recurrence: 'FREQ=MONTHLY;COUNT=3' }).rule).toBe('FREQ=MONTHLY;COUNT=3')
    expect(buildRecurrenceRule({ recurrence: '"; delete every event' }).error).toContain('RRULE')
  })

  it('rejects unsupported frequencies and intervals', () => {
    expect(buildRecurrenceRule({ frequency: 'hourly' }).error).toContain('frequency must be one of')
    expect(buildRecurrenceRule({ frequency: 'daily', interval: 0 }).error).toContain('interval')
    expect(buildRecurrenceRule({ frequency: 'weekly', by_day: ['XX'] }).error).toContain('by_day')
  })

  it('validates alert minutes', () => {
    expect(validateAlerts([15, 60]).minutes).toEqual([15, 60])
    expect(validateAlerts(['abc']).error).toContain('alerts_minutes_before')
    expect(validateAlerts([1, 2, 3, 4, 5, 6]).error).toContain('at most 5')
  })
})

describe('calendar_add', () => {
  it('creates an event on the named calendar and returns its id', () => {
    osascript.mockReturnValue('EVT-UID-1\n')
    const result = calendarAdd({
      calendar_name: 'Work',
      title: 'Standup',
      start: '2026-09-21 09:00',
      end: '2026-09-21 09:15',
      location: 'Zoom',
      frequency: 'weekly',
      by_day: ['MO'],
      alerts_minutes_before: [10]
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('EVT-UID-1')
    const script = lastScript()
    expect(script).toContain('atmMakeDate(2026, 9, 21, 9, 0)')
    expect(script).toContain('summary:"Standup"')
    expect(script).toContain('if (name of cal) is "Work"')
    expect(script).toContain('set recurrence of newEvent to "FREQ=WEEKLY;BYDAY=MO"')
    expect(script).toContain('trigger interval:-10')
  })

  it('refuses natural language dates', () => {
    const result = calendarAdd({ calendar_name: 'Work', title: 'Standup', start: 'next tuesday at 9' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Natural language is not accepted for writes')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('refuses an impossible calendar date', () => {
    const result = calendarAdd({ calendar_name: 'Work', title: 'x', start: '2026-02-31 09:00' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not a valid calendar date')
  })

  it('refuses an end before the start', () => {
    const result = calendarAdd({
      calendar_name: 'Work',
      title: 'x',
      start: '2026-09-21 10:00',
      end: '2026-09-21 09:00'
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('end is before start')
  })

  it('defaults a timed event to one hour, rolling past midnight', () => {
    expect(defaultEndParts({ year: 2026, month: 9, day: 21, hour: 9, minute: 30 }, false))
      .toEqual({ year: 2026, month: 9, day: 21, hour: 10, minute: 30 })
    expect(defaultEndParts({ year: 2026, month: 12, day: 31, hour: 23, minute: 30 }, false))
      .toEqual({ year: 2027, month: 1, day: 1, hour: 0, minute: 30 })
  })

  it('defaults an all-day event to the end of that day', () => {
    osascript.mockReturnValue('EVT-ALLDAY<<>>EK-LOCAL-1')
    const result = calendarAdd({ calendar_name: 'Work', title: 'Offsite', start: '2026-09-21' })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('EVT-ALLDAY')
    expect(result.message).toContain('eventkit_id: EK-LOCAL-1')
    expect(result.message).toContain('EventKit')
    const script = lastScript()
    expect(script).toContain('saveEventSpanCommitError')
    expect(script).toContain('var allDay = true')
    expect(script).toContain('event.allDay = allDay')
  })

  it('creates a non-recurring event through EventKit so remove can use the same ids', () => {
    osascript.mockReturnValue('75984151-1160-40A9-895E-D63B6C8808A8<<>>EK-SMOKE-1')
    const result = calendarAdd({
      calendar_name: 'Work',
      title: 'ATM smoke',
      start: '2026-09-21 09:00',
      end: '2026-09-21 10:00'
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('75984151-1160-40A9-895E-D63B6C8808A8')
    expect(result.message).toContain('eventkit_id: EK-SMOKE-1')
    expect(lastScript()).toContain('saveEventSpanCommitError')
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
    const addScript = buildEventKitAddScript({
      calendarName: 'Work',
      title: 'ATM smoke',
      start: { year: 2026, month: 9, day: 21, hour: 9, minute: 0 },
      end: { year: 2026, month: 9, day: 21, hour: 10, minute: 0 },
      allDay: false,
      location: '',
      notes: '',
      alerts: [10]
    })
    expect(addScript).toContain('calendarItemExternalIdentifier')
    expect(addScript).toContain('eventIdentifier')
    expect(addScript).toContain('calendarItemIdentifier')
    expect(addScript).not.toContain('EVENTKIT_LOOKUP_FAILED')
    expect(addScript).toContain('defaultCalendarForNewEvents')
    expect(addScript).toContain('ObjC.unwrap')
    expect(addScript).toContain('calendarIdentifier')
    expect(addScript).toContain('writables.length === 1')
    expect(addScript).toContain('function jsString')
    expect(parseEventKitAddOutput('UID<<>>LOCAL<<>>Calendar')).toEqual({
      eventId: 'UID',
      eventKitId: 'LOCAL',
      calendar: 'Calendar'
    })
    expect(parseEventKitAddOutput('UID<<>>CAL:EVT<<>>Calendar<<>>ITEM')).toEqual({
      eventId: 'UID',
      eventKitId: 'CAL:EVT',
      calendar: 'Calendar'
    })
  })

  it('does not fall back to Calendar.app when EventKit create fails', () => {
    osascript.mockImplementation(() => {
      throw new Error('EVENTKIT_SAVE_FAILED: boom')
    })
    const result = calendarAdd({
      calendar_name: 'Work',
      title: 'x',
      start: '2026-09-21 09:00',
      end: '2026-09-21 10:00'
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('does not fall back to Calendar.app')
    expect(result.message).toContain('osascript kind=')
    expect(result.message).toContain('EVENTKIT_SAVE_FAILED')
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
    expect(osascript.mock.calls[0][0]).not.toContain('make new event')
  })

  it('requires a calendar name so events do not land on the default', () => {
    const result = calendarAdd({ title: 'x', start: '2026-09-21 09:00' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('calendar_name is required')
  })

  it('explains a missing calendar', () => {
    osascript.mockImplementation(() => {
      throw new Error('script error: CALENDAR_NOT_FOUND')
    })
    const result = calendarAdd({ calendar_name: 'Nope', title: 'x', start: '2026-09-21 09:00' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('calendar_list_calendars')
  })
})

describe('calendar_edit, calendar_remove, calendar_rsvp', () => {
  it('edits only the supplied fields', () => {
    osascript.mockReturnValue('EVT-UID-1')
    const result = calendarEdit({ event_id: 'EVT-UID-1', title: 'New title', start: '2026-09-22 10:00' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('set summary of theEvent to "New title"')
    expect(script).toContain('set start date of theEvent to atmMakeDate(2026, 9, 22, 10, 0)')
    expect(script).not.toContain('set location of theEvent')
  })

  it('refuses an edit with nothing to change', () => {
    const result = calendarEdit({ event_id: 'EVT-UID-1' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('nothing to change')
  })

  it('refuses an edit without an event id', () => {
    const result = calendarEdit({ title: 'New title' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('event_id is required')
  })

  it('creates, edits, and removes through the EventKit session without re-query', () => {
    const calls = []
    setEventKitSession({
      request(cmd) {
        calls.push(cmd)
        if (cmd.op === 'create') return { ok: true, output: '0801367E-5F98-477D-873D-C6ED8CD662D8<<>>9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:0801367E-5F98-477D-873D-C6ED8CD662D8<<>>Calendar<<>>368D05E6-2D88-4800-8AE7-C40248D231AC' }
        return { ok: true, output: '1' }
      },
      close() {}
    })
    const added = calendarAdd({
      calendar_name: 'Calendar',
      title: 'ATM smoke',
      start: '2026-09-21 09:00',
      end: '2026-09-21 10:00'
    })
    expect(added.ok).toBe(true)
    expect(added.message).toContain('via: EventKit')
    expect(added.message).toContain('eventkit_id: 9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:0801367E-5F98-477D-873D-C6ED8CD662D8')
    expect(osascript).not.toHaveBeenCalled()

    const edited = calendarEdit({
      event_id: '0801367E-5F98-477D-873D-C6ED8CD662D8',
      eventkit_id: '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:0801367E-5F98-477D-873D-C6ED8CD662D8',
      title: 'Edited'
    })
    expect(edited.ok).toBe(true)
    expect(edited.message).toContain('EventKit')
    expect(osascript).not.toHaveBeenCalled()

    const removed = calendarRemove({
      event_id: '0801367E-5F98-477D-873D-C6ED8CD662D8',
      eventkit_id: '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:0801367E-5F98-477D-873D-C6ED8CD662D8',
      confirm: true
    })
    expect(removed.ok).toBe(true)
    expect(removed.message).toContain('EventKit')
    expect(osascript).not.toHaveBeenCalled()
    expect(calls.map((c) => c.op)).toEqual(['create', 'update', 'remove'])
    expect(calls[1].ids).toContain('9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:0801367E-5F98-477D-873D-C6ED8CD662D8')
    expect(calls[2].ids).toContain('0801367E-5F98-477D-873D-C6ED8CD662D8')
  })

  it('edits via EventKit when eventkit_id is present', () => {
    osascript.mockReturnValue('1')
    const result = calendarEdit({
      event_id: '7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      eventkit_id: '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      title: 'Edited'
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('EventKit')
    expect(lastScript()).toContain('findEventByIds')
    expect(lastScript()).toContain('9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B')
    expect(lastScript()).toContain('7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B')
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
    expect(eventKitLookupIds(
      '7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B'
    )).toEqual([
      '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      '7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B'
    ])
  })

  it('does not hang in Calendar.app when eventkit_id edit fails', () => {
    osascript.mockImplementation(() => {
      throw new Error('EVENTKIT_NOT_FOUND status=4 writeOnly tried=9B7A:7F95')
    })
    const result = calendarEdit({
      event_id: '7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      eventkit_id: '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      title: 'Edited'
    })
    expect(result.ok).toBe(false)
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
    expect(result.message).toContain('skipped')
    expect(result.message).not.toContain('denied Calendar access')
    expect(result.message).not.toContain('atmFindEvent')
  })

  it('does not hang in Calendar.app when eventkit_id remove fails', () => {
    osascript.mockImplementation(() => {
      throw new Error('EVENTKIT_NOT_FOUND status=4 writeOnly tried=9B7A:7F95')
    })
    const result = calendarRemove({
      event_id: '7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      eventkit_id: '9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B',
      confirm: true
    })
    expect(result.ok).toBe(false)
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(result.message).toContain('skipped')
    expect(result.message).not.toContain('denied Calendar access')
  })

  it('never removes an event without confirm', () => {
    const blocked = calendarRemove({ event_id: 'EVT-UID-1' })
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()

    osascript.mockReturnValue('1')
    const confirmed = calendarRemove({ event_id: 'EVT-UID-1', eventkit_id: 'EK-1', confirm: true })
    expect(confirmed.ok).toBe(true)
    expect(confirmed.message).toContain('EventKit')
    const script = lastScript()
    expect(script).toContain('eventWithIdentifier')
    expect(script).toContain('calendarItemWithIdentifier')
    expect(script).toContain('calendarItemsWithExternalIdentifier')
    expect(script).toContain('removeEventSpanCommitError')
    expect(script).toContain('EK-1')
    expect(osascript).toHaveBeenCalledTimes(1)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
  })

  it('falls back to Calendar.app delete when EventKit cannot see the event', () => {
    osascript.mockImplementation((script) => {
      if (String(script).includes('calendarItemsWithExternalIdentifier')) {
        throw new Error('execution error: Error: Error: EVENTKIT_NOT_FOUND status=4 (-2700)')
      }
      return 'Standup'
    })
    const result = calendarRemove({ event_id: 'EVT-UID-1', calendar_name: 'Work', confirm: true })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('Standup')
    expect(osascript).toHaveBeenCalledTimes(2)
    const script = osascript.mock.calls[1][0]
    expect(script).toContain('if (name of cal) is "Work"')
    expect(script).toContain('delete (event id evId of cal)')
    expect(script).toContain('with timeout of 20 seconds')
    expect(script).not.toContain('delete (every event whose uid')
    expect(script).not.toContain('move to trash')
  })

  it('does not report a failed Calendar delete as Calendar.app unreachable', () => {
    osascript.mockImplementation(() => {
      throw new Error('Calendar got an error: Can\'t get event id "EVT-UID-1" of calendar "Work". (-1728)')
    })
    const result = calendarRemove({ event_id: 'EVT-UID-1', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No event with that id was found')
    expect(result.message).toContain('osascript kind=')
    expect(result.message).toContain('-1728')
    expect(result.message).not.toContain('could not be reached')
    expect(result.message).not.toContain('denied Calendar access')
    expect(result.suppressTccAdvice).toBe(true)
    expect(osascript).toHaveBeenCalledTimes(2)
    expect(osascript.mock.calls[0][1]).toMatchObject({ language: 'JavaScript' })
  })

  it('removes via EventKit first so an iCloud Calendar.app hang is skipped', () => {
    osascript.mockImplementation((script) => {
      if (String(script).includes('calendarItemsWithExternalIdentifier')) return '1'
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = calendarRemove({ event_id: 'EVT-UID-1', confirm: true })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('EventKit')
    expect(result.message).toContain('EVT-UID-1')
    expect(osascript).toHaveBeenCalledTimes(1)
  })

  it('surfaces raw osascript codes on calendar_remove timeout instead of TCC deny', () => {
    osascript.mockImplementation((script) => {
      if (String(script).includes('calendarItemsWithExternalIdentifier')) {
        throw new Error('execution error: Error: Error: EVENTKIT_NOT_FOUND status=4 (-2700)')
      }
      throw new Error('spawnSync osascript ETIMEDOUT')
    })
    const result = calendarRemove({ event_id: 'EVT-UID-1', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('osascript kind=timeout')
    expect(result.message).toContain('ETIMEDOUT')
    expect(result.message).toContain('EVENTKIT_NOT_FOUND')
    expect(result.message).toContain('-2700')
    expect(result.message).toContain('not a TCC / Automation deny')
    expect(result.message).not.toContain('denied Calendar access')
    expect(result.suppressTccAdvice).toBe(true)
    expect(result.diagnostics).toContain('AppleScript')
    expect(result.diagnostics).toContain('EventKit')
  })

  it('keeps a hard Automation deny as TCC and still prints the AppleEvent code', () => {
    osascript.mockImplementation(() => {
      throw new Error('Not authorized to send Apple events to Calendar. (-1743)')
    })
    const result = calendarRemove({ event_id: 'EVT-UID-1', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('denied Calendar access')
    expect(result.message).toContain('osascript kind=')
    expect(result.message).toContain('-1743')
    expect(result.suppressTccAdvice).toBe(false)
  })

  it('looks up EventKit by eventIdentifier and externalIdentifier', () => {
    const script = buildEventKitRemoveScript('DC4AC0EF-5BF1-448C-8492-E48A95FCB492', { eventKitId: 'EK-LOCAL' })
    expect(script).toContain('calendarItemsWithExternalIdentifier')
    expect(script).toContain('eventWithIdentifier')
    expect(script).toContain('calendarItemWithIdentifier')
    expect(script).toContain('findEventByIds')
    expect(script).toContain('removeEventSpanCommitError')
    expect(script).toContain('DC4AC0EF-5BF1-448C-8492-E48A95FCB492')
    expect(script).toContain('EK-LOCAL')
    expect(script).toContain('writeOnly')
    expect(buildRemoveEventScript('EVT-1')).toContain('DELETE_TIMEOUT')
    const described = describeCalendarRemoveFailure(
      'calendar_remove',
      'delete calendar event EVT-1',
      { ok: false, error: 'spawnSync osascript ETIMEDOUT', kind: 'timeout' },
      { ok: false, error: 'EVENTKIT_NOT_FOUND status=4 writeOnly (-2700)', kind: 'not_found' }
    )
    expect(described.message).toContain('osascript kind=timeout error=spawnSync osascript ETIMEDOUT')
    expect(described.message).toContain('EVENTKIT_NOT_FOUND')
    expect(described.message).not.toContain('denied Calendar access')
    expect(described.suppressTccAdvice).toBe(true)
    expect(parseEventKitCalendarList('Home<<>>yes<<>>yes<<>>0<<>>On My Mac')).toEqual([
      { name: 'Home', writable: true, local: true, sourceType: 0, source: 'On My Mac' }
    ])
    expect(mergeCalendarSources(
      [{ name: 'Home', writable: true }],
      [{ name: 'Home', writable: true, local: true, sourceType: 0, source: 'On My Mac' }]
    )[0].local).toBe(true)
  })

  it('RSVPs with a validated response', () => {
    osascript.mockReturnValue('Team Sync')
    const result = calendarRsvp({ event_id: 'EVT-UID-1', response: 'tentative' })
    expect(result.ok).toBe(true)
    expect(lastScript()).toContain('set participation status of theAttendee to tentative')

    const bad = calendarRsvp({ event_id: 'EVT-UID-1', response: 'maybe' })
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain('response must be one of')
  })

  it('reports when Calendar refuses to write the participation status', () => {
    osascript.mockImplementation(() => {
      throw new Error('script error: RSVP_NOT_SUPPORTED: cannot set')
    })
    const result = calendarRsvp({ event_id: 'EVT-UID-1', response: 'accept' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('answer the invitation in Calendar directly')
  })

  it('lists calendars with writability', () => {
    osascript.mockReturnValue('Work<<>>yes|||Holidays<<>>no')
    const result = calendarListCalendars()
    expect(result.ok).toBe(true)
    expect(result.calendars).toEqual([
      { name: 'Work', writable: true },
      { name: 'Holidays', writable: false }
    ])
    expect(result.message).toContain('Holidays (read-only)')
  })
})

// ============ CONTACTS ============

describe('contacts writes', () => {
  it('creates a contact and returns its id', () => {
    osascript.mockReturnValue('ABCD-1234:ABPerson')
    const result = contactsAdd({
      first_name: 'Ada',
      last_name: 'Lovelace',
      emails: ['ada@example.com'],
      phones: ['+15551234567']
    })
    expect(result.ok).toBe(true)
    expect(result.message).toContain('ABCD-1234:ABPerson')
    const script = lastScript()
    expect(script).toContain('first name:"Ada"')
    expect(script).toContain('value:"ada@example.com"')
    expect(script).toContain('value:"+15551234567"')
    expect(script).toContain('save')
  })

  it('refuses a contact with no name at all', () => {
    const result = contactsAdd({ emails: ['ada@example.com'] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('at least first_name, last_name, or organization')
  })

  it('rejects an invalid email before touching Contacts', () => {
    const result = contactsAdd({ first_name: 'Ada', emails: ['nope'] })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('invalid email address')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('edits a contact by id', () => {
    osascript.mockReturnValue('Ada Lovelace')
    const result = contactsEdit({ contact_id: 'ABCD-1234:ABPerson', organization: 'Analytical Engines' })
    expect(result.ok).toBe(true)
    expect(lastScript()).toContain('set organization of thePerson to "Analytical Engines"')
  })

  it('treats clearing every email as destructive', () => {
    const blocked = contactsEdit({ contact_id: 'ABCD-1234:ABPerson', replace_emails: true })
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()
  })

  it('never removes a contact without confirm', () => {
    const blocked = contactsRemove({ contact_id: 'ABCD-1234:ABPerson' })
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()

    osascript.mockReturnValue('Ada Lovelace')
    const confirmed = contactsRemove({ contact_id: 'ABCD-1234:ABPerson', confirm: true })
    expect(confirmed.ok).toBe(true)
    expect(lastScript()).toContain('delete thePerson')
  })

  it('requires a contact id for deletes', () => {
    const result = contactsRemove({})
    expect(result.ok).toBe(false)
    expect(result.message).toContain('contact_id is required')
  })
})

// ============ TOOL SURFACE ============

describe('write tool definitions', () => {
  it('registers every handler with a schema, and no Reminders tools', () => {
    const definedNames = WRITE_TOOL_DEFINITIONS.map((t) => t.name)
    expect(definedNames.sort()).toEqual([...WRITE_TOOL_NAMES].sort())
    expect(definedNames.some((n) => n.includes('reminder'))).toBe(false)
    expect(definedNames).not.toContain('mail_automation_probe')
    expect(definedNames).not.toContain('messages_automation_probe')
    expect(SMOKE_ONLY_AUTOMATION_PROBES).toContain('mail_automation_probe')
    expect(SMOKE_ONLY_AUTOMATION_PROBES).toContain('messages_automation_probe')
    expect(isWriteTool('mail_automation_probe')).toBe(false)
    expect(isWriteTool('messages_automation_probe')).toBe(false)
    expect(Object.keys(WRITE_TOOL_HANDLERS)).not.toContain('mail_automation_probe')
    expect(Object.keys(WRITE_TOOL_HANDLERS)).not.toContain('messages_automation_probe')
  })

  it('uses snake_case names and object schemas', () => {
    for (const tool of WRITE_TOOL_DEFINITIONS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema.type).toBe('object')
      for (const param of Object.keys(tool.inputSchema.properties)) {
        expect(param).toMatch(/^[a-z][a-z0-9_]*$/)
      }
    }
  })

  it('offers dry_run and confirm on every mutating tool', () => {
    for (const tool of WRITE_TOOL_DEFINITIONS) {
      if (tool.name === 'calendar_list_calendars') continue
      expect(Object.keys(tool.inputSchema.properties)).toContain('dry_run')
      expect(Object.keys(tool.inputSchema.properties)).toContain('confirm')
    }
  })

  it('recognizes write tools and rejects unknown ones', () => {
    expect(isWriteTool('mail_send')).toBe(true)
    expect(isWriteTool('mail_search')).toBe(false)
    expect(executeWriteToolLocally('reminders_add', {}).ok).toBe(false)
  })

  it('keeps Automation probes off the MCP CallTool write surface', async () => {
    expect(isWriteTool('mail_automation_probe')).toBe(false)
    expect(isWriteTool('messages_automation_probe')).toBe(false)
    expect(executeWriteToolLocally('mail_automation_probe', {}).message).toContain('Unknown write tool')
    expect(executeWriteToolLocally('messages_automation_probe', {}).unsupported).toBe(true)
    const mail = await dispatchWriteTool('mail_automation_probe', {})
    const messages = await dispatchWriteTool('messages_automation_probe', {})
    expect(mail.ok).toBe(false)
    expect(mail.message).toContain('Unknown write tool')
    expect(messages.ok).toBe(false)
    expect(messages.message).toContain('Unknown write tool')
  })

  it('never ships a Reminders tool', () => {
    const source = fs.readFileSync(path.join(root, 'lib/writeTools.js'), 'utf8')
    expect(source.toLowerCase()).not.toContain('reminders_')
  })

  it('routes writes before the index gate so they work while the daemon holds the lock', () => {
    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const dispatchAt = indexSrc.indexOf('isWriteTool(name)')
    const switchAt = indexSrc.indexOf('switch (name)')

    expect(dispatchAt).toBeGreaterThan(-1)
    expect(dispatchAt).toBeLessThan(switchAt)
    // The write path must not call requireIndex(): writes talk to the apps,
    // not the vector index, and 1.2.1 read/search gating stays untouched.
    const writeBlock = indexSrc.slice(dispatchAt, switchAt)
    expect(writeBlock).not.toContain('requireIndex')
    expect(indexSrc).toContain('requireIndex("emails")')
  })

  it('only the indexer daemon serves the write bridge', () => {
    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const daemonBranch = indexSrc.slice(indexSrc.indexOf('if (INDEXER_MODE) {'))

    expect(daemonBranch).toContain('await startWriteBridge()')
    expect(indexSrc).toContain('stopWriteBridge()')
  })

  it('starts the bridge before any index work, and survives a bad index', () => {
    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const bridgeAt = indexSrc.indexOf('await startWriteBridge()')
    const readinessAt = indexSrc.indexOf('await checkIfFirstRun()')

    // A missing or locked vector index must not stop the daemon from
    // serving writes, so the bridge comes up first.
    expect(bridgeAt).toBeGreaterThan(-1)
    expect(bridgeAt).toBeLessThan(readinessAt)
    expect(indexSrc).toContain('Could not determine index state')
    expect(indexSrc).toContain('Indexing startup failed')
  })
})

describe('write smoke script routing (ship gate)', () => {
  it('uses the write bridge whenever the daemon is listening', async () => {
    const { resolveSmokePath } = await import('../../scripts/smoke-writes.js')
    const route = resolveSmokePath({ apply: true, bridgeUp: true, allowLocal: false, indexerMode: false })

    expect(route.proceed).toBe(true)
    expect(route.path).toBe('daemon')
    expect(route.reason).toContain('indexer daemon')
  })

  it('fails fast on --apply when no bridge is listening', async () => {
    const { resolveSmokePath } = await import('../../scripts/smoke-writes.js')
    const route = resolveSmokePath({ apply: true, bridgeUp: false, allowLocal: false, indexerMode: false })

    expect(route.proceed).toBe(false)
    expect(route.reason).toContain('LaunchAgent')
    expect(route.reason).toContain('--allow-local')
    // It must not quietly run in-process under a foreign parent and then
    // report that as a package failure.
    expect(route.reason).toContain('refused')
  })

  it('allows an explicit local run and the daemon itself', async () => {
    const { resolveSmokePath } = await import('../../scripts/smoke-writes.js')
    expect(resolveSmokePath({ apply: true, bridgeUp: false, allowLocal: true, indexerMode: false }))
      .toMatchObject({ proceed: true, path: 'local' })
    expect(resolveSmokePath({ apply: true, bridgeUp: false, allowLocal: false, indexerMode: true }))
      .toMatchObject({ proceed: true, path: 'local' })
  })

  it('never blocks a dry run', async () => {
    const { resolveSmokePath } = await import('../../scripts/smoke-writes.js')
    expect(resolveSmokePath({ apply: false, bridgeUp: false, allowLocal: false, indexerMode: false }).proceed).toBe(true)
  })

  it('treats the live calendar listing as advisory during a dry run', async () => {
    const { calendarListSeverity } = await import('../../scripts/smoke-writes.js')
    // calendar_list_calendars is a real Calendar.app query even on a dry
    // run, so a denial must not fail a run that changed nothing.
    expect(calendarListSeverity(false)).toBe('warning')
    expect(calendarListSeverity(true)).toBe('error')
  })

  it('does not claim a dry run changes nothing at all', async () => {
    const source = fs.readFileSync(path.join(root, 'scripts/smoke-writes.js'), 'utf8')
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

    expect(source).toContain('no creates, edits, or deletes')
    expect(source).toContain('live Calendar.app query')
    expect(source).toContain('make new outgoing message')
    expect(readme).toContain('live Calendar.app query')
    expect(readme).toContain('make new outgoing message')
  })

  it('documents Mini Automation grants in the README, not a Contacts/Calendars + button', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
    const smoke = fs.readFileSync(path.join(root, 'scripts/smoke-writes.js'), 'utf8')

    // Peter-locked ship-gate setup: Automation pane + LaunchAgent-owned node.
    expect(readme).toContain('System Settings → Privacy & Security → Automation')
    expect(readme).toContain('npm run smoke:writes -- --apply')
    expect(readme).not.toMatch(/smoke:writes --apply/)
    expect(readme).toContain('/Users/petercoates/.local/node/bin/node')
    expect(readme).toContain('Mini *example* only')
    expect(readme).toContain('LaunchAgent plist / `which node`')
    expect(readme).toContain('Do **not** approve the MCP client / host app that launched a short-lived stdio server')
    expect(readme).toContain('embedded agent shell, IDE terminal, or MCP host app subprocess')
    expect(readme).toContain('Full Disk Access')
    expect(readme).toContain('npm Trusted Publisher')
    expect(readme).toContain('Do not add `node` via the + button')
    expect(readme).toContain('those panes often have **no Add button**')
    expect(readme).toContain('re-arms the Automation prompt so you can Allow **`node`** again')
    expect(readme).not.toMatch(/Grok|anysphere|\bsand\b/i)

    // Mail + Messages are the same first-run Automation pass as Contacts/Calendar.
    expect(readme).toContain('One-pass first-run')
    expect(readme).toContain('control **Mail**, **Messages**, **Contacts**, and **Calendar**')
    expect(readme).toContain('node → Mail')
    expect(readme).toContain('node → Messages')
    expect(readme).toContain('dry_run never talks to Mail')
    expect(readme).toContain('Automation denied')
    expect(readme).toContain('Watch the host — Allow **`node`**')
    expect(readme).toContain('not “Mail.app could not be reached”')
    expect(readme).toContain('fails closed if Mail, Messages, Contacts, or Calendar')
    expect(readme).toContain('apple-tools-mcp permissions')
    expect(readme).toContain('npx apple-tools-mcp permissions')
    expect(readme).toContain('npm run permissions')
    expect(readme).toContain('$(which node) $(which apple-tools-mcp) permissions')
    expect(readme).toContain('process.execPath')
    expect(readme).toContain('MacBook (default for `permissions`)')
    expect(readme).toContain('Do **not** start `apple-tools-indexer`')
    expect(readme).toContain('Terminal.app')
    expect(readme).toContain('/Users/petercoates/.nvm/versions/node/v22.21.1/bin/node')
    expect(readme).toContain('not Homebrew')
    expect(readme).toContain('after first global install')
    expect(readme).toContain('after upgrade')
    expect(readme).toContain('postinstall')
    expect(readme).toContain('prints a reminder')
    expect(readme).toContain('osascript kind=')
    expect(readme).toContain('Calendar.app’s dictionary has **`delete` only**')

    // Fail-path copy must not send QA back to the privacy-list + button.
    expect(smoke).toContain('Privacy & Security > Automation')
    expect(smoke).toContain('Do not add node via +')
    expect(smoke).toContain('Mail.app')
    expect(smoke).toContain('Messages.app')
    expect(smoke).toContain('TCC / Automation denied')
    expect(smoke).toContain('make new outgoing message')
    expect(smoke).toContain('mail_send')
    expect(smoke).toContain('never touches Mail')
    expect(smoke).toContain('probeMessagesAutomation')
    expect(smoke).toContain('probeMailAutomation')
    expect(smoke).toContain('never touches Messages')
    expect(smoke).toContain('delete-path failure')
    expect(smoke).toContain('osascript kind=')
    expect(smoke).toContain('EventKit fallback')
    expect(smoke).toContain('createdViaEventKit')
    expect(smoke).toContain('via: EventKit')
    expect(smoke).toContain('eventkit_id: eventKitId')
    expect(smoke).toMatch(/run\("calendar_edit"[\s\S]*eventkit_id:/)
    expect(smoke).toMatch(/run\("calendar_remove"[\s\S]*eventkit_id:/)
    expect(readme).toContain('optional `eventkit_id` from add')
    expect(readme).toContain('cannot re-query')
    expect(readme).toContain('long-lived EventKit osascript session')
    expect(smoke).not.toMatch(/run\("mail_automation_probe"/)
    expect(smoke).not.toMatch(/run\("messages_automation_probe"/)
  })

  it('plans a live Mail compose so a TCC deny fails setup, not production', async () => {
    const {
      mailProbeSeverity,
      messagesProbeSeverity,
      planMailSmokeTouch,
      planMessagesSmokeTouch,
      mailDraftSmokeArgs
    } = await import('../../scripts/smoke-writes.js')

    expect(mailProbeSeverity(false)).toBe('warning')
    expect(mailProbeSeverity(true)).toBe('error')

    expect(planMailSmokeTouch({ apply: false, daemonPath: false })).toMatchObject({
      useLocalHelper: true,
      useMailDraft: false
    })
    expect(planMailSmokeTouch({ apply: true, daemonPath: true })).toMatchObject({
      useLocalHelper: true,
      useMailDraft: true
    })
    expect(planMailSmokeTouch({ apply: false, daemonPath: false }).reason).toContain('dry_run never touches Mail')

    expect(messagesProbeSeverity(true)).toBe('error')
    expect(planMessagesSmokeTouch().useLocalHelper).toBe(true)
    expect(planMessagesSmokeTouch().reason).toContain('never touches Messages')

    const draft = mailDraftSmokeArgs('20260920143000')
    expect(draft.subject).toContain('ATM Mail Automation probe')
    expect(draft.to[0]).toContain('atm-mail-probe-')
  })

  it('dispatches through the production write path, not the write modules directly', () => {
    const source = fs.readFileSync(path.join(root, 'scripts/smoke-writes.js'), 'utf8')

    expect(source).toContain('dispatchWriteTool')
    // Importing the write modules directly is what made the smoke test
    // bypass the bridge and fail the Mini ship gate.
    expect(source).not.toMatch(/from "\.\.\/lib\/contactsWrite\.js"/)
    expect(source).not.toMatch(/from "\.\.\/lib\/calendarWrite\.js"/)
  })
})

describe('write smoke script (QA prove-out helpers)', () => {
  it('defaults to a dry run and opts in with --apply', async () => {
    const { parseSmokeArgs } = await import('../../scripts/smoke-writes.js')
    expect(parseSmokeArgs([])).toEqual({ apply: false, keep: false, allowLocal: false, calendar: null })
    expect(parseSmokeArgs(['--apply'])).toEqual({ apply: true, keep: false, allowLocal: false, calendar: null })
    expect(parseSmokeArgs(['--apply', '--keep'])).toEqual({ apply: true, keep: true, allowLocal: false, calendar: null })
    expect(parseSmokeArgs(['--apply', '--calendar=Work']).calendar).toBe('Work')
    expect(parseSmokeArgs(['--apply', '--allow-local']).allowLocal).toBe(true)
  })

  it('reads the new ids back out of success messages', async () => {
    const { extractContactId, extractEventId } = await import('../../scripts/smoke-writes.js')
    expect(extractContactId('contacts_add: contact created. contact_id: ABCD-1234:ABPerson name: Ada'))
      .toBe('ABCD-1234:ABPerson')
    expect(extractContactId('contacts_add failed — ...')).toBeNull()
    expect(extractEventId('calendar_add: event created. event_id: EVT-UID-1 calendar: Work'))
      .toBe('EVT-UID-1')
    expect(extractEventId('calendar_add failed — ...')).toBeNull()
    const { extractEventKitId, pickSmokeCalendar } = await import('../../scripts/smoke-writes.js')
    expect(extractEventKitId('calendar_add: event created. event_id: EVT-1 eventkit_id: EK-1 via: EventKit'))
      .toBe('EK-1')
    expect(extractEventKitId('eventkit_id: 9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B calendar: Calendar'))
      .toBe('9B7ABDFC-DCB9-44D1-8429-6404A0E2DA3B:7F95121D-631F-4D8C-8E74-7BC9FD7B2E2B')
    const { createdViaEventKit } = await import('../../scripts/smoke-writes.js')
    expect(createdViaEventKit('calendar_add: event created. event_id: EVT-1 eventkit_id: EK-1 via: EventKit')).toBe(true)
    expect(createdViaEventKit('calendar_add: event created. event_id: EVT-1 calendar: Calendar')).toBe(false)
    expect(pickSmokeCalendar([
      { name: 'iCloud', writable: true, local: false },
      { name: 'Home', writable: true, local: true }
    ], null)).toEqual({ name: 'Home', reason: 'On My Mac (EventKit sourceType local)' })
    expect(pickSmokeCalendar([{ name: 'Work', writable: true }], 'Work').name).toBe('Work')
  })

  it('schedules the smoke event far enough out to miss real appointments', async () => {
    const { smokeEventWindow } = await import('../../scripts/smoke-writes.js')
    const now = new Date(2026, 8, 20, 12, 0, 0)
    const window = smokeEventWindow(now)

    expect(window.start).toMatch(/^\d{4}-\d{2}-\d{2} 03:00$/)
    expect(window.end).toMatch(/^\d{4}-\d{2}-\d{2} 04:00$/)
    expect(new Date(window.start).getTime() - now.getTime()).toBeGreaterThan(300 * 24 * 60 * 60 * 1000)
  })
})

describe('contacts write denial names the host entitlement limit', () => {
  it('reports the AddressBook gate rather than a bare AppleScript error', () => {
    osascript.mockImplementation(() => {
      throw new Error('execution error: Not authorized to send Apple events to Contacts. (-1743)')
    })
    const result = contactsAdd({ first_name: 'Ada', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('com.apple.security.personal-information.addressbook')
    expect(result.message).not.toContain('apple-tools-indexer')
    expect(result.message).toContain('reads')
  })

  it('keeps the calendar denial specific to the calendars entitlement', () => {
    osascript.mockImplementation(() => {
      throw new Error('execution error: Calendar got an error: Operation not permitted')
    })
    const result = calendarRemove({ event_id: 'EVT-1', confirm: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('com.apple.security.personal-information.calendars')
    expect(result.message).not.toContain('apple-tools-indexer')
    expect(result.message).not.toContain('addressbook')
  })
})

describe('dispatchWriteTool routing', () => {
  it('runs locally in the indexer daemon without probing the bridge', async () => {
    const probe = vi.fn()
    const runLocally = vi.fn(() => ({ ok: true, message: 'done' }))
    const result = await dispatchWriteTool('contacts_add', { first_name: 'Ada' }, {
      indexerMode: true,
      probe,
      runLocally
    })
    expect(probe).not.toHaveBeenCalled()
    expect(runLocally).toHaveBeenCalled()
    expect(result.message).toBe('done')
  })

  it('delegates a privacy-gated write to the daemon when the bridge answers', async () => {
    const request = vi.fn(async () => ({ delivered: true, response: { ok: true, message: 'daemon did it' } }))
    const runLocally = vi.fn()
    const result = await dispatchWriteTool('contacts_remove', { contact_id: 'x', confirm: true }, {
      indexerMode: false,
      probe: async () => true,
      request,
      runLocally
    })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tool: 'contacts_remove' }))
    expect(runLocally).not.toHaveBeenCalled()
    expect(result.message).toBe('daemon did it')
  })

  it('falls back to local execution when the bridge does not answer', async () => {
    const runLocally = vi.fn(() => ({ ok: true, message: 'local' }))
    const result = await dispatchWriteTool('calendar_add', {}, {
      indexerMode: false,
      probe: async () => true,
      request: async () => ({ delivered: false, response: null, error: 'ECONNREFUSED' }),
      runLocally
    })
    expect(runLocally).toHaveBeenCalled()
    expect(result.message).toBe('local')
  })

  it('explains the TCC host constraint when a local write is denied', async () => {
    const result = await dispatchWriteTool('contacts_add', {}, {
      indexerMode: false,
      probe: async () => false,
      runLocally: () => ({
        ok: false,
        message: 'contacts_add failed — Not authorized to send Apple events to Contacts. (-1743)'
      })
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Terminal.app')
    expect(result.message).toContain('process.execPath')
    expect(result.message).toContain('Do not start apple-tools-indexer')
    expect(result.message).not.toMatch(/LaunchAgent/)
  })

  it('does not append TCC fallback advice when calendar_remove suppresses it', async () => {
    const result = await dispatchWriteTool('calendar_remove', { event_id: 'x', confirm: true }, {
      indexerMode: false,
      probe: async () => false,
      runLocally: () => ({
        ok: false,
        suppressTccAdvice: true,
        message: 'calendar_remove failed — Calendar.app delete timed out. osascript kind=timeout error=spawnSync osascript ETIMEDOUT codes=ETIMEDOUT'
      })
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('osascript kind=timeout')
    expect(result.message).not.toContain('No indexer daemon is running')
    expect(result.message).not.toContain('apple-tools-indexer')
  })
})
