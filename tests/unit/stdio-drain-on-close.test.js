/**
 * Short-lived stdio callers (`printf ... | apple-tools-mcp`) close stdin right
 * after writing the batch. The server must still answer tools/call before it
 * exits instead of dying on stdin `close` mid-call.
 */

import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  trackInFlightRequests,
  drainInFlightThenExit
} from '../../lib/indexerRuntime.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const fixture = path.join(root, 'tests/fixtures/stdio-drain-server.js')

const BATCH = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow_echo', arguments: {} } }
].map((m) => JSON.stringify(m)).join('\n') + '\n'

function runClosedPipe(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture], { cwd: root, env: { ...process.env, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b) => { stdout += b })
    child.stderr.on('data', (b) => { stderr += b })
    child.on('error', reject)
    child.on('close', (code) => {
      const replies = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      resolve({ code, replies, stderr })
    })
    child.stdin.end(BATCH)
  })
}

function fakeTransport() {
  const sent = []
  const received = []
  return {
    sent,
    received,
    onmessage: (message) => { received.push(message) },
    send: async (message) => { sent.push(message) }
  }
}

describe('trackInFlightRequests', () => {
  it('counts requests until their response is sent', async () => {
    const transport = fakeTransport()
    const inFlight = trackInFlightRequests(transport)

    transport.onmessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} })
    transport.onmessage({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(transport.received).toHaveLength(2)
    expect(inFlight.size).toBe(1)

    let idle = false
    inFlight.whenIdle().then(() => { idle = true })
    await transport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })
    await Promise.resolve()
    expect(idle).toBe(false)

    await transport.send({ jsonrpc: '2.0', id: 7, result: {} })
    await Promise.resolve()
    expect(inFlight.size).toBe(0)
    expect(idle).toBe(true)
    expect(transport.sent).toHaveLength(2)
  })

  it('stops waiting on a request the client cancelled (SDK sends no reply)', async () => {
    const transport = fakeTransport()
    const inFlight = trackInFlightRequests(transport)
    transport.onmessage({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: {} })
    transport.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a' } })
    expect(inFlight.size).toBe(0)
    await expect(inFlight.whenIdle()).resolves.toBeUndefined()
  })

  it('clears the request even when sending the response fails', async () => {
    const transport = fakeTransport()
    transport.send = async () => { throw new Error('EPIPE') }
    const inFlight = trackInFlightRequests(transport)
    transport.onmessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })
    await expect(transport.send({ jsonrpc: '2.0', id: 3, result: {} })).rejects.toThrow('EPIPE')
    expect(inFlight.size).toBe(0)
  })
})

describe('drainInFlightThenExit', () => {
  it('exits immediately when nothing is in flight', async () => {
    let exited = false
    const result = await drainInFlightThenExit({
      inFlight: { size: 0, whenIdle: () => Promise.resolve() },
      timeoutMs: 1000,
      exit: () => { exited = true },
      log: () => {}
    })
    expect(result).toEqual({ drained: true, pending: 0 })
    expect(exited).toBe(true)
  })

  it('treats a missing tracker (closed before connect) as idle', async () => {
    let exited = false
    await drainInFlightThenExit({ inFlight: null, timeoutMs: 1000, exit: () => { exited = true }, log: () => {} })
    expect(exited).toBe(true)
  })

  it('waits for in-flight requests before exiting', async () => {
    const transport = fakeTransport()
    const inFlight = trackInFlightRequests(transport)
    transport.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })

    const order = []
    const done = drainInFlightThenExit({
      inFlight,
      timeoutMs: 5000,
      exit: () => { order.push('exit') },
      log: (msg) => { order.push(msg) }
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['Waiting for 1 in-flight request(s) before exit...'])

    await transport.send({ jsonrpc: '2.0', id: 2, result: {} })
    await expect(done).resolves.toEqual({ drained: true, pending: 1 })
    expect(order.slice(1)).toEqual(['exit'])
  })

  it('gives up after timeoutMs so a hung tool cannot keep the process alive', async () => {
    let exited = false
    const logs = []
    const result = await drainInFlightThenExit({
      inFlight: { size: 1, whenIdle: () => new Promise(() => {}) },
      timeoutMs: 10,
      exit: () => { exited = true },
      log: (msg) => logs.push(msg)
    })
    expect(result).toEqual({ drained: false, pending: 1 })
    expect(exited).toBe(true)
    expect(logs[1]).toBe('Gave up on 1 in-flight request(s) after 10ms.')
  })
})

describe('closed-pipe stdio host (batched NDJSON then EOF)', () => {
  it('answers tools/call before exiting, including a large reply', async () => {
    // 512KB > the pipe buffer, so exit must wait for stdout to drain too.
    const { code, replies, stderr } = await runClosedPipe({ DELAY_MS: '300', REPLY_BYTES: String(512 * 1024) })
    expect(code).toBe(0)
    expect(replies.map((r) => r.id)).toEqual([1, 2])
    expect(replies[1].result.content[0].text).toHaveLength(512 * 1024)
    expect(stderr).toContain('Waiting for 1 in-flight request(s) before exit...')
  })

  it('control: the old synchronous exit drops tools/call', async () => {
    const { code, replies } = await runClosedPipe({ DRAIN: '0', DELAY_MS: '300' })
    expect(code).toBe(0)
    expect(replies.map((r) => r.id)).toEqual([1])
  })
})
