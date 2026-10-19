import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { idempotentMailSend } from '../../lib/mailIdempotency.js'
import { dispatchWriteTool, classifyWriteFailure } from '../../lib/writeTools.js'
import { startWriteBridgeServer, requestWriteViaBridge } from '../../lib/writeBridge.js'
import { spawnCollect, safeSqlite3JsonAsync, safeFindAsync } from '../../lib/shell.js'

const args = { to: ['a@example.com'], subject: 'Retry fixture', body: 'Fixture only' }
const options = () => ({ directory: fs.mkdtempSync(path.join(os.tmpdir(), 'atm-claims-')) })

describe('persistent send claims', () => {
  it('replays success across calls and stores no recipient, subject, body or raw key', () => {
    const opts = options()
    const run = vi.fn(() => ({ ok: true, delivered: true, mailbox: 'sent' }))
    const keyed = { ...args, idempotency_key: 'fixture-delivery' }
    expect(idempotentMailSend(keyed, run, opts).ok).toBe(true)
    expect(idempotentMailSend(keyed, run, opts).deduplicated).toBe(true)
    expect(run).toHaveBeenCalledTimes(1)
    const dir = path.join(opts.directory, fs.readdirSync(opts.directory)[0])
    const file = path.join(dir, '1.json')
    const stored = fs.readFileSync(file, 'utf8')
    for (const value of [...args.to, args.subject, args.body, keyed.idempotency_key]) expect(stored).not.toContain(value)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
  it('never resends after timeout, thrown error, restart or an arbitrarily late completion', () => {
    for (const outcome of [() => ({ ok: false, unconfirmed: true }), () => { throw Error('lost response') }]) {
      const opts = options()
      const run = vi.fn(outcome)
      idempotentMailSend(args, run, opts)
      expect(idempotentMailSend(args, run, { ...opts, now: () => Date.now() + 7 * 86400000 }).unconfirmed).toBe(true)
      expect(run).toHaveBeenCalledTimes(1)
    }
  })
  it('arbitrates concurrent/reentrant requests before starting the first send', () => {
    const opts = options()
    const second = vi.fn()
    idempotentMailSend(args, () => {
      expect(idempotentMailSend(args, second, opts).unconfirmed).toBe(true)
      return { ok: true }
    }, opts)
    expect(second).not.toHaveBeenCalled()
  })
  it('allows a retry only after explicit evidence that sending never started', () => {
    const opts = options()
    const run = vi.fn().mockReturnValueOnce({ ok: false, sendStarted: false }).mockReturnValue({ ok: true })
    idempotentMailSend(args, run, opts)
    expect(idempotentMailSend(args, run, opts).ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('rejects key reuse with changed content and allows a new intentional delivery key', () => {
    const opts = options()
    const run = vi.fn(() => ({ ok: true }))
    idempotentMailSend({ ...args, idempotency_key: 'one' }, run, opts)
    expect(idempotentMailSend({ ...args, body: 'Changed', idempotency_key: 'one' }, run, opts).ok).toBe(false)
    idempotentMailSend({ ...args, idempotency_key: 'two' }, run, opts)
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('arbitrates simultaneous independent processes using the same delivery key', async () => {
    const opts = options()
    const counter = path.join(opts.directory, 'executions')
    const moduleUrl = new URL('../../lib/mailIdempotency.js', import.meta.url).href
    const source = `import fs from 'fs'; import { idempotentMailSend } from ${JSON.stringify(moduleUrl)};
      idempotentMailSend(${JSON.stringify(args)}, () => {
        fs.appendFileSync(${JSON.stringify(counter)}, 'sent\\n'); return { ok: true };
      }, ${JSON.stringify(opts)});`
    const results = await Promise.all([1, 2].map(() => spawnCollect(process.execPath, ['--input-type=module', '-e', source])))
    expect(results.every(r => r.status === 0)).toBe(true)
    expect(fs.readFileSync(counter, 'utf8')).toBe('sent\n')
  })
  it('retains both accepted automatic fingerprints and explicit delivery keys without expiry', () => {
    for (const explicit of [false, true]) {
      const opts = options()
      const delivery = explicit ? { ...args, idempotency_key: 'durable' } : args
      const run = vi.fn(() => ({ ok: true }))
      idempotentMailSend(delivery, run, { ...opts, now: () => 0 })
      idempotentMailSend(delivery, run, { ...opts, now: () => 2 * 86400000 })
      expect(run).toHaveBeenCalledTimes(1)
    }
  })
  it('keeps dry runs free of claims and fails closed on corrupt records', () => {
    const opts = options()
    idempotentMailSend({ ...args, dry_run: true }, () => ({ planned: true }), opts)
    expect(fs.readdirSync(opts.directory)).toEqual([])
    idempotentMailSend(args, () => ({ ok: true }), opts)
    const dir = path.join(opts.directory, fs.readdirSync(opts.directory)[0])
    fs.writeFileSync(path.join(dir, '1.json'), '')
    const run = vi.fn()
    expect(idempotentMailSend(args, run, opts).unconfirmed).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ambiguous bridge delivery', () => {
  it('does not start a local send after the daemon times out and later completes', async () => {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atm-late-')), 'w.sock')
    let complete
    const sent = vi.fn()
    const server = await startWriteBridgeServer({ socketPath, handler: () => new Promise(resolve => {
      complete = () => { sent(); resolve({ ok: true }) }
    }) })
    const local = vi.fn()
    try {
      const result = await dispatchWriteTool('mail_send', args, {
        socketPath, probe: async () => true,
        request: request => requestWriteViaBridge({ ...request, timeoutMs: 30 }), runLocally: local
      })
      expect(result.unconfirmed).toBe(true)
      expect(local).not.toHaveBeenCalled()
      complete()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(sent).toHaveBeenCalledTimes(1)
    } finally { server.close() }
  })
  it('rejects an expired queued request before calling the write handler', async () => {
    const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atm-expired-')), 'w.sock')
    const handler = vi.fn()
    const server = await startWriteBridgeServer({ socketPath, handler })
    try {
      const result = await new Promise(resolve => {
        const client = net.connect(socketPath, () => client.write(JSON.stringify({ tool: 'mail_send', args, expiresAt: Date.now() - 1 }) + '\n'))
        client.on('data', chunk => { resolve(JSON.parse(chunk.toString())); client.destroy() })
      })
      expect(result.sendStarted).toBe(false)
      expect(handler).not.toHaveBeenCalled()
    } finally { server.close() }
  })
  it('permits local execution only when the transport proves it never handed off', async () => {
    const local = vi.fn(() => ({ ok: true }))
    await dispatchWriteTool('mail_send', args, { probe: async () => true,
      request: async () => ({ delivered: false, mayHaveStarted: false }), runLocally: local })
    expect(local).toHaveBeenCalledTimes(1)
    expect(classifyWriteFailure('System Events probe timed out; permission status is unknown')).toBe('probe_timeout')
  })
  it('does not resend when the daemon returns a malformed response or an unqualified unsupported result', async () => {
    for (const response of [null, 'invalid', { unsupported: true }]) {
      const local = vi.fn()
      const result = await dispatchWriteTool('mail_send', args, { probe: async () => true,
        request: async () => ({ delivered: true, response }), runLocally: local })
      expect(result.unconfirmed).toBe(true)
      expect(local).not.toHaveBeenCalled()
    }
  })
})

describe('nonblocking index source helpers', () => {
  it('keeps the event loop responsive while a child is waiting and kills it on timeout', async () => {
    let ticked = false
    const waiting = spawnCollect(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 50 })
    setTimeout(() => { ticked = true }, 5)
    const result = await waiting
    expect(ticked).toBe(true)
    expect(result.error.code).toBe('ETIMEDOUT')
  })
  it('bounds child output and reports missing executables without hanging', async () => {
    const overflow = await spawnCollect(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBuffer: 10 })
    expect(overflow.error.code).toBe('ENOBUFS')
    const missing = await spawnCollect('/nonexistent-apple-tools-fixture', [])
    expect(missing.error.code).toBe('ENOENT')
  })
  it('preserves async argv validation and sqlite JSON behavior', async () => {
    await expect(safeFindAsync('relative')).rejects.toThrow()
    await expect(safeSqlite3JsonAsync('relative', 'SELECT 1')).rejects.toThrow()
    const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atm-sqlite-')), 'fixture.db')
    fs.writeFileSync(db, '')
    expect(await safeSqlite3JsonAsync(db, 'SELECT 1 AS value')).toEqual([{ value: 1 }])
  })
})
