/**
 * Unit tests for Messages contact matching and from-me peer naming.
 *
 * Contacts lookups are injected fakes (555 numbers), so these need no
 * AddressBook and no chat.db.
 */

import { describe, it, expect } from 'vitest'
import { createMessageContactMatcher, describeMessagePeer } from '../../lib/messageContact.js'
import { normalizePhone } from '../../contacts.js'

const DAD = {
  displayName: 'Dad',
  phones: [{ phone: '(555) 010-2000', normalized: '5550102000' }],
  emails: [{ email: 'Dad@Example.com' }]
}
const ALEX = {
  displayName: 'Alex Rivera',
  phones: [{ phone: '+1 555 010 3000', normalized: '5550103000' }],
  emails: []
}

const byName = { dad: [DAD], 'alex rivera': [ALEX], alex: [ALEX] }
const deps = {
  resolveExactName: (name) => byName[name] || [],
  normalizePhone
}

const dadIn = { sender: '+15550102000', chatIdentifier: '+15550102000', isGroupChat: false }
const dadReply = { sender: 'Me', chatIdentifier: '+15550102000', isGroupChat: false }
const dadEmailIn = { sender: 'dad@example.com', chatIdentifier: 'dad@example.com', isGroupChat: false }
const otherReply = { sender: 'Me', chatIdentifier: '+15550109999', isGroupChat: false }
const groupFromDad = { sender: '+15550102000', chatIdentifier: 'chat123', chatName: 'Family', isGroupChat: true }
const groupFromMe = { sender: 'Me', chatIdentifier: 'chat123', chatName: 'Family', isGroupChat: true }

describe('createMessageContactMatcher', () => {
  it('matches a contact name to its incoming messages and my 1:1 replies', () => {
    const m = createMessageContactMatcher('Dad', deps)
    expect(m.isName).toBe(true)
    expect(m.resolvedCount).toBe(1)
    expect(m.matches(dadIn)).toBe(true)
    expect(m.matches(dadReply)).toBe(true)
    expect(m.matches(dadEmailIn)).toBe(true)
    expect(m.matches(otherReply)).toBe(false)
  })

  it('is case-insensitive on names', () => {
    expect(createMessageContactMatcher('  DAD ', deps).matches(dadReply)).toBe(true)
  })

  it('matches their messages in a group chat but not my group messages', () => {
    const m = createMessageContactMatcher('Dad', deps)
    expect(m.matches(groupFromDad)).toBe(true)
    expect(m.matches(groupFromMe)).toBe(false)
  })

  it('matches phone input in any format by normalized digits', () => {
    for (const input of ['5550102000', '+15550102000', '(555) 010-2000', '555-010-2000']) {
      const m = createMessageContactMatcher(input, deps)
      expect(m.isName).toBe(false)
      expect(m.matches(dadReply)).toBe(true)
      expect(m.matches(otherReply)).toBe(false)
    }
  })

  it('matches email input exactly, case-insensitive', () => {
    const m = createMessageContactMatcher('DAD@example.com', deps)
    expect(m.matches(dadEmailIn)).toBe(true)
    expect(m.matches(dadIn)).toBe(false)
  })

  it('does not fuzzy-match names: an unknown name resolves to nobody', () => {
    const m = createMessageContactMatcher('Da', deps)
    expect(m.resolvedCount).toBe(0)
    expect(m.matches(dadIn)).toBe(false)
    expect(m.matches(dadReply)).toBe(false)
  })

  it('never matches the Me / Unknown placeholders by substring', () => {
    const m = createMessageContactMatcher('me', deps)
    expect(m.matches({ sender: 'Me', chatIdentifier: '' })).toBe(false)
    expect(createMessageContactMatcher('unknown', deps).matches({ sender: 'Unknown', chatIdentifier: '' })).toBe(false)
  })

  it('returns null for empty input', () => {
    expect(createMessageContactMatcher('', deps)).toBeNull()
    expect(createMessageContactMatcher('   ', deps)).toBeNull()
  })
})

describe('describeMessagePeer', () => {
  const lookups = {
    resolvePhone: (p) => (normalizePhone(p) === '5550102000' ? DAD : null),
    resolveEmail: (e) => (e.toLowerCase() === 'dad@example.com' ? DAD : null),
    formatContact: (c) => c.displayName
  }

  it('names the contact and handle of a 1:1 reply', () => {
    expect(describeMessagePeer(dadReply, lookups)).toBe('Dad (+15550102000)')
  })

  it('resolves email handles', () => {
    expect(describeMessagePeer({ sender: 'Me', chatIdentifier: 'dad@example.com', isGroupChat: false }, lookups))
      .toBe('Dad (dad@example.com)')
  })

  it('falls back to the raw handle when the contact is unknown', () => {
    expect(describeMessagePeer(otherReply, lookups)).toBe('+15550109999')
  })

  it('names the group chat for group replies', () => {
    expect(describeMessagePeer(groupFromMe, lookups)).toBe('group chat "Family"')
    expect(describeMessagePeer({ ...groupFromMe, chatName: '' }, lookups)).toBe('group chat chat123')
  })

  it('returns null when the row has no chat', () => {
    expect(describeMessagePeer({ sender: 'Me', chatIdentifier: '', isGroupChat: false }, lookups)).toBeNull()
  })
})
