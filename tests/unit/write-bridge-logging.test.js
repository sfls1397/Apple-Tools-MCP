/**
 * Bridged-write logging and the declined-then-local-fallback message.
 *
 * Overnight on the Mini (2026-10-01) a Network-Tools alert email took 10
 * minutes to get out: the indexer daemon declined mail_send, the HTTP
 * process fell back to running it locally (where GUI scripting can never
 * work), and the only log line said "Write bridge unavailable … (no
 * response)". The daemon's own reason was never logged anywhere.
 */

import { describe, it, expect } from 'vitest'
import { classifyWriteFailure, dispatchWriteTool, loggedBridgeHandler } from '../../lib/writeTools.js'

const ADDR = 'someone@example.com'
const declinedMsg = `mail_send failed — attempted to send mail to ${ADDR} with subject "x". System Events GUI scripting is unavailable for this process, so the body cannot be typed into Mail.`

describe('classifyWriteFailure', () => {
  it('maps known failure texts to a reason class', () => {
    expect(classifyWriteFailure(declinedMsg)).toBe('gui_scripting_unavailable')
    expect(classifyWriteFailure('macOS denied Accessibility (System Events …)')).toBe('accessibility_denied')
    expect(classifyWriteFailure('The display is asleep, so System Events cannot see Mail')).toBe('display_asleep_or_screen_saver')
    expect(classifyWriteFailure('Keyboard focus was not on the message body (focus proof failed)')).toBe('compose_focus')
    expect(classifyWriteFailure('Mail AppleScript timed out (ETIMEDOUT)')).toBe('timeout')
    expect(classifyWriteFailure('not authorized to send Apple events (-1743)')).toBe('automation_denied')
    expect(classifyWriteFailure('something new')).toBe('other')
  })
})

describe('loggedBridgeHandler', () => {
  it('logs one timestamped line per write without addresses or subjects', async () => {
    const lines = []
    let t = 1000
    const h = loggedBridgeHandler(async () => ({ ok: false, unsupported: true, message: declinedMsg }), (m) => lines.push(m), () => (t += 250))
    const r = await h('mail_send', { to: [ADDR], subject: 'x' })
    expect(r.unsupported).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^1970-01-01T00:00:01\.250Z write bridge: mail_send failed in 250ms \(gui_scripting_unavailable, unsupported\)$/)
    expect(lines[0]).not.toContain(ADDR)
    const ok = loggedBridgeHandler(async () => ({ ok: true, message: `sent to ${ADDR}` }), (m) => lines.push(m))
    await ok('mail_send', {})
    expect(lines[1]).toMatch(/write bridge: mail_send ok in \d+ms$/)
    const dry = loggedBridgeHandler(async () => ({ ok: false, planned: true, message: 'DRY RUN (mail_send): would send' }), (m) => lines.push(m))
    await dry('mail_send', {})
    expect(lines[2]).toMatch(/write bridge: mail_send planned \(dry run \/ needs confirm\) in \d+ms$/)
  })
})

describe('dispatchWriteTool declined by the daemon', () => {
  const base = { probe: async () => true, socketPath: '/tmp/none.sock' }

  it("returns the daemon's reason when the local fallback also fails, and logs 'declined'", async () => {
    const logs = []
    const r = await dispatchWriteTool('mail_send', { to: [ADDR] }, {
      ...base,
      request: async () => ({ delivered: true, response: { ok: false, unsupported: true, message: declinedMsg }, error: null }),
      runLocally: () => ({ ok: false, message: 'mail_send failed — The display is asleep, so System Events cannot see Mail.' }),
      log: (m) => logs.push(m)
    })
    expect(r.ok).toBe(false)
    expect(r.message.startsWith(declinedMsg)).toBe(true)
    expect(r.message).toMatch(/local fallback in this process also failed: display_asleep_or_screen_saver/)
    expect(logs).toEqual(['Write bridge declined mail_send (gui_scripting_unavailable); running locally.'])
  })

  it('keeps a successful local fallback as is', async () => {
    const r = await dispatchWriteTool('mail_send', { to: [ADDR] }, {
      ...base,
      request: async () => ({ delivered: true, response: { ok: false, unsupported: true, message: declinedMsg }, error: null }),
      runLocally: () => ({ ok: true, message: 'sent' }),
      log: () => {}
    })
    expect(r).toEqual({ ok: true, message: 'sent' })
  })

  it("still says 'unavailable' when the daemon never answered", async () => {
    const logs = []
    await dispatchWriteTool('mail_send', { to: [ADDR] }, {
      ...base,
      request: async () => ({ delivered: false, response: null, error: 'write bridge timed out' }),
      runLocally: () => ({ ok: false, message: 'x' }),
      log: (m) => logs.push(m)
    })
    expect(logs[0]).toBe('Write bridge unavailable for mail_send (write bridge timed out); running locally.')
  })
})
