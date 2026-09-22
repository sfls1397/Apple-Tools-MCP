import { describe, it, expect } from 'vitest'
import {
  parseDuration,
  formatIntervalMs,
  clampIndexInterval,
  loadConfigFile,
  resolveIndexInterval,
  loadResolvedIndexInterval,
  logResolvedInterval,
  resolveHttpServerConfig,
  getAppleToolsDir,
  getConfigPath,
  DEFAULT_INDEX_INTERVAL_MS,
  MIN_INDEX_INTERVAL_MS,
  MAX_INDEX_INTERVAL_MS,
  MINI_RECOMMENDED_INDEX_INTERVAL_MS,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PORT
} from '../../lib/config.js'

describe('parseDuration', () => {
  it('accepts millisecond numbers', () => {
    expect(parseDuration(60000)).toBe(60000)
  })

  it('accepts digit strings as milliseconds', () => {
    expect(parseDuration('60000')).toBe(60000)
  })

  it('accepts human forms', () => {
    expect(parseDuration('30s')).toBe(30 * 1000)
    expect(parseDuration('1m')).toBe(60 * 1000)
    expect(parseDuration('5m')).toBe(5 * 60 * 1000)
    expect(parseDuration('1h')).toBe(60 * 60 * 1000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('1M')).toBe(60 * 1000)
  })

  it('trims whitespace', () => {
    expect(parseDuration('  1m  ')).toBe(60000)
  })

  it('rejects invalid values', () => {
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('nope')).toBeNull()
    expect(parseDuration('1.5m')).toBeNull()
    expect(parseDuration('1 m')).toBeNull()
    expect(parseDuration(NaN)).toBeNull()
    expect(parseDuration(Infinity)).toBeNull()
    expect(parseDuration(null)).toBeNull()
    expect(parseDuration(undefined)).toBeNull()
    expect(parseDuration({})).toBeNull()
  })
})

describe('formatIntervalMs', () => {
  it('uses compact units', () => {
    expect(formatIntervalMs(15000)).toBe('15s')
    expect(formatIntervalMs(60000)).toBe('1m')
    expect(formatIntervalMs(300000)).toBe('5m')
    expect(formatIntervalMs(6 * 60 * 60 * 1000)).toBe('6h')
    expect(formatIntervalMs(1500)).toBe('1500ms')
  })
})

describe('clampIndexInterval', () => {
  it('uses the documented 15s floor and 6h ceiling', () => {
    expect(MIN_INDEX_INTERVAL_MS).toBe(15 * 1000)
    expect(MAX_INDEX_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    expect(DEFAULT_INDEX_INTERVAL_MS).toBe(5 * 60 * 1000)
    expect(MINI_RECOMMENDED_INDEX_INTERVAL_MS).toBe(60 * 1000)
  })

  it('allows 30s (within clamp) and Mini 1m', () => {
    expect(clampIndexInterval('30s')).toMatchObject({ ms: 30000, clamped: false, invalid: false })
    expect(clampIndexInterval('1m')).toMatchObject({ ms: 60000, clamped: false })
  })

  it('clamps below the 15s floor', () => {
    const result = clampIndexInterval('5s')
    expect(result.ms).toBe(MIN_INDEX_INTERVAL_MS)
    expect(result.clamped).toBe(true)
    expect(result.requestedMs).toBe(5000)
  })

  it('clamps above the 6h ceiling', () => {
    const result = clampIndexInterval('10h')
    expect(result.ms).toBe(MAX_INDEX_INTERVAL_MS)
    expect(result.clamped).toBe(true)
  })

  it('falls back to the default for unparseable values', () => {
    const result = clampIndexInterval('banana')
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS)
    expect(result.invalid).toBe(true)
    expect(result.clamped).toBe(false)
  })
})

describe('loadConfigFile', () => {
  it('treats a missing file as empty defaults', () => {
    const result = loadConfigFile({
      configPath: '/tmp/does-not-exist-apple-tools-config.json',
      exists: () => false,
      warn: () => {}
    })
    expect(result.missing).toBe(true)
    expect(result.invalid).toBe(false)
    expect(result.data).toEqual({})
  })

  it('does not throw on invalid JSON', () => {
    const warns = []
    const result = loadConfigFile({
      configPath: '/tmp/config.json',
      exists: () => true,
      readFile: () => '{ not json',
      warn: (msg) => warns.push(msg)
    })
    expect(result.invalid).toBe(true)
    expect(result.data).toEqual({})
    expect(warns[0]).toMatch(/Invalid config\.json/)
  })

  it('rejects arrays and null', () => {
    const warns = []
    const result = loadConfigFile({
      configPath: '/tmp/config.json',
      exists: () => true,
      readFile: () => '[]',
      warn: (msg) => warns.push(msg)
    })
    expect(result.invalid).toBe(true)
    expect(warns[0]).toMatch(/expected a JSON object/)
  })

  it('warns and ignores unknown keys', () => {
    const warns = []
    const result = loadConfigFile({
      configPath: '/tmp/config.json',
      exists: () => true,
      readFile: () => JSON.stringify({ indexInterval: '1m', extra: true, configPath: '/etc/passwd' }),
      warn: (msg) => warns.push(msg)
    })
    expect(result.invalid).toBe(false)
    expect(result.data.indexInterval).toBe('1m')
    expect(warns.some((w) => w.includes('extra'))).toBe(true)
    expect(warns.some((w) => w.includes('configPath'))).toBe(true)
  })
})

describe('config path stays under ~/.apple-tools-mcp/', () => {
  it('does not follow a path from config contents', () => {
    const dir = getAppleToolsDir({ env: { HOME: '/Users/example' } })
    const configPath = getConfigPath({ env: { HOME: '/Users/example' } })
    expect(dir).toBe('/Users/example/.apple-tools-mcp')
    expect(configPath).toBe('/Users/example/.apple-tools-mcp/config.json')
    expect(configPath.startsWith(dir)).toBe(true)
  })
})

describe('resolveIndexInterval precedence', () => {
  it('uses the 5-minute product default when nothing is set', () => {
    const result = resolveIndexInterval({ env: {}, fileData: {}, warn: () => {} })
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS)
    expect(result.source).toBe('default')
    expect(result.human).toBe('5m')
  })

  it('reads indexInterval from config when env is unset', () => {
    const result = resolveIndexInterval({
      env: {},
      fileData: { indexInterval: '1m' },
      warn: () => {}
    })
    expect(result.ms).toBe(60000)
    expect(result.source).toBe('config')
    expect(result.human).toBe('1m')
  })

  it('reads indexIntervalMs when indexInterval is absent', () => {
    const result = resolveIndexInterval({
      env: {},
      fileData: { indexIntervalMs: 120000 },
      warn: () => {}
    })
    expect(result.ms).toBe(120000)
    expect(result.source).toBe('config')
  })

  it('lets INDEX_INTERVAL_MS override the config file', () => {
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: '30s' },
      fileData: { indexInterval: '1m' },
      warn: () => {}
    })
    expect(result.ms).toBe(30000)
    expect(result.source).toBe('env')
  })

  it('treats empty INDEX_INTERVAL_MS as unset so config applies', () => {
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: '' },
      fileData: { indexInterval: '1m' },
      warn: () => {}
    })
    expect(result.ms).toBe(60000)
    expect(result.source).toBe('config')
  })

  it('warns when clamping an env value', () => {
    const warns = []
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: '5s' },
      fileData: {},
      warn: (msg) => warns.push(msg)
    })
    expect(result.ms).toBe(MIN_INDEX_INTERVAL_MS)
    expect(result.clamped).toBe(true)
    expect(result.source).toBe('env')
    expect(warns[0]).toMatch(/clamped to 15s/)
  })

  it('does not crash on invalid env; falls back to default', () => {
    const warns = []
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: 'nope' },
      fileData: { indexInterval: '1m' },
      warn: (msg) => warns.push(msg)
    })
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS)
    expect(result.invalid).toBe(true)
    expect(warns[0]).toMatch(/Invalid index interval/)
  })
})

describe('loadResolvedIndexInterval', () => {
  it('composes file load + resolve without throwing', () => {
    const result = loadResolvedIndexInterval({
      env: {},
      configPath: '/tmp/does-not-exist-apple-tools-config.json',
      warn: () => {}
    })
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS)
    expect(result.source).toBe('default')
  })
})

describe('logResolvedInterval', () => {
  it('logs human form and milliseconds', () => {
    const lines = []
    logResolvedInterval(
      { ms: 60000, human: '1m', source: 'config', clamped: false },
      { log: (msg) => lines.push(msg) }
    )
    expect(lines[0]).toBe('Effective index refresh interval: 1m (60000 ms) [source=config]')
  })

  it('notes when the value was clamped', () => {
    const lines = []
    logResolvedInterval(
      { ms: 15000, human: '15s', source: 'env', clamped: true },
      { log: (msg) => lines.push(msg) }
    )
    expect(lines[0]).toContain('source=env, clamped')
  })
})

describe('resolveHttpServerConfig precedence', () => {
  it('uses product defaults when nothing is set', () => {
    const result = resolveHttpServerConfig({ env: {}, fileData: {}, warn: () => {} })
    expect(result.host).toBe(DEFAULT_HTTP_HOST)
    expect(result.port).toBe(DEFAULT_HTTP_PORT)
  })

  it('reads httpHost and httpPort from config when env is unset', () => {
    const result = resolveHttpServerConfig({
      env: {},
      fileData: { httpHost: '127.0.0.1', httpPort: 9000 },
      warn: () => {}
    })
    expect(result.host).toBe('127.0.0.1')
    expect(result.port).toBe(9000)
  })

  it('lets env vars override the config file', () => {
    const result = resolveHttpServerConfig({
      env: { APPLE_TOOLS_HTTP_HOST: '10.0.0.5', APPLE_TOOLS_HTTP_PORT: '9999' },
      fileData: { httpHost: '127.0.0.1', httpPort: 9000 },
      warn: () => {}
    })
    expect(result.host).toBe('10.0.0.5')
    expect(result.port).toBe(9999)
  })

  it('falls back to the default port for an invalid value instead of throwing', () => {
    const result = resolveHttpServerConfig({
      env: {},
      fileData: { httpPort: 'not-a-port' },
      warn: () => {}
    })
    expect(result.port).toBe(DEFAULT_HTTP_PORT)
  })

  it('rejects out-of-range ports', () => {
    const result = resolveHttpServerConfig({
      env: {},
      fileData: { httpPort: 70000 },
      warn: () => {}
    })
    expect(result.port).toBe(DEFAULT_HTTP_PORT)
  })
})
