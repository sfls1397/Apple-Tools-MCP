import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { defaultSocketPath, requestWriteViaBridge } from '../../lib/writeBridge.js'

const entry = fileURLToPath(new URL('../../bin/apple-tools-indexer.js', import.meta.url))

it('answers a mail preview while the daemon’s index writer is stopped', async () => {
  const home = fs.mkdtempSync('/tmp/atm-indexer-')
  const preload = path.join(home, 'stop-indexer.mjs')
  const lockFile = path.join(home, '.apple-tools-mcp', 'indexer.lock')
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, value, options) => {
      const result = write(file, value, options);
      if (file === ${JSON.stringify(lockFile)} && options?.flag === 'wx') {
        fs.writeSync(2, 'INDEX_WRITER=' + process.pid + '\\n');
        process.kill(process.pid, 'SIGSTOP');
      }
      return result;
    };
  `)

  const daemon = spawn(process.execPath, ['--import', preload, entry], {
    env: {
      ...process.env,
      HOME: home,
      APPLE_TOOLS_INDEX_DIR: path.join(home, 'index'),
      APPLE_TOOLS_META_FILE: path.join(home, 'index-meta.json'),
      APPLE_TOOLS_EVENTKIT_SESSION: '0'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const exited = once(daemon, 'exit')
  let output = ''
  let writerPid
  try {
    await new Promise((resolve, reject) => {
      const expire = setTimeout(() => reject(new Error(`Indexer never entered its lock: ${output}`)), 12000)
      daemon.stderr.setEncoding('utf8')
      daemon.stderr.on('data', (chunk) => {
        output += chunk
        const match = output.match(/INDEX_WRITER=(\d+)\n/)
        if (!match) return
        writerPid = Number(match[1])
        clearTimeout(expire)
        resolve()
      })
      exited.then(([code, signal]) => {
        clearTimeout(expire)
        reject(new Error(`Indexer exited (${code}, ${signal}): ${output}`))
      }, reject)
    })
    expect(execFileSync('ps', ['-p', String(writerPid), '-o', 'stat='], { encoding: 'utf8' }).trim()).toMatch(/^T/)

    const reply = await requestWriteViaBridge({
      socketPath: defaultSocketPath(home),
      tool: 'mail_send',
      args: { dry_run: true, to: ['fixture@example.invalid'], subject: 'Fixture', body: 'No send' },
      timeoutMs: 1200
    })
    expect(reply, output).toMatchObject({ delivered: true, error: null, response: { planned: true } })
    expect(writerPid).not.toBe(daemon.pid)
    expect(fs.readFileSync(lockFile, 'utf8')).toMatch(new RegExp(`^${writerPid}:`))

    daemon.kill('SIGTERM')
    expect(await exited).toEqual([0, null])
    expect(() => process.kill(writerPid, 0)).toThrow(/ESRCH/)
    writerPid = undefined
    expect(fs.existsSync(defaultSocketPath(home))).toBe(false)
  } finally {
    if (writerPid) {
      try { process.kill(writerPid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL')
    await exited.catch(() => {})
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 22000)

function waitForLine (child, pattern, label, timeoutMs = 15000) {
  let output = ''
  return new Promise((resolve, reject) => {
    const expire = setTimeout(() => reject(new Error(`${label}: no ${pattern} in ${output}`)), timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      output += chunk
      const match = output.match(pattern)
      if (!match) return
      clearTimeout(expire)
      resolve({ match, output: () => output })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(expire)
      reject(new Error(`${label} exited (${code}, ${signal}): ${output}`))
    })
  })
}

it('a restarted daemon reaps a blocked worker its killed parent left holding the lock', async () => {
  const home = fs.mkdtempSync('/tmp/atm-orphan-')
  const lockFile = path.join(home, '.apple-tools-mcp', 'indexer.lock')
  const preload = (name, stop) => {
    const file = path.join(home, name)
    fs.writeFileSync(file, `
      import fs from 'node:fs';
      const write = fs.writeFileSync;
      fs.writeFileSync = (file, value, options) => {
        const result = write(file, value, options);
        if (file === ${JSON.stringify(lockFile)} && options?.flag === 'wx') {
          fs.writeSync(2, 'INDEX_WRITER=' + process.pid + '\\n');
          ${stop}
        }
        return result;
      };
    `)
    return file
  }
  // First worker: event loop blocked for good, so neither its TERM handler
  // nor the IPC disconnect can ever run. Second worker: stopped once it holds
  // the lock, so the test proves the takeover without indexing anything.
  const blocked = preload('block-worker.mjs', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);')
  const stopped = preload('stop-worker.mjs', "process.kill(process.pid, 'SIGSTOP');")
  const env = {
    ...process.env,
    HOME: home,
    APPLE_TOOLS_INDEX_DIR: path.join(home, 'index'),
    APPLE_TOOLS_META_FILE: path.join(home, 'index-meta.json'),
    APPLE_TOOLS_EVENTKIT_SESSION: '0'
  }
  const start = (file) => spawn(process.execPath, ['--import', file, entry], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  const pids = []
  let second
  try {
    const first = start(blocked)
    const firstWorker = Number((await waitForLine(first, /INDEX_WRITER=(\d+)\n/, 'first daemon')).match[1])
    pids.push(firstWorker)
    const firstExit = once(first, 'exit')
    first.kill('SIGKILL')
    await firstExit
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(execFileSync('ps', ['-o', 'ppid=', '-p', String(firstWorker)], { encoding: 'utf8' }).trim()).toBe('1')
    expect(fs.readFileSync(lockFile, 'utf8')).toMatch(new RegExp(`^${firstWorker}:`))

    second = start(stopped)
    const secondExit = once(second, 'exit')
    const took = await waitForLine(second, /INDEX_WRITER=(\d+)\n/, 'second daemon', 25000)
    const secondWorker = Number(took.match[1])
    pids.push(secondWorker)
    expect(took.output()).toContain(`orphaned index worker PID ${firstWorker}`)
    expect(() => process.kill(firstWorker, 0)).toThrow(/ESRCH/)
    expect(secondWorker).not.toBe(firstWorker)
    expect(fs.readFileSync(lockFile, 'utf8')).toMatch(new RegExp(`^${secondWorker}:`))

    const reply = await requestWriteViaBridge({
      socketPath: defaultSocketPath(home),
      tool: 'mail_send',
      args: { dry_run: true, to: ['fixture@example.invalid'], subject: 'Fixture', body: 'No send' },
      timeoutMs: 1200
    })
    expect(reply, took.output()).toMatchObject({ delivered: true, error: null, response: { planned: true } })

    second.kill('SIGTERM')
    expect(await secondExit).toEqual([0, null])
    expect(() => process.kill(secondWorker, 0)).toThrow(/ESRCH/)
  } finally {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    if (second && second.exitCode === null && second.signalCode === null) second.kill('SIGKILL')
    fs.rmSync(home, { recursive: true, force: true })
  }
}, 45000)
