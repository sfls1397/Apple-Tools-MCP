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
import { classifyAppleScriptError, isTccDenial, parseWriteDateTime, asString, asInteger } from '../../lib/appleScript.js'

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
