import { describe, it, expect } from 'vitest'
import { isIndexerMode, isPermissionsMode, isHttpMode, isHttpTokenMode } from '../../lib/processMode.js'

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
    expect(isIndexerMode(['node', '/opt/homebrew/lib/node_modules/apple-tools-mcp/bin/apple-tools-indexer.js'])).toBe(true)
  })

  it('does not treat unrelated --mode values as indexer', () => {
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode=mcp'])).toBe(false)
    expect(isIndexerMode(['node', '/path/to/index.js', '--mode', 'stdio'])).toBe(false)
  })

  it('handles empty argv', () => {
    expect(isIndexerMode([])).toBe(false)
  })
})

describe('isHttpMode', () => {
  it('is false for default MCP stdio, indexer, and permissions argv', () => {
    expect(isHttpMode(['node', '/usr/local/bin/apple-tools-mcp'])).toBe(false)
    expect(isHttpMode(['node', '/path/to/index.js', '--mode=indexer'])).toBe(false)
    expect(isHttpMode(['node', '/path/to/index.js', 'permissions'])).toBe(false)
    expect(isHttpMode([])).toBe(false)
  })

  it('detects --transport=http', () => {
    expect(isHttpMode(['node', '/path/to/index.js', '--transport=http'])).toBe(true)
  })

  it('detects --transport http', () => {
    expect(isHttpMode(['node', '/path/to/index.js', '--transport', 'http'])).toBe(true)
  })

  it('detects --mode=http', () => {
    expect(isHttpMode(['node', '/path/to/index.js', '--mode=http'])).toBe(true)
  })

  it('detects the apple-tools-http bin name', () => {
    expect(isHttpMode(['node', '/usr/local/bin/apple-tools-http'])).toBe(true)
    expect(isHttpMode(['node', '/opt/homebrew/lib/node_modules/apple-tools-mcp/bin/apple-tools-http.js'])).toBe(true)
  })

  it('permissions and http-token win over http mode on the same bin', () => {
    expect(isHttpMode(['node', '/usr/local/bin/apple-tools-http', 'permissions'])).toBe(false)
    expect(isHttpMode(['node', '/usr/local/bin/apple-tools-http', 'http-token'])).toBe(false)
  })
})

describe('isHttpTokenMode', () => {
  it('detects the http-token subcommand', () => {
    expect(isHttpTokenMode(['node', '/usr/local/bin/apple-tools-mcp', 'http-token'])).toBe(true)
    expect(isHttpTokenMode(['node', '/path/to/index.js', '--mode=http-token'])).toBe(true)
  })

  it('is false for other argv', () => {
    expect(isHttpTokenMode(['node', '/usr/local/bin/apple-tools-mcp'])).toBe(false)
    expect(isHttpTokenMode(['node', '/path/to/index.js', '--transport=http'])).toBe(false)
    expect(isHttpTokenMode([])).toBe(false)
  })
})
