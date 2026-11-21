
import { describe, it, expect } from 'vitest'
import { isOrphanedIndexWorker, readProcessInfo, reapOrphanedIndexWorker } from '../../lib/orphanWorker.js'

const UID = 501
const WORKER_ARGS = '/opt/node/bin/node /opt/lib/node_modules/apple-tools-mcp/index.js --mode=indexer --indexer-worker'

function fakeHost ({ holder, info, diesOn = 'SIGTERM' }) {
  const signals = []
  let alive = true
  return {
    signals,
    opts: {
      lockFile: '/nonexistent/indexer.lock',
      ownPid: 100,
      ownUid: UID,
      readHolder: () => holder,
      readInfo: () => (alive ? info : null),
      kill: (pid, signal) => {
        signals.push([pid, signal])
        if (signal === diesOn || signal === 'SIGKILL') alive = false
      },
      isAlive: () => alive,
      sleep: async () => {},
      graceMs: 300
    }
  }
}

describe('isOrphanedIndexWorker', () => {
  it('needs PPID 1, the same user and both worker flags', () => {
    expect(isOrphanedIndexWorker({ ppid: 1, uid: UID, args: WORKER_ARGS }, UID)).toBe(true)
    expect(isOrphanedIndexWorker({ ppid: 2505, uid: UID, args: WORKER_ARGS }, UID)).toBe(false)
    expect(isOrphanedIndexWorker({ ppid: 1, uid: 0, args: WORKER_ARGS }, UID)).toBe(false)
    expect(isOrphanedIndexWorker({ ppid: 1, uid: UID, args: '/opt/node/bin/node index.js --mode=indexer' }, UID)).toBe(false)
    expect(isOrphanedIndexWorker({ ppid: 1, uid: UID, args: 'node apple-tools-mcp/index.js' }, UID)).toBe(false)
    expect(isOrphanedIndexWorker({ ppid: 1, uid: UID, args: 'node x.js --indexer-workers --mode=indexer' }, UID)).toBe(false)
    expect(isOrphanedIndexWorker(null, UID)).toBe(false)
  })
})

describe('readProcessInfo', () => {
  it('parses ps output and reads this process', () => {
    const exec = () => '    1   501 /opt/node/bin/node index.js --mode=indexer --indexer-worker\n'
    expect(readProcessInfo(42, exec)).toEqual({ ppid: 1, uid: 501, args: '/opt/node/bin/node index.js --mode=indexer --indexer-worker' })
    expect(readProcessInfo(42, () => { throw new Error('exit 1') })).toBe(null)
    expect(readProcessInfo(42, () => '')).toBe(null)
    const self = readProcessInfo(process.pid)
    expect(self.ppid).toBe(process.ppid)
    expect(self.uid).toBe(process.getuid())
  })
})

describe('reapOrphanedIndexWorker', () => {
  it('stops an orphaned worker holding the lock with TERM when it answers', async () => {
    const host = fakeHost({ holder: { state: 'stuck', pid: 4658 }, info: { ppid: 1, uid: UID, args: WORKER_ARGS } })
    expect(await reapOrphanedIndexWorker(host.opts)).toEqual({ reaped: true, pid: 4658, signal: 'SIGTERM' })
    expect(host.signals).toEqual([[4658, 'SIGTERM']])
  })

  it('kills a blocked orphan after the grace period', async () => {
    const host = fakeHost({ holder: { state: 'running', pid: 4658 }, info: { ppid: 1, uid: UID, args: WORKER_ARGS }, diesOn: 'never' })
    expect(await reapOrphanedIndexWorker(host.opts)).toEqual({ reaped: true, pid: 4658, signal: 'SIGKILL' })
    expect(host.signals).toEqual([[4658, 'SIGTERM'], [4658, 'SIGKILL']])
  })

  it('never kills when the PID stops being an orphaned worker during the grace period', async () => {
    const host = fakeHost({ holder: { state: 'running', pid: 4658 }, info: { ppid: 1, uid: UID, args: WORKER_ARGS }, diesOn: 'never' })
    let reads = 0
    host.opts.readInfo = () => (++reads === 1 ? { ppid: 1, uid: UID, args: WORKER_ARGS } : { ppid: 900, uid: UID, args: 'node other.js' })
    expect(await reapOrphanedIndexWorker(host.opts)).toEqual({ reaped: false, pid: 4658 })
    expect(host.signals).toEqual([[4658, 'SIGTERM']])
  })

  it.each([
    ['no lock file', null, null],
    ['a dead holder', { state: 'dead', pid: 4658 }, { ppid: 1, uid: UID, args: WORKER_ARGS }],
    ['this process', { state: 'running', pid: 100 }, { ppid: 1, uid: UID, args: WORKER_ARGS }],
    ['a live daemon\'s worker', { state: 'running', pid: 4658 }, { ppid: 2505, uid: UID, args: WORKER_ARGS }],
    ['a stdio MCP client that won the lock', { state: 'stuck', pid: 4658 }, { ppid: 1, uid: UID, args: '/opt/node/bin/node /opt/apple-tools-mcp/index.js' }],
    ['another user\'s process', { state: 'stuck', pid: 4658 }, { ppid: 1, uid: 0, args: WORKER_ARGS }],
    ['an unreadable process', { state: 'stuck', pid: 4658 }, null]
  ])('leaves %s alone', async (_, holder, info) => {
    const host = fakeHost({ holder, info })
    const result = await reapOrphanedIndexWorker(host.opts)
    expect(result.reaped).toBe(false)
    expect(host.signals).toEqual([])
  })

  it('treats an unreadable lock as nothing to do', async () => {
    const host = fakeHost({ holder: null, info: null })
    host.opts.readHolder = () => { throw new Error('EACCES') }
    expect(await reapOrphanedIndexWorker(host.opts)).toEqual({ reaped: false })
    expect(host.signals).toEqual([])
  })
})
