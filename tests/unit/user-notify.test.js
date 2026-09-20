import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  isUserNotifyEnabled,
  buildUserNotifyScript,
  postUserNotification,
  maybeNotifyIndexerRunning,
  INDEXER_RUNNING_MESSAGE
} from '../../lib/userNotify.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('indexer Notification Center policy', () => {
  it('is quiet by default for LaunchAgent / indexer argv', () => {
    expect(isUserNotifyEnabled({ env: {}, argv: ['node', 'index.js', '--mode=indexer'] })).toBe(false)
    expect(isUserNotifyEnabled({ env: { APPLE_TOOLS_NOTIFY: '0' }, argv: ['--notify'] })).toBe(false)
  })

  it('opts in only via APPLE_TOOLS_NOTIFY=1 or --notify', () => {
    expect(isUserNotifyEnabled({ env: { APPLE_TOOLS_NOTIFY: '1' }, argv: [] })).toBe(true)
    expect(isUserNotifyEnabled({ env: {}, argv: ['node', 'index.js', '--mode=indexer', '--notify'] })).toBe(true)
  })

  it('builds a display-notification script and does not post when quiet', () => {
    const script = buildUserNotifyScript('Apple Tools MCP', INDEXER_RUNNING_MESSAGE)
    expect(script).toContain('display notification')
    expect(script).toContain(INDEXER_RUNNING_MESSAGE)

    const run = () => {
      throw new Error('osascript must not run in quiet mode')
    }
    expect(postUserNotification('Apple Tools MCP', INDEXER_RUNNING_MESSAGE, {
      env: {},
      argv: ['node', 'index.js', '--mode=indexer'],
      run
    })).toEqual({ posted: false, reason: 'quiet' })
    expect(maybeNotifyIndexerRunning({
      version: '2.0.2',
      env: {},
      argv: ['node', 'index.js', '--mode=indexer'],
      run
    }).posted).toBe(false)
  })

  it('posts only when opted in', () => {
    const calls = []
    const run = (script) => {
      calls.push(script)
      return { ok: true }
    }
    const result = maybeNotifyIndexerRunning({
      version: '2.0.2',
      env: { APPLE_TOOLS_NOTIFY: '1' },
      argv: ['node', 'index.js', '--mode=indexer'],
      run
    })
    expect(result).toEqual({ posted: true, reason: 'opt-in' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('display notification')
    expect(calls[0]).toContain('indexer is running (v2.0.2)')
  })
})

describe('permissions UX stays separate from indexer toasts', () => {
  it('permissions command does not import or post Notification Center toasts', () => {
    const permSrc = fs.readFileSync(path.join(root, 'lib/permissions.js'), 'utf8')
    const indexSrc = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')

    expect(permSrc).not.toContain('userNotify')
    expect(permSrc).not.toContain('display notification')
    expect(permSrc).not.toContain('maybeNotifyIndexerRunning')

    expect(indexSrc).toContain('maybeNotifyIndexerRunning')
    expect(indexSrc).toContain('APPLE_TOOLS_NOTIFY')
    expect(indexSrc).not.toMatch(/display notification/)

    expect(readme).toContain('quiet by default')
    expect(readme).toContain('APPLE_TOOLS_NOTIFY=1')
    expect(readme).toContain('<string>Background</string>')
  })
})
