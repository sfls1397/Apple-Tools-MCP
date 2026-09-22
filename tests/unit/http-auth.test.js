import { describe, it, expect, vi } from 'vitest'
import { loadOrCreateHttpAuthToken, verifyAuthHeader, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } from '../../lib/httpAuth.js'

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
    expect(execFileSync).toHaveBeenCalledTimes(2)
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/security',
      ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', result.token, '-U'],
      expect.any(Object)
    )
    // One-time banner goes to the log, and includes the token so it's
    // copyable — but only on generation, never on subsequent loads.
    expect(log.mock.calls.some(([msg]) => msg.includes(result.token))).toBe(true)
  })

  it('generates a new token when forceNew is set even if one already exists', () => {
    const execFileSync = vi.fn(() => Buffer.from('should-not-be-read'))
    const randomBytes = () => Buffer.from('1'.repeat(64), 'hex')

    const result = loadOrCreateHttpAuthToken({ execFileSync, forceNew: true, randomBytes, log: () => {} })

    expect(result.generated).toBe(true)
    expect(result.token).toBe('1'.repeat(64))
    // Only the write call — the read is skipped entirely when forceNew is set.
    expect(execFileSync).toHaveBeenCalledTimes(1)
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
