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
  resolveMailMessageId
} from '../../lib/mailWrite.js'
import { messagesSend, validateAttachmentPath, lookupChat } from '../../lib/messagesWrite.js'
import {
  calendarAdd,
  calendarEdit,
  calendarRemove,
  calendarRsvp,
  calendarListCalendars,
  buildRecurrenceRule,
  validateAlerts
} from '../../lib/calendarWrite.js'
import { contactsAdd, contactsEdit, contactsRemove } from '../../lib/contactsWrite.js'
import {
  WRITE_TOOL_DEFINITIONS,
  WRITE_TOOL_NAMES,
  isWriteTool,
  executeWriteToolLocally,
  dispatchWriteTool
} from '../../lib/writeTools.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

beforeEach(() => {
  osascript.mockReset()
  osascript.mockReturnValue('')
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

  it('does not echo the body when Mail fails', () => {
    osascript.mockImplementation(() => {
      throw new Error('Mail got an error: secret body text here')
    })
    const result = mailCompose({ to: ['a@example.com'], subject: 'Hi', body: 'secret body text here' })
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('secret body text here')
    expect(result.message).toContain('mail_send failed')
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

  it('forwards to a validated recipient', () => {
    const result = mailForward({ message_id: 'abc@example.com', to: ['c@example.com'], body: 'FYI' })
    expect(result.ok).toBe(true)
    const script = lastScript()
    expect(script).toContain('forward theMessage without opening window')
    expect(script).toContain('address:"c@example.com"')
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

  it('never removes an event without confirm', () => {
    const blocked = calendarRemove({ event_id: 'EVT-UID-1' })
    expect(blocked.planned).toBe(true)
    expect(blocked.message).toContain('CONFIRMATION REQUIRED')
    expect(osascript).not.toHaveBeenCalled()

    osascript.mockReturnValue('Standup')
    const confirmed = calendarRemove({ event_id: 'EVT-UID-1', confirm: true })
    expect(confirmed.ok).toBe(true)
    expect(confirmed.message).toContain('Standup')
    expect(lastScript()).toContain('delete theEvent')
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

  it('never ships a Reminders tool', () => {
    const source = fs.readFileSync(path.join(root, 'lib/writeTools.js'), 'utf8')
    expect(source.toLowerCase()).not.toContain('reminders_')
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
    expect(result.message).toContain('No indexer daemon is running')
    expect(result.message).toContain('apple-tools-indexer')
  })
})
