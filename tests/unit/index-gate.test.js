/**
 * Index-session search gating: lost-lock vs still-indexing vs rebuild failure.
 *
 * Imports the same helpers index.js uses so these tests fail if the gate
 * semantics regress.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { isSearchBlockedByIndexing, cycleEndFlags, indexUnavailableMessage, indexQueryGate, BUILDING_INITIAL_INDEX_MESSAGE, INDEXING_NEW_DATA_MESSAGE } from '../../lib/indexGate.js'

/** Tools PR #1 gated on sessionIndexComplete; lost-lock must not strand them. */
const INDEX_BACKED_TOOLS = [
  'mail_search',
  'mail_recent',
  'mail_date',
  'mail_senders',
  'mail_thread',
  'messages_search',
  'messages_recent',
  'messages_conversation',
  'calendar_search',
  'smart_search',
  'person_search'
]

describe('isSearchBlockedByIndexing', () => {
  it('blocks only while this process owns the lock and has not finished a cycle', () => {
    expect(isSearchBlockedByIndexing(false, true)).toBe(true)
  })

  it('does not block after this process finishes indexing', () => {
    // Progress-timeout path: cycle marked complete while lock is still held.
    expect(isSearchBlockedByIndexing(true, true)).toBe(false)
    expect(isSearchBlockedByIndexing(true, false)).toBe(false)
  })

  it('treats lost lock as distinct from still indexing (A)', () => {
    // Secondary instance: never won the lock, sessionIndexComplete stays false.
    expect(isSearchBlockedByIndexing(false, false)).toBe(false)
  })

  it('allows search once the primary finished even if this process never indexed', () => {
    // Lost lock, then an index exists / primary completed — still no local cycle.
    expect(isSearchBlockedByIndexing(false, false)).toBe(false)
  })
})

describe('multi-instance / lost-lock search gate (A)', () => {
  function toolResponse({ sessionIndexComplete, ownsIndexLock, indexReady }) {
    if (isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)) {
      return 'still indexing'
    }
    if (!indexReady) {
      return 'index not available'
    }
    return 'search results'
  }

  it('primary stays on still-indexing until its first cycle completes', () => {
    const primary = { sessionIndexComplete: false, ownsIndexLock: true, indexReady: false }
    expect(toolResponse(primary)).toBe('still indexing')
    for (const tool of INDEX_BACKED_TOOLS) {
      expect(toolResponse(primary), tool).toBe('still indexing')
    }
  })

  it('secondary that lost the lock is not stuck on still-indexing forever', () => {
    const secondary = { sessionIndexComplete: false, ownsIndexLock: false, indexReady: false }
    // Recoverable "not ready" — not the permanent still-indexing gate.
    expect(toolResponse(secondary)).toBe('index not available')
  })

  it('secondary can search once an index exists, even while primary still holds the lock', () => {
    const secondary = { sessionIndexComplete: false, ownsIndexLock: false, indexReady: true }
    expect(toolResponse(secondary)).toBe('search results')
    for (const tool of INDEX_BACKED_TOOLS) {
      expect(toolResponse(secondary), tool).toBe('search results')
    }
  })

  it('secondary can search after the primary finishes and releases the lock', () => {
    const primaryDone = { sessionIndexComplete: true, ownsIndexLock: false, indexReady: true }
    const secondary = { sessionIndexComplete: false, ownsIndexLock: false, indexReady: true }
    expect(toolResponse(primaryDone)).toBe('search results')
    expect(toolResponse(secondary)).toBe('search results')
  })

  it('does not confuse lock loss with first-run indexing', () => {
    const firstRunPrimary = { sessionIndexComplete: false, ownsIndexLock: true, indexReady: false }
    const lostLockNoIndex = { sessionIndexComplete: false, ownsIndexLock: false, indexReady: false }
    expect(toolResponse(firstRunPrimary)).toBe('still indexing')
    expect(toolResponse(lostLockNoIndex)).not.toBe('still indexing')
  })
})

describe('rebuild_index failure must unblock searches (B)', () => {
  it('cycleEndFlags(false) clears the blocking flags', () => {
    const flags = cycleEndFlags(false)
    expect(flags.indexingInProgress).toBe(false)
    expect(flags.sessionIndexComplete).toBe(true)
    expect(flags.ownsIndexLock).toBe(false)
    expect(flags.isFirstEverRun).toBeUndefined()
    expect(isSearchBlockedByIndexing(flags.sessionIndexComplete, flags.ownsIndexLock)).toBe(false)
  })

  it('cycleEndFlags(true) also unblocks and clears first-run', () => {
    const flags = cycleEndFlags(true)
    expect(flags.indexingInProgress).toBe(false)
    expect(flags.sessionIndexComplete).toBe(true)
    expect(flags.ownsIndexLock).toBe(false)
    expect(flags.isFirstEverRun).toBe(false)
    expect(isSearchBlockedByIndexing(flags.sessionIndexComplete, flags.ownsIndexLock)).toBe(false)
  })

  it('simulates rebuild start then failed catch path', () => {
    let sessionIndexComplete = true
    let indexingInProgress = false
    let ownsIndexLock = true

    // rebuild_index start
    indexingInProgress = true
    sessionIndexComplete = false
    expect(isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)).toBe(true)

    // catch — previously left sessionIndexComplete false forever
    const flags = cycleEndFlags(false)
    indexingInProgress = flags.indexingInProgress
    sessionIndexComplete = flags.sessionIndexComplete
    ownsIndexLock = flags.ownsIndexLock

    expect(indexingInProgress).toBe(false)
    expect(sessionIndexComplete).toBe(true)
    expect(isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)).toBe(false)
  })

  it('success and failure both restore a searchable state', () => {
    const afterFail = cycleEndFlags(false)
    const afterOk = cycleEndFlags(true)
    expect(isSearchBlockedByIndexing(afterFail.sessionIndexComplete, afterFail.ownsIndexLock)).toBe(false)
    expect(isSearchBlockedByIndexing(afterOk.sessionIndexComplete, afterOk.ownsIndexLock)).toBe(false)
  })
})

describe('index.js wiring', () => {
  const indexSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../index.js'),
    'utf8'
  )

  it('does not gate searches on raw sessionIndexComplete (lost-lock safe)', () => {
    expect(indexSrc).toContain('stillIndexingMessage')
    expect(indexSrc).toContain('indexQueryGate')
    expect(indexSrc).toContain('requireIndex')
    expect(indexSrc.match(/if \(!sessionIndexComplete\)/g)).toBeNull()
  })

  it('rebuild catch uses applyCycleEnd so a failed rebuild unblocks searches', () => {
    expect(indexSrc).toContain('applyCycleEnd(true)')
    expect(indexSrc).toContain('applyCycleEnd(false)')
    expect(indexSrc).toMatch(/Index rebuild error:[\s\S]{0,80}applyCycleEnd\(false\)/)
  })

  it('lost-lock startup does not start background indexing', () => {
    expect(indexSrc).toContain('Server will run without background indexing.')
    expect(indexSrc).toMatch(
      /Server will run without background indexing\.[\s\S]{0,400}ownsIndexLock = false[\s\S]{0,80}return;/
    )
  })

  it('advertises package.json version, not a hardcoded literal', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')
    )
    expect(pkg.version).toBe('2.0.6')
    expect(indexSrc).not.toMatch(/version:\s*["']2\.0\.[0-9]["']/)
    expect(indexSrc).toContain('PACKAGE_VERSION')
    expect(indexSrc).toContain('new URL("./package.json", import.meta.url)')
    expect(indexSrc).toContain('version: PACKAGE_VERSION')
    expect(indexSrc).toContain('Apple Tools MCP server running (v${PACKAGE_VERSION})')
  })

  it('rebuild in-progress messages share the same wording', () => {
    expect(indexSrc).toContain(
      'Indexing is already in progress. Please wait for it to complete before starting a rebuild.'
    )
    expect(indexSrc).toContain(
      'Indexing is already in progress in a different session. Please wait for it to complete before starting a rebuild.'
    )
    expect(indexSrc).not.toContain('Another indexing operation is already in progress')
  })
})

describe('indexUnavailableMessage', () => {
  it('uses the same not-available wording for every source', () => {
    expect(indexUnavailableMessage('emails')).toBe('Email index not available. Please try again shortly.')
    expect(indexUnavailableMessage('messages')).toBe('Messages index not available. Please try again shortly.')
    expect(indexUnavailableMessage('calendar')).toBe('Calendar index not available. Please try again shortly.')
    expect(indexUnavailableMessage()).toBe('Index not available. Please try again shortly.')
  })

  it('does not use still-indexing phrasing for a missing index', () => {
    for (const type of ['emails', 'messages', 'calendar', undefined]) {
      const msg = indexUnavailableMessage(type)
      expect(msg).toContain('not available')
      expect(msg).not.toMatch(/not ready/i)
      expect(msg).not.toMatch(/wait for indexing to complete/i)
      expect(msg).not.toMatch(/still indexing/i)
    }
  })
})

describe('indexQueryGate', () => {
  it('lost-lock + ready index is ok even if this process never indexed and isFirstEverRun is stale', () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: false,
      indexReady: true,
      type: 'emails',
      isFirstEverRun: true
    })
    expect(gate.ok).toBe(true)
    expect(gate.message).toBeNull()
  })

  it('does not return building-initial-index for a lost-lock reader', () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: false,
      indexReady: true,
      type: 'emails',
      isFirstEverRun: true
    })
    expect(gate.message).not.toBe(BUILDING_INITIAL_INDEX_MESSAGE)
    expect(gate.message).not.toBe(INDEXING_NEW_DATA_MESSAGE)
    expect(String(gate.message || '')).not.toMatch(/building initial index/i)
  })

  it('refuses a missing index with the unavailable message, not empty results', () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: false,
      indexReady: false,
      type: 'messages'
    })
    expect(gate.ok).toBe(false)
    expect(gate.message).toBe(indexUnavailableMessage('messages'))
  })

  it('owner still blocked until its own cycle finishes', () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: true,
      indexReady: true,
      type: 'emails',
      isFirstEverRun: true
    })
    expect(gate.ok).toBe(false)
    expect(gate.message).toBe(BUILDING_INITIAL_INDEX_MESSAGE)
  })
})

describe('search.js and indexer.js use the shared unavailable message', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const searchSrc = fs.readFileSync(path.join(root, 'search.js'), 'utf8')
  const indexerSrc = fs.readFileSync(path.join(root, 'indexer.js'), 'utf8')

  it('does not leave leftover index-not-ready still-indexing copy', () => {
    expect(searchSrc).not.toMatch(/index not ready/i)
    expect(searchSrc).not.toMatch(/wait for indexing to complete/i)
    expect(indexerSrc).not.toMatch(/Email index not ready/)
    expect(searchSrc).toContain('indexUnavailableMessage')
    expect(indexerSrc).toContain('indexUnavailableMessage')
  })
})
