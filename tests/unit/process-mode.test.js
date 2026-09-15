import { describe, it, expect } from 'vitest'
import { isIndexerMode } from '../../lib/processMode.js'

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
