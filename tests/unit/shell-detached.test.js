/**
 * safeSpawnDetached must return at once and leave the child running for its
 * own lifetime — the 3.0.3 wake used a blocking spawn whose 5s timeout killed
 * `caffeinate -t 15` about 4s in.
 */

import { describe, it, expect } from 'vitest'
import { safeSpawnDetached } from '../../lib/shell.js'

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('safeSpawnDetached', () => {
  it('returns immediately and the child outlives the call', () => {
    const started = Date.now()
    const pid = safeSpawnDetached('/bin/sleep', ['5'])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    process.kill(pid, 'SIGTERM')
  })

  it('validates its arguments', () => {
    expect(() => safeSpawnDetached('')).toThrow('Command is required')
    expect(() => safeSpawnDetached('/bin/echo', 'x')).toThrow('Args must be an array')
  })
})
