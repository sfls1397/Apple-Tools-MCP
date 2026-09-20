import { describe, it, expect } from 'vitest'
import { isIndexerMode, isPermissionsMode } from '../../lib/processMode.js'

describe('isPermissionsMode', () => {
  it('detects the permissions subcommand on the package bin', () => {
    expect(isPermissionsMode(['node', '/usr/local/bin/apple-tools-mcp', 'permissions'])).toBe(true)
    expect(isPermissionsMode(['node', '/path/to/index.js', 'permissions'])).toBe(true)
    expect(isPermissionsMode(['node', '/path/to/index.js', '--mode=permissions'])).toBe(true)
    expect(isPermissionsMode(['node', '/path/to/index.js', '--mode', 'permissions'])).toBe(true)
  })

  it('is false for MCP stdio and indexer argv', () => {
    expect(isPermissionsMode(['node', '/usr/local/bin/apple-tools-mcp'])).toBe(false)
    expect(isPermissionsMode(['node', '/path/to/index.js', '--mode=indexer'])).toBe(false)
    expect(isPermissionsMode([])).toBe(false)
  })

  it('wins over indexer mode so the same bin can run the CLI', () => {
    expect(isPermissionsMode(['node', '/usr/local/bin/apple-tools-indexer', 'permissions'])).toBe(true)
    expect(isIndexerMode(['node', '/usr/local/bin/apple-tools-indexer', 'permissions'])).toBe(false)
  })
})

describe('isIndexerMode', () => {
  it('is false for default MCP stdio argv', () => {
    expect(isIndexerMode(['node', '/usr/local/bin/apple-tools-mcp'])).toBe(false)
    expect(isIndexerMode(['node', '/path/to/index.js'])).toBe(false)
  })

  it('detects --mode=indexer', () => {
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode=indexer'])).toBe(true)
  })

  it('detects --mode indexer', () => {
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode', 'indexer'])).toBe(true)
  })

  it('detects the apple-tools-indexer bin name', () => {
    expect(isIndexerMode(['node', '/usr/local/bin/apple-tools-indexer'])).toBe(true)
    expect(isIndexerMode(['node', '/opt/homebrew/bin/apple-tools-indexer'])).toBe(true)
  })

  it('does not treat unrelated --mode values as indexer', () => {
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode=mcp'])).toBe(false)
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode', 'stdio'])).toBe(false)
  })

  it('handles empty argv', () => {
    expect(isIndexerMode([])).toBe(false)
  })
})
