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
