import { describe, it, expect, vi } from 'vitest'
import { loadOrCreateHttpAuthToken, acceptedHttpAuthTokens, verifyAuthHeader, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from '../../lib/httpAuth.js'

describe('loadOrCreateHttpAuthToken', () => {
  it('returns the existing token from Keychain without generating a new one', () => {
    const execFileSync = vi.fn(() => Buffer.from('existing-token-value\n'))
    const log = vi.fn()
    const result = loadOrCreateHttpAuthToken({ execFileSync, log })

    expect(result).toEqual({ token: 'existing-token-value', generated: false })
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      expect.any(Object)
    )
    expect(log).not.toHaveBeenCalled()
  })

  it('generates and stores a new token when Keychain read fails (item not found)', () => {
    let call = 0
    const execFileSync = vi.fn(() => {
      call += 1
      if (call === 1) {
        throw new Error('security: item not found')
      }
      return Buffer.from('')
    })
    const log = vi.fn()
    const randomBytes = () => Buffer.from('0'.repeat(64), 'hex')

    const result = loadOrCreateHttpAuthToken({ execFileSync, log, randomBytes })

    expect(result.generated).toBe(true)
    expect(result.token).toBe('0'.repeat(64))
    const writes = execFileSync.mock.calls.filter(([, , options]) => options?.input?.includes(result.token))
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toEqual(['-i'])
    expect(JSON.stringify(writes[0][1])).not.toContain(result.token)
    // Generation guidance must keep the token out of logs.
    expect(log.mock.calls.some(([msg]) => msg.includes(result.token))).toBe(false)
  })

  it('generates a new token when forceNew is set even if one already exists', () => {
    const execFileSync = vi.fn(() => Buffer.from('should-not-be-read'))
    const randomBytes = () => Buffer.from('1'.repeat(64), 'hex')

    const result = loadOrCreateHttpAuthToken({ execFileSync, forceNew: true, randomBytes, log: () => {} })

    expect(result.generated).toBe(true)
    expect(result.token).toBe('1'.repeat(64))
    // Force-new skips credential reads; compilation and the stdin write remain.
    expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'find-generic-password')).toBe(false)
    expect(execFileSync.mock.calls.filter(([, , options]) => options?.input?.includes(result.token))).toHaveLength(1)
  })

  it('treats an empty Keychain read as not-found', () => {
    const execFileSync = vi.fn(() => Buffer.from('   \n'))
    const randomBytes = () => Buffer.from('2'.repeat(64), 'hex')

    const result = loadOrCreateHttpAuthToken({ execFileSync, randomBytes, log: () => {} })

    expect(result.generated).toBe(true)
    expect(result.token).toBe('2'.repeat(64))
  })
})

describe('verifyAuthHeader', () => {
  const token = 'abc123def456'

  it('accepts a matching bearer token', () => {
    expect(verifyAuthHeader(`Bearer ${token}`, token)).toBe(true)
  })

  it('is case-insensitive on the "Bearer" scheme', () => {
    expect(verifyAuthHeader(`bearer ${token}`, token)).toBe(true)
  })

  it('rejects a missing header', () => {
    expect(verifyAuthHeader(undefined, token)).toBe(false)
    expect(verifyAuthHeader(null, token)).toBe(false)
  })

  it('rejects a non-Bearer scheme', () => {
    expect(verifyAuthHeader(`Basic ${token}`, token)).toBe(false)
  })

  it('rejects a wrong token', () => {
    expect(verifyAuthHeader('Bearer wrong-token', token)).toBe(false)
  })

  it('rejects a token of a different length without throwing', () => {
    expect(verifyAuthHeader('Bearer short', token)).toBe(false)
    expect(verifyAuthHeader(`Bearer ${token}-extra-long-suffix`, token)).toBe(false)
  })

  it('rejects malformed header values without throwing', () => {
    expect(verifyAuthHeader('', token)).toBe(false)
    expect(verifyAuthHeader('Bearer', token)).toBe(false)
    expect(verifyAuthHeader(123, token)).toBe(false)
  })
})

// Infisical pilot (R100; Peter: start the Infisical migration, about 8:50 AM CT Nov 11 2026; Toolbox board job
// mcp:9ac156f9-5029-473b-8a4f-7aa4dee11333): under `infisical run` the server takes its token from the environment,
// never touching Keychain, and during a rotation also accepts the previous token until clients have switched.
// Token values here are fake fixtures built at run time.
describe('HTTP auth token from the environment (infisical run)', () => {
  const fake = (digit) => String(digit).repeat(64)

  it('prefers APPLE_TOOLS_HTTP_TOKEN and neither reads nor writes Keychain', () => {
    const execFileSync = vi.fn(() => Buffer.from('keychain-token'))
    const log = vi.fn()
    const result = loadOrCreateHttpAuthToken({ execFileSync, log, env: { APPLE_TOOLS_HTTP_TOKEN: ` ${fake(3)}\n` } })
    expect(result).toEqual({ token: fake(3), generated: false })
    expect(execFileSync).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('falls back to Keychain when the variable is unset or blank', () => {
    const execFileSync = vi.fn(() => Buffer.from('keychain-token\n'))
    expect(loadOrCreateHttpAuthToken({ execFileSync, env: { APPLE_TOOLS_HTTP_TOKEN: '  ' } }).token).toBe('keychain-token')
    expect(loadOrCreateHttpAuthToken({ execFileSync, env: {} }).token).toBe('keychain-token')
  })

  it('accepts the previous token only while APPLE_TOOLS_HTTP_TOKEN_PREVIOUS is set, next to the current one', () => {
    const env = { APPLE_TOOLS_HTTP_TOKEN: fake(4), APPLE_TOOLS_HTTP_TOKEN_PREVIOUS: fake(5) }
    expect(acceptedHttpAuthTokens(fake(4), env)).toEqual([fake(4), fake(5)])
    expect(acceptedHttpAuthTokens(fake(4), { APPLE_TOOLS_HTTP_TOKEN: fake(4) })).toEqual([fake(4)])
    expect(acceptedHttpAuthTokens(fake(4), { APPLE_TOOLS_HTTP_TOKEN: fake(4), APPLE_TOOLS_HTTP_TOKEN_PREVIOUS: fake(4) })).toEqual([fake(4)])
    // The previous token is a rotation overlap for the env token only; a Keychain-run server never takes it.
    expect(acceptedHttpAuthTokens(fake(4), { APPLE_TOOLS_HTTP_TOKEN_PREVIOUS: fake(5) })).toEqual([fake(4)])
    const accepted = acceptedHttpAuthTokens(fake(4), env)
    expect(verifyAuthHeader(`Bearer ${fake(4)}`, accepted)).toBe(true)
    expect(verifyAuthHeader(`Bearer ${fake(5)}`, accepted)).toBe(true)
    expect(verifyAuthHeader(`Bearer ${fake(6)}`, accepted)).toBe(false)
    expect(verifyAuthHeader(`Bearer ${fake(5)}`, [fake(4)])).toBe(false)
    expect(verifyAuthHeader(`Bearer ${fake(4)}`, [])).toBe(false)
  })
})
