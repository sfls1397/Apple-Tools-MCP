import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  buildEventKitWorkerScript,
  shouldStartEventKitSession,
  startEventKitSession,
  setEventKitSession,
  getEventKitSession,
  ensureEventKitSession,
  closeEventKitSession,
  workerScriptPath,
  sessionPaths
} from '../../lib/eventKitSession.js'
import { EVENTKIT_JXA_HELPERS } from '../../lib/calendarWrite.js'

beforeEach(() => {
  closeEventKitSession()
})

describe('EventKit session policy', () => {
  it('does not start under Vitest or off macOS', () => {
    expect(shouldStartEventKitSession({ platform: 'linux', env: {} })).toBe(false)
    expect(shouldStartEventKitSession({ platform: 'darwin', env: { VITEST: 'true' } })).toBe(false)
    expect(shouldStartEventKitSession({ platform: 'darwin', env: { APPLE_TOOLS_EVENTKIT_SESSION: '0' } })).toBe(false)
    expect(shouldStartEventKitSession({ platform: 'darwin', env: {} })).toBe(true)
    expect(ensureEventKitSession({ helpers: EVENTKIT_JXA_HELPERS })).toBeNull()
  })

  it('writes the worker under the app directory', () => {
    expect(workerScriptPath('/Users/example')).toBe('/Users/example/.apple-tools-mcp/eventkit-worker.jxa')
  })
})

describe('EventKit worker script', () => {
  it('caches the in-memory EKEvent and does not re-query after create', () => {
    const script = buildEventKitWorkerScript(EVENTKIT_JXA_HELPERS)
    expect(script).toContain('function remember(ev)')
    expect(script).toContain('cache[keys[i]] = ev')
    expect(script).toContain('if (cmd.op === "create") return createEvent(cmd)')
    expect(script).toContain('if (cmd.op === "update") return updateEvent(cmd)')
    expect(script).toContain('if (cmd.op === "remove") return removeEvent(cmd)')
    expect(script).toContain('remember(event)')
    expect(script).toContain('removeEventSpanCommitError')
    expect(script).not.toContain('EVENTKIT_LOOKUP_FAILED')
    expect(script).toContain('sessionMiss')
    expect(script).toContain('JSON.parse')
    expect(script).toContain('writeToFileAtomicallyEncodingError')
    expect(script).toContain('fileExistsAtPath')
  })
})

describe('EventKit session transport', () => {
  it('handshakes over cmd/rsp files and then runs create', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-ek-home-'))
    const paths = sessionPaths(home)
    const child = { on() {}, kill() {} }
    const session = startEventKitSession({
      helpers: EVENTKIT_JXA_HELPERS,
      home,
      spawnImpl: () => child,
      sleep() {
        if (!fs.existsSync(paths.cmdPath)) return
        const cmd = JSON.parse(fs.readFileSync(paths.cmdPath, 'utf8'))
        fs.unlinkSync(paths.cmdPath)
        const output = cmd.op === 'ping' ? 'pong' : 'UID<<>>EK<<>>Calendar<<>>ITEM'
        fs.writeFileSync(paths.rspPath, JSON.stringify({ ok: true, output }))
      }
    })

    const created = session.request({ op: 'create', calendarName: 'Calendar', title: 'x', startSec: 1, endSec: 2 })
    expect(created).toEqual({ ok: true, output: 'UID<<>>EK<<>>Calendar<<>>ITEM' })
    setEventKitSession(session)
    expect(getEventKitSession()).toBe(session)
    closeEventKitSession()
    expect(getEventKitSession()).toBeNull()
  })
})
