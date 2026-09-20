/**
 * Write bridge + routing tests.
 *
 * The bridge exists because macOS attributes Apple events to the process
 * responsible for the MCP server: a stdio host without Contacts/Calendar
 * automation rights blocks those writes even when node has Full Disk Access.
 * The launchd-started indexer daemon does not have that problem, so it
 * performs writes on behalf of stdio clients over a user-only unix socket.
 *
 * The socket itself is portable, so this exercises the real transport.
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  startWriteBridgeServer,
  requestWriteViaBridge,
  probeSocket,
  defaultSocketPath,
  WRITE_SOCKET_NAME
} from '../../lib/writeBridge.js'
import {
  planWriteRoute,
  planAfterDelegation,
  isTccSensitiveWrite,
  tccFallbackAdvice
} from '../../lib/writeRouting.js'
import {
  classifyAppleScriptError,
  isTccDenial,
  parseWriteDateTime,
  asString,
  asInteger,
  tccGuidanceFor,
  appBundleInstalled,
  CONTACTS_TCC_GUIDANCE,
  CALENDAR_TCC_GUIDANCE,
  MAIL_TCC_GUIDANCE,
  MESSAGES_TCC_GUIDANCE,
  ATTRIBUTION_GUIDANCE,
  TCC_GUIDANCE
} from '../../lib/appleScript.js'
import { isAddressBookPermissionError, ADDRESSBOOK_FDA_HINT } from '../../contacts.js'

const started = []

afterEach(() => {
  while (started.length > 0) {
    const bridge = started.pop()
    try {
      bridge.close()
    } catch {
      // already closed
    }
  }
})

async function startBridge(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-bridge-'))
  const socketPath = path.join(dir, WRITE_SOCKET_NAME)
  const bridge = await startWriteBridgeServer({ socketPath, handler })
  started.push(bridge)
  return { socketPath, bridge }
}

describe('write bridge transport', () => {
  it('round-trips a write request to the daemon handler', async () => {
    const seen = []
    const { socketPath } = await startBridge((tool, args) => {
      seen.push({ tool, args })
      return { ok: true, message: `${tool} done for ${args.contact_id}` }
    })

    const result = await requestWriteViaBridge({
      socketPath,
      tool: 'contacts_remove',
      args: { contact_id: 'ABCD:ABPerson', confirm: true }
    })

    expect(result.delivered).toBe(true)
    expect(result.response).toEqual({ ok: true, message: 'contacts_remove done for ABCD:ABPerson' })
    expect(seen[0].tool).toBe('contacts_remove')
    expect(seen[0].args.confirm).toBe(true)
  })

  it('reports a failure from the handler without throwing', async () => {
    const { socketPath } = await startBridge(() => {
      throw new Error('Contacts.app refused')
    })

    const result = await requestWriteViaBridge({ socketPath, tool: 'contacts_add', args: {} })
    expect(result.delivered).toBe(true)
    expect(result.response.ok).toBe(false)
    expect(result.response.message).toContain('Contacts.app refused')
  })

  it('supports an async handler', async () => {
    const { socketPath } = await startBridge(async () => ({ ok: true, message: 'async done' }))
    const result = await requestWriteViaBridge({ socketPath, tool: 'mail_send', args: {} })
    expect(result.response.message).toBe('async done')
  })

  it('probes true when listening and false when absent', async () => {
    const { socketPath, bridge } = await startBridge(() => ({ ok: true, message: 'x' }))
    expect(await probeSocket(socketPath)).toBe(true)

    bridge.close()
    expect(await probeSocket(socketPath)).toBe(false)
  })

  it('does not deliver when nothing is listening', async () => {
    const missing = path.join(os.tmpdir(), `atm-missing-${Date.now()}.sock`)
    const result = await requestWriteViaBridge({ socketPath: missing, tool: 'mail_send', args: {} })
    expect(result.delivered).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('takes over a stale socket file left by a crash', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-stale-'))
    const socketPath = path.join(dir, WRITE_SOCKET_NAME)
    fs.writeFileSync(socketPath, '')

    const bridge = await startWriteBridgeServer({ socketPath, handler: () => ({ ok: true, message: 'fresh' }) })
    started.push(bridge)

    const result = await requestWriteViaBridge({ socketPath, tool: 'mail_send', args: {} })
    expect(result.response.message).toBe('fresh')
  })

  it('refuses a second live listener on the same socket', async () => {
    const { socketPath } = await startBridge(() => ({ ok: true, message: 'first' }))
    await expect(
      startWriteBridgeServer({ socketPath, handler: () => ({ ok: true, message: 'second' }) })
    ).rejects.toThrow(/already listening/)
  })

  it('keeps the socket inside the app data directory', () => {
    expect(defaultSocketPath('/Users/example')).toBe('/Users/example/.apple-tools-mcp/writer.sock')
  })

  it('creates the socket with owner-only permissions', async () => {
    const { socketPath } = await startBridge(() => ({ ok: true, message: 'x' }))
    const mode = fs.statSync(socketPath).mode & 0o777
    expect(mode & 0o077).toBe(0)
    const dirMode = fs.statSync(path.dirname(socketPath)).mode & 0o777
    expect(dirMode & 0o022).toBe(0)
  })
})

describe('write routing policy', () => {
  it('keeps the daemon local', () => {
    const route = planWriteRoute({ indexerMode: true, bridgeAvailable: true, toolName: 'contacts_add' })
    expect(route.target).toBe('local')
  })

  it('delegates privacy-gated writes from a stdio client', () => {
    expect(planWriteRoute({ indexerMode: false, bridgeAvailable: true, toolName: 'contacts_add' }).target).toBe('daemon')
    expect(planWriteRoute({ indexerMode: false, bridgeAvailable: true, toolName: 'calendar_remove' }).target).toBe('daemon')
  })

  it('stays local when no daemon is listening', () => {
    expect(planWriteRoute({ indexerMode: false, bridgeAvailable: false, toolName: 'contacts_add' }).target).toBe('local')
  })

  it('knows which writes macOS gates on privacy', () => {
    expect(isTccSensitiveWrite('contacts_remove')).toBe(true)
    expect(isTccSensitiveWrite('calendar_add')).toBe(true)
    expect(isTccSensitiveWrite('mail_send')).toBe(true)
    expect(isTccSensitiveWrite('messages_send')).toBe(true)
    expect(isTccSensitiveWrite('rebuild_index')).toBe(false)
  })

  it('falls back locally on an undelivered or unsupported delegation', () => {
    expect(planAfterDelegation({ delivered: false, response: null }).fallbackLocal).toBe(true)
    expect(planAfterDelegation({ delivered: true, response: { unsupported: true } }).fallbackLocal).toBe(true)
    expect(planAfterDelegation({ delivered: true, response: { ok: true, message: 'x' } }).fallbackLocal).toBe(false)
  })

  it('advises starting the daemon when none is running', () => {
    expect(tccFallbackAdvice({ bridgeAvailable: false })).toContain('apple-tools-indexer')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('Full Disk Access')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('Automation')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('Do not add node via +')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('Mail.app')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('Messages.app')
    expect(tccFallbackAdvice({ bridgeAvailable: true })).toContain('TCC / Automation denied')
  })
})

describe('AppleScript error classification', () => {
  it('detects TCC denials', () => {
    expect(isTccDenial('Not authorized to send Apple events to Contacts. (-1743)')).toBe(true)
    expect(isTccDenial('osascript: Operation not permitted')).toBe(true)
    expect(isTccDenial('execution error: Calendar got an error (-10004)')).toBe(true)
    expect(isTccDenial('some other failure')).toBe(false)
  })

  it('separates not-found, app-unavailable, and unknown failures', () => {
    expect(classifyAppleScriptError('script error: EVENT_NOT_FOUND')).toBe('not_found')
    expect(classifyAppleScriptError("Mail got an error: Application isn't running. (-600)")).toBe('app_unavailable')
    expect(classifyAppleScriptError('weird failure')).toBe('unknown')
  })
})

describe('TCC guidance separates reads from writes', () => {
  it('explains that the AddressBook entitlement gates Contacts writes, not reads', () => {
    expect(tccGuidanceFor('contacts')).toBe(CONTACTS_TCC_GUIDANCE)
    expect(CONTACTS_TCC_GUIDANCE).toContain('CNContactStore')
    expect(CONTACTS_TCC_GUIDANCE).toContain('com.apple.security.personal-information.addressbook')
    expect(CONTACTS_TCC_GUIDANCE).toContain('reads')
    expect(CONTACTS_TCC_GUIDANCE).toContain('Full Disk Access')
    // Never tell the user to fix a missing entitlement with tccutil or FDA.
    expect(CONTACTS_TCC_GUIDANCE).toContain('cannot be fixed with Full Disk Access or tccutil')
  })

  it('explains the calendars entitlement the same way, since Claude.app holds neither', () => {
    expect(tccGuidanceFor('calendar')).toBe(CALENDAR_TCC_GUIDANCE)
    expect(CALENDAR_TCC_GUIDANCE).toContain('com.apple.security.personal-information.calendars')
    expect(CALENDAR_TCC_GUIDANCE).toContain('EventKit')
    expect(CALENDAR_TCC_GUIDANCE).toContain('reads')
    expect(CALENDAR_TCC_GUIDANCE).toContain('Full Disk Access or tccutil cannot change it')
  })

  it('points Contacts and Calendar denials at the daemon', () => {
    expect(CONTACTS_TCC_GUIDANCE).toContain('apple-tools-indexer')
    expect(CALENDAR_TCC_GUIDANCE).toContain('apple-tools-indexer')
    expect(tccGuidanceFor('mail')).toBe(MAIL_TCC_GUIDANCE)
    expect(tccGuidanceFor('messages')).toBe(MESSAGES_TCC_GUIDANCE)
    expect(tccGuidanceFor('other')).toBe(TCC_GUIDANCE)
  })

  it('treats a hung Mail compose timeout as TCC / Automation denied, not a missing app', () => {
    // Mini: make new outgoing message blocks until spawnSync times out when
    // node → Mail Automation is denied. The error string contains
    // "spawnSync osascript" but must not be classified as ENOENT.
    expect(classifyAppleScriptError('spawnSync osascript ETIMEDOUT')).toBe('tcc')
    expect(classifyAppleScriptError('Error: spawnSync osascript ETIMEDOUT')).toBe('tcc')
    expect(classifyAppleScriptError('Mail got an error: AppleEvent timed out. (-1712)')).toBe('tcc')
    expect(isTccDenial('spawnSync osascript ETIMEDOUT')).toBe(true)
    expect(isTccDenial('AppleEvent timed out. (-1712)')).toBe(true)
    expect(MAIL_TCC_GUIDANCE).toContain('hang or timeout')
    expect(MAIL_TCC_GUIDANCE).toContain('dry_run never talks to Mail')
    expect(MAIL_TCC_GUIDANCE).not.toMatch(/could not be reached/)
    expect(MESSAGES_TCC_GUIDANCE).toContain('node → Messages')
  })

  it('treats a missing osascript as an unavailable app, not a privacy denial', () => {
    expect(classifyAppleScriptError('spawnSync osascript ENOENT')).toBe('app_unavailable')
    expect(isTccDenial('spawnSync osascript ENOENT')).toBe(false)
  })

  it('calls an installed app that will not respond an attribution failure', () => {
    // QA hit this on the Mini: Contacts.app and Calendar.app are present in
    // /System/Applications, but the smoke test reported "not available on
    // this host" when the real problem was the responsible process.
    const message = "Contacts got an error: Can't get application \"Contacts\". (-1728)"

    expect(classifyAppleScriptError(message, { appInstalled: true })).toBe('attribution')
    expect(classifyAppleScriptError(message, { appInstalled: false })).toBe('app_unavailable')
    expect(classifyAppleScriptError(message)).toBe('app_unavailable')

    expect(ATTRIBUTION_GUIDANCE).toContain('Automation / responsible-process')
    expect(ATTRIBUTION_GUIDANCE).toContain('apple-tools-indexer')
    expect(ATTRIBUTION_GUIDANCE).toContain('Terminal.app')
  })

  it('finds the first-party apps where macOS actually keeps them', () => {
    const seen = []
    const exists = (p) => {
      seen.push(p)
      return p === '/System/Applications/Contacts.app'
    }

    expect(appBundleInstalled('Contacts', exists)).toBe(true)
    expect(seen).toContain('/System/Applications/Contacts.app')
    expect(appBundleInstalled('Calendar', () => false)).toBe(false)
    // No app name means we cannot tell, which must not be read as "missing".
    expect(appBundleInstalled(null)).toBeNull()
    expect(appBundleInstalled('../../evil', () => true)).toBeNull()
  })

  it('classifies an AddressBook read failure as Full Disk Access, not the entitlement gap', () => {
    expect(isAddressBookPermissionError('EPERM: operation not permitted')).toBe(true)
    expect(isAddressBookPermissionError('unable to open database file')).toBe(true)
    expect(isAddressBookPermissionError('Authorization denied')).toBe(true)
    expect(isAddressBookPermissionError('no such table: ZABCDRECORD')).toBe(false)

    expect(ADDRESSBOOK_FDA_HINT).toContain('Full Disk Access')
    expect(ADDRESSBOOK_FDA_HINT).toContain('not the AddressBook entitlement')
  })
})

describe('AppleScript literal building', () => {
  it('escapes quotes, backslashes, and newlines', () => {
    expect(asString('say "hi"')).toBe('"say \\"hi\\""')
    expect(asString('back\\slash')).toBe('"back\\\\slash"')
    expect(asString('a\nb')).toBe('"a\\nb"')
    expect(asString(null)).toBe('""')
  })

  it('refuses a non-integer where a number is required', () => {
    expect(asInteger(5, { min: 0, max: 10 })).toBe('5')
    expect(() => asInteger('5; delete', { min: 0, max: 10 })).toThrow()
    expect(() => asInteger(99, { min: 0, max: 10 })).toThrow()
  })
})

describe('strict write datetime parsing', () => {
  it('accepts explicit local datetimes', () => {
    expect(parseWriteDateTime('2026-09-21 14:30').parts).toMatchObject({ year: 2026, month: 9, day: 21, hour: 14, minute: 30 })
    expect(parseWriteDateTime('2026-09-21T14:30:00').parts).toMatchObject({ hour: 14, minute: 30 })
    expect(parseWriteDateTime('2026-09-21').dateOnly).toBe(true)
  })

  it('rejects natural language and impossible dates', () => {
    expect(parseWriteDateTime('tomorrow at 3').error).toContain('Natural language')
    expect(parseWriteDateTime('2026-02-31').error).toContain('valid calendar date')
    expect(parseWriteDateTime('2026-13-01').error).toBeTruthy()
    expect(parseWriteDateTime('').error).toContain('required')
  })
})
