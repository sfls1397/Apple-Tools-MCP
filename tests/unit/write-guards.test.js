/**
 * Unit tests for lib/writeGuards.js
 *
 * BA AC: deletes and multi-recipient sends are dry-run / confirm safe, no
 * silent mass delete, responses name what would happen without dumping
 * message bodies into error paths.
 */

import { describe, it, expect } from 'vitest'
import {
  planWrite,
  plannedWriteResult,
  normalizeList,
  isEmailAddress,
  isPhoneNumber,
  isMessagesHandle,
  validateEmailList,
  validateMessageId,
  validateEventId,
  validateContactId,
  validateChatGuid,
  validateCalendarName,
  validateLabel,
  validateBody,
  validateSubject,
  scrubValues,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  MAX_RECIPIENTS,
  MAX_BODY_LENGTH
} from '../../lib/writeGuards.js'

describe('planWrite: dry_run', () => {
  it('never executes when dry_run is set, even with confirm', () => {
    const plan = planWrite({
      action: 'mail_trash',
      summary: 'move message abc to Trash',
      destructive: true,
      dryRun: true,
      confirm: true
    })
    expect(plan.decision).toBe('dry_run')
    expect(plan.proceed).toBe(false)
    expect(plan.message).toContain('DRY RUN')
    expect(plan.message).toContain('move message abc to Trash')
    expect(plan.message).toContain('Nothing was changed')
  })

  it('tells the caller confirm is also needed for destructive dry runs', () => {
    const plan = planWrite({ action: 'contacts_remove', summary: 'delete contact X', destructive: true, dryRun: true })
    expect(plan.message).toContain('confirm=true')
    expect(plan.requiresConfirm).toBe(true)
  })

  it('does not demand confirm in the dry-run hint for safe actions', () => {
    const plan = planWrite({ action: 'mail_mark', summary: 'mark message as read', dryRun: true })
    expect(plan.requiresConfirm).toBe(false)
    expect(plan.message).not.toContain('confirm=true')
  })
})

describe('planWrite: destructive actions', () => {
  it('blocks a delete without confirm', () => {
    const plan = planWrite({ action: 'calendar_remove', summary: 'delete calendar event evt-1', destructive: true })
    expect(plan.decision).toBe('needs_confirm')
    expect(plan.proceed).toBe(false)
    expect(plan.message).toContain('CONFIRMATION REQUIRED')
    expect(plan.message).toContain('evt-1')
    expect(plan.message).toContain('destructive')
  })

  it('runs a delete once confirmed', () => {
    const plan = planWrite({ action: 'calendar_remove', summary: 'delete calendar event evt-1', destructive: true, confirm: true })
    expect(plan.decision).toBe('execute')
    expect(plan.proceed).toBe(true)
  })
})

describe('planWrite: multi-recipient sends', () => {
  it('allows a single-recipient send without confirm', () => {
    const plan = planWrite({ action: 'mail_send', summary: 'send mail to a@b.com', recipientCount: 1 })
    expect(plan.proceed).toBe(true)
  })

  it('blocks a two-recipient send without confirm', () => {
    const plan = planWrite({ action: 'mail_send', summary: 'send mail to a@b.com, c@d.com', recipientCount: 2 })
    expect(plan.decision).toBe('needs_confirm')
    expect(plan.message).toContain('2 recipients')
    expect(plan.message).toContain('nothing was changed')
  })

  it('allows a multi-recipient send with confirm', () => {
    const plan = planWrite({ action: 'mail_send', summary: 'send mail', recipientCount: 9, confirm: true })
    expect(plan.proceed).toBe(true)
  })
})

describe('plannedWriteResult: not a delivery', () => {
  it('returns ok false so MCP isError cannot be read as sent', () => {
    const plan = planWrite({
      action: 'mail_send',
      summary: 'send mail to a@example.com with subject "Hi"',
      dryRun: true
    })
    const result = plannedWriteResult(plan)
    expect(result.ok).toBe(false)
    expect(result.planned).toBe(true)
    expect(result.delivered).toBe(false)
    expect(result.mailbox).toBeNull()
    expect(result.message).toContain('DRY RUN')
    expect(result.message).toContain('Nothing was changed')
  })

  it('marks confirm-blocked sends the same way', () => {
    const plan = planWrite({
      action: 'mail_send',
      summary: 'send mail to a@example.com, b@example.com',
      recipientCount: 2
    })
    const result = plannedWriteResult(plan)
    expect(result.ok).toBe(false)
    expect(result.planned).toBe(true)
    expect(result.delivered).toBe(false)
    expect(result.message).toContain('CONFIRMATION REQUIRED')
  })
})

describe('recipient and identifier validation', () => {
  it('accepts arrays and comma separated strings', () => {
    expect(normalizeList(['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeList('a@b.com, c@d.com')).toEqual(['a@b.com', 'c@d.com'])
    expect(normalizeList(null)).toEqual([])
    expect(normalizeList('')).toEqual([])
  })

  it('validates email addresses', () => {
    expect(isEmailAddress('peter@example.com')).toBe(true)
    expect(isEmailAddress('peter+tag@mail.example.co.uk')).toBe(true)
    expect(isEmailAddress('not-an-email')).toBe(false)
    expect(isEmailAddress('a@b')).toBe(false)
    expect(isEmailAddress('a@b.com; do shell script "rm -rf /"')).toBe(false)
  })

  it('extracts the address from display-name form', () => {
    const result = validateEmailList('Peter Coates <peter@example.com>', 'to')
    expect(result.error).toBeNull()
    expect(result.addresses).toEqual(['peter@example.com'])
  })

  it('rejects an invalid address instead of guessing', () => {
    const result = validateEmailList(['ok@example.com', 'nope'], 'to')
    expect(result.addresses).toEqual([])
    expect(result.error).toContain('invalid email address')
  })

  it('caps the recipient list', () => {
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `user${i}@example.com`)
    expect(validateEmailList(many, 'to').error).toContain('limit')
  })

  it('validates Messages handles', () => {
    expect(isPhoneNumber('+15551234567')).toBe(true)
    expect(isPhoneNumber('(555) 123-4567')).toBe(true)
    expect(isPhoneNumber('12')).toBe(false)
    expect(isMessagesHandle('peter@example.com')).toBe(true)
    expect(isMessagesHandle('"; do shell script "x"')).toBe(false)
  })

  it('normalizes and validates a Message-ID', () => {
    expect(validateMessageId('<abc123@mail.example.com>')).toBe('abc123@mail.example.com')
    expect(validateMessageId('abc123@mail.example.com')).toBe('abc123@mail.example.com')
    expect(validateMessageId('abc" & do shell script "whoami')).toBeNull()
    expect(validateMessageId(null)).toBeNull()
  })

  it('validates event, contact, chat, and calendar identifiers', () => {
    expect(validateEventId('7F3A9C21-1234-4A00-9B77-DEADBEEF0001')).toBeTruthy()
    expect(validateEventId('evt"; delete every event')).toBeNull()
    expect(validateContactId('ABCD1234-5678:ABPerson')).toBeTruthy()
    expect(validateContactId('id with space')).toBeNull()
    expect(validateChatGuid('iMessage;-;+15551234567')).toBeTruthy()
    expect(validateChatGuid('iMessage;+;chat123456789')).toBeTruthy()
    expect(validateChatGuid('chat"evil')).toBeNull()
    expect(validateCalendarName('Work')).toBe('Work')
    expect(validateCalendarName('Cal"injection')).toBeNull()
    expect(validateCalendarName('line\nbreak')).toBeNull()
  })

  it('validates labels with a safe fallback', () => {
    expect(validateLabel(undefined, 'work')).toBe('work')
    expect(validateLabel('mobile')).toBe('mobile')
    expect(validateLabel('work"; delete')).toBeNull()
  })
})

describe('body and subject limits', () => {
  it('requires a body when the tool needs one', () => {
    expect(validateBody(undefined, { required: true }).error).toContain('required')
    expect(validateBody('hello', { required: true }).text).toBe('hello')
  })

  it('rejects an oversized body', () => {
    const big = 'x'.repeat(MAX_BODY_LENGTH + 1)
    expect(validateBody(big).error).toContain('limit')
  })

  it('rejects control characters in a subject', () => {
    expect(validateSubject('ok subject').error).toBeNull()
    expect(validateSubject('bad\u0007subject').error).toContain('control characters')
  })
})

describe('error paths do not leak message bodies', () => {
  it('scrubs caller-supplied values out of text', () => {
    const body = 'Wire the deposit to account 12345'
    const scrubbed = scrubValues(`osascript failed on: ${body}`, [body])
    expect(scrubbed).not.toContain('12345')
    expect(scrubbed).toContain('[redacted]')
  })

  it('names the action and target but not the body', () => {
    const body = 'confidential contents of the email'
    const message = writeErrorMessage(
      'mail_send',
      'send mail to a@b.com with subject "Hi"',
      new Error(`Mail got an error: ${body}`),
      [body]
    )
    expect(message).toContain('mail_send failed')
    expect(message).toContain('a@b.com')
    expect(message).not.toContain('confidential contents')
  })

  it('truncates long failure reasons', () => {
    const message = writeErrorMessage('mail_send', 'send mail', new Error('y'.repeat(5000)))
    expect(message.length).toBeLessThan(500)
  })

  it('reports success by id and recipient', () => {
    const message = writeSuccessMessage('calendar_add', 'event created', {
      event_id: 'evt-1',
      calendar: 'Work'
    })
    expect(message).toContain('calendar_add: event created')
    expect(message).toContain('evt-1')
    expect(message).toContain('Work')
  })
})

describe('flag coercion', () => {
  it('treats only true and "true" as set', () => {
    expect(isFlagTrue(true)).toBe(true)
    expect(isFlagTrue('true')).toBe(true)
    expect(isFlagTrue(false)).toBe(false)
    expect(isFlagTrue('yes')).toBe(false)
    expect(isFlagTrue(undefined)).toBe(false)
  })
})
