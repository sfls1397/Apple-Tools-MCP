/**
 * Nothing sent or drafted as the account owner carries a dash used as
 * punctuation: em dash, en dash, or a hyphen with a space on each side.
 * Hyphens inside names and identifiers stay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const osascript = vi.hoisted(() => vi.fn(() => ''))

vi.mock('../../lib/shell.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, safeOsascript: osascript }
})

import { rewriteDashes, findDashes } from '../../lib/noDashes.js'
import { executeWriteToolLocally } from '../../lib/writeTools.js'

function lastScript() {
  const calls = osascript.mock.calls
  return String(calls[calls.length - 1][0])
}

beforeEach(() => {
  osascript.mockReset()
  osascript.mockImplementation(() => '')
})

describe('rewriteDashes', () => {
  it('rewrites em dashes, en dashes and spaced hyphens', () => {
    expect(rewriteDashes('Thanks — talk soon').text).toBe('Thanks, talk soon')
    expect(rewriteDashes('Thanks—talk soon').text).toBe('Thanks, talk soon')
    expect(rewriteDashes('Thanks – talk soon').text).toBe('Thanks, talk soon')
    expect(rewriteDashes('Thanks - talk soon').text).toBe('Thanks, talk soon')
    expect(rewriteDashes('Thanks -- talk soon').text).toBe('Thanks, talk soon')
    expect(rewriteDashes('Pages 3–5').text).toBe('Pages 3 to 5')
    expect(rewriteDashes('One more thing —').text).toBe('One more thing')
    expect(rewriteDashes('Lunch — noon, Friday — works?').text).toBe('Lunch, noon, Friday, works?')
    expect(rewriteDashes('Quick note —.').text).toBe('Quick note.')
    expect(rewriteDashes('a — b').count).toBe(1)
  })

  it('leaves hyphenated names, identifiers, bullets and signatures alone', () => {
    const clean = [
      'Alexa-Echo-MCP shipped v1.1.0 from sfls1397/SimpleFIN-Data-MCP.',
      'See https://example.com/a-b-c and the re-check on 2026-11-10.',
      '- first item\n- second item',
      'Thanks,\n\n-- \nPeter',
      'It was -5 outside.',
      ''
    ]
    for (const text of clean) {
      expect(rewriteDashes(text)).toEqual({ text, count: 0 })
      expect(findDashes(text)).toEqual([])
    }
  })

  it('keeps line breaks and indentation', () => {
    expect(rewriteDashes('Hi Dad,\n\nRunning late — sorry.\n\nLove,\n\nPeter').text)
      .toBe('Hi Dad,\n\nRunning late, sorry.\n\nLove,\n\nPeter')
    expect(rewriteDashes('  — indented point').text).toBe('  indented point')
  })

  it('rewrites dash entities in HTML bodies', () => {
    expect(rewriteDashes('<p>Hi &mdash; there &#8211; you</p>', { html: true }).text).toBe('<p>Hi, there, you</p>')
  })

  it('is idempotent', () => {
    const once = rewriteDashes('A — B - C – D').text
    expect(rewriteDashes(once)).toEqual({ text: once, count: 0 })
  })
})

describe('send paths', () => {
  it('rewrites a mail subject before the handler sees it and says so', () => {
    const result = executeWriteToolLocally('mail_draft', {
      to: ['a@example.com'], subject: 'Plan — Friday', body: 'Works – see you then', dry_run: true
    })
    expect(result.message).toContain('subject "Plan, Friday"')
    expect(result.message).not.toMatch(/[–—]/)
    expect(result.message).toContain('Rewrote 2 dashes')
  })

  it('rewrites a text message body before it reaches Messages', () => {
    const result = executeWriteToolLocally('messages_send', { to: ['+15551234567'], text: 'Running late — there in 10 - sorry' })
    expect(result.ok).toBe(true)
    expect(lastScript()).toContain('send "Running late, there in 10, sorry" to theTarget')
    expect(result.message).toContain('Rewrote 2 dashes')
  })

  it('passes a body with only hyphenated names through untouched', () => {
    const result = executeWriteToolLocally('messages_send', { to: ['+15551234567'], text: 'Alexa-Echo-MCP v1.1.0 is live' })
    expect(result.ok).toBe(true)
    expect(lastScript()).toContain('send "Alexa-Echo-MCP v1.1.0 is live" to theTarget')
    expect(result.message).not.toContain('Rewrote')
  })

  it('leaves non-text tools alone', () => {
    const result = executeWriteToolLocally('calendar_add', { title: 'Lunch — Dad', start: 'x', dry_run: true })
    expect(result.message).not.toContain('Rewrote')
  })
})
