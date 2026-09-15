/**
 * Config path must stay under ~/.apple-tools-mcp/. Contents are data, not
 * instructions or alternate filesystem roots.
 */

import { describe, it, expect } from 'vitest'
import { getAppleToolsDir, getConfigPath, loadConfigFile } from '../../../lib/config.js'

describe('config.json path confinement', () => {
  it('resolves config.json only under the home apple-tools directory', () => {
    const home = '/Users/example'
    const dir = getAppleToolsDir({ env: { HOME: home } })
    const configPath = getConfigPath({ env: { HOME: home } })
    expect(dir).toBe('/Users/example/.apple-tools-mcp')
    expect(configPath).toBe('/Users/example/.apple-tools-mcp/config.json')
  })

  it('ignores a configPath key inside the file instead of following it', () => {
    const warns = []
    const result = loadConfigFile({
      configPath: '/Users/example/.apple-tools-mcp/config.json',
      exists: () => true,
      readFile: () => JSON.stringify({
        indexInterval: '1m',
        configPath: '/etc/passwd'
      }),
      warn: (msg) => warns.push(msg)
    })
    expect(result.path).toBe('/Users/example/.apple-tools-mcp/config.json')
    expect(result.path).not.toContain('/etc/passwd')
    expect(warns.some((w) => w.includes('configPath'))).toBe(true)
  })
})
