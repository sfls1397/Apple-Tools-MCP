/**
 * Unit tests for contacts.js
 * Tests contact resolution, phone normalization, and lookup functions
 *
 * Uses REAL macOS Contacts database - no mocks.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  loadContacts,
  resolveEmail,
  resolvePhone,
  resolveByName,
  getContactIdentifiers,
  searchContacts,
  lookupContact,
  formatContact,
  getContactStats
} from '../../contacts.js'

// Check if Contacts database exists
const HOME = process.env.HOME
const CONTACTS_DIR = path.join(HOME, 'Library/Application Support/AddressBook/Sources')
const hasContactsDB = fs.existsSync(CONTACTS_DIR)

describe.skipIf(!hasContactsDB)('contacts.js - Real Data', () => {
  let contacts = []

  beforeAll(() => {
    contacts = loadContacts()
  })

  describe('loadContacts', () => {
    it('should load contacts from real database', () => {
      expect(contacts.length).toBeGreaterThan(0)
    })

    it('should have contacts with expected fields', () => {
      const contact = contacts[0]
      expect(contact).toHaveProperty('id')
      // Should have at least one of these name fields
      const hasName = contact.firstName || contact.lastName || contact.organization
      expect(hasName).toBeTruthy()
    })

    it('should cache contacts on repeated calls', () => {
      const start = Date.now()
      const contacts2 = loadContacts()
      const duration = Date.now() - start

      expect(contacts2.length).toBe(contacts.length)
      expect(duration).toBeLessThan(50) // Cached call should be fast
    })
  })

  describe('resolveEmail', () => {
    it('should resolve email to contact if contacts have emails', () => {
      // Find a contact with an email
      const contactWithEmail = contacts.find(c => c.emails && c.emails.length > 0)
      if (contactWithEmail) {
        const email = contactWithEmail.emails[0].email // emails are objects with .email property
        const resolved = resolveEmail(email)
        expect(resolved).toBeTruthy()
        expect(resolved.id).toBe(contactWithEmail.id)
      }
    })

    it('should be case-insensitive', () => {
      const contactWithEmail = contacts.find(c => c.emails && c.emails.length > 0)
      if (contactWithEmail) {
        const email = contactWithEmail.emails[0].email.toUpperCase()
        const resolved = resolveEmail(email)
        expect(resolved).toBeTruthy()
      }
    })

    it('should return null for unknown email', () => {
      expect(resolveEmail('nonexistent-email-xyz@example.com')).toBeNull()
    })

    it('should return null for empty/null input', () => {
      expect(resolveEmail(null)).toBeNull()
      expect(resolveEmail('')).toBeNull()
    })
  })

  describe('resolvePhone', () => {
    it('should resolve phone to contact if contacts have phones', () => {
      const contactWithPhone = contacts.find(c => c.phones && c.phones.length > 0)
      if (contactWithPhone) {
        const phone = contactWithPhone.phones[0].phone // phones are objects with .phone property
        const resolved = resolvePhone(phone)
        expect(resolved).toBeTruthy()
        expect(resolved.id).toBe(contactWithPhone.id)
      }
    })

    it('should normalize phone numbers for matching', () => {
      const contactWithPhone = contacts.find(c => c.phones && c.phones.length > 0)
      if (contactWithPhone) {
        // Add formatting to the phone number
        const phone = contactWithPhone.phones[0].phone
        const digits = phone.replace(/\D/g, '')
        if (digits.length >= 10) {
          const formatted = `(${digits.slice(-10, -7)}) ${digits.slice(-7, -4)}-${digits.slice(-4)}`
          const resolved = resolvePhone(formatted)
          // Should still match after normalization
          expect(resolved).toBeTruthy()
        }
      }
    })

    it('should return null for non-existent phone', () => {
      expect(resolvePhone('999-999-9999')).toBeNull()
    })

    it('should return null for empty/null phone', () => {
      expect(resolvePhone(null)).toBeNull()
      expect(resolvePhone('')).toBeNull()
    })
  })

  describe('resolveByName', () => {
    it('should find contact by first name', () => {
      const contactWithName = contacts.find(c => c.firstName)
      if (contactWithName) {
        const matches = resolveByName(contactWithName.firstName)
        expect(matches.length).toBeGreaterThan(0)
        expect(matches.some(m => m.id === contactWithName.id)).toBe(true)
      }
    })

    it('should find contact by full name', () => {
      const contactWithFullName = contacts.find(c => c.firstName && c.lastName)
      if (contactWithFullName) {
        const fullName = `${contactWithFullName.firstName} ${contactWithFullName.lastName}`
        const matches = resolveByName(fullName)
        expect(matches.length).toBeGreaterThan(0)
      }
    })

    it('should be case-insensitive', () => {
      const contactWithName = contacts.find(c => c.firstName)
      if (contactWithName) {
        const matches = resolveByName(contactWithName.firstName.toLowerCase())
        expect(matches.length).toBeGreaterThan(0)
      }
    })

    it('should return empty array for no match', () => {
      // Use a string with characters unlikely to appear in names
      const matches = resolveByName('xqxqxq')
      expect(matches.length).toBe(0)
    })

    it('should return empty array for empty/null input', () => {
      expect(resolveByName(null)).toEqual([])
      expect(resolveByName('')).toEqual([])
    })
  })

  describe('getContactIdentifiers', () => {
    it('should return identifiers for a contact', () => {
      const contact = contacts[0]
      const identifiers = getContactIdentifiers(contact.id)

      expect(identifiers).toHaveProperty('emails')
      expect(identifiers).toHaveProperty('phones')
      expect(Array.isArray(identifiers.emails)).toBe(true)
      expect(Array.isArray(identifiers.phones)).toBe(true)
    })

    it('should return empty arrays for unknown contact', () => {
      const identifiers = getContactIdentifiers(999999999)
      expect(identifiers.emails).toEqual([])
      expect(identifiers.phones).toEqual([])
    })
  })

  describe('searchContacts', () => {
    it('should search by name', () => {
      const contactWithName = contacts.find(c => c.firstName)
      if (contactWithName) {
        const results = searchContacts(contactWithName.firstName)
        expect(results.length).toBeGreaterThan(0)
      }
    })

    it('should search by organization', () => {
      const contactWithOrg = contacts.find(c => c.organization)
      if (contactWithOrg) {
        const results = searchContacts(contactWithOrg.organization)
        expect(results.length).toBeGreaterThan(0)
      }
    })

    it('should respect limit parameter', () => {
      const results = searchContacts('', 5)
      expect(results.length).toBeLessThanOrEqual(5)
    })

    it('should return contacts when query is empty', () => {
      const results = searchContacts('')
      expect(results.length).toBeGreaterThan(0)
    })
  })

  describe('lookupContact', () => {
    it('should lookup by email if contact has email', () => {
      const contactWithEmail = contacts.find(c => c.emails && c.emails.length > 0)
      if (contactWithEmail) {
        const contact = lookupContact(contactWithEmail.emails[0].email)
        expect(contact).toBeTruthy()
      }
    })

    it('should lookup by phone if contact has phone', () => {
      const contactWithPhone = contacts.find(c => c.phones && c.phones.length > 0)
      if (contactWithPhone) {
        const contact = lookupContact(contactWithPhone.phones[0].phone)
        expect(contact).toBeTruthy()
      }
    })

    it('should lookup by name', () => {
      const contactWithName = contacts.find(c => c.firstName && c.lastName)
      if (contactWithName) {
        const fullName = `${contactWithName.firstName} ${contactWithName.lastName}`
        const contact = lookupContact(fullName)
        expect(contact).toBeTruthy()
      }
    })

    it('should return null for unknown identifier', () => {
      // Use an identifier that won't match any contact by email, phone, or name
      expect(lookupContact('zzzznotfound@zzzznotfound.zzz')).toBeNull()
    })

    it('should return null for empty/null input', () => {
      expect(lookupContact(null)).toBeNull()
      expect(lookupContact('')).toBeNull()
    })
  })

  describe('formatContact', () => {
    it('should format contact with name and organization', () => {
      const contactWithBoth = contacts.find(c => c.displayName && c.organization)
      if (contactWithBoth) {
        const formatted = formatContact(contactWithBoth)
        expect(formatted).toContain(contactWithBoth.displayName)
      }
    })

    it('should format contact with name only', () => {
      const contactWithNameOnly = contacts.find(c => c.displayName && !c.organization)
      if (contactWithNameOnly) {
        const formatted = formatContact(contactWithNameOnly)
        expect(formatted).toBe(contactWithNameOnly.displayName)
      }
    })

    it('should return Unknown for null/undefined contact', () => {
      expect(formatContact(null)).toBe('Unknown')
      expect(formatContact(undefined)).toBe('Unknown')
    })
  })

  describe('getContactStats', () => {
    it('should return contact statistics', () => {
      const stats = getContactStats()
      expect(stats.totalContacts).toBeGreaterThan(0)
      expect(stats).toHaveProperty('uniqueEmails')
      expect(stats).toHaveProperty('uniquePhones')
    })
  })
})

// Tests that don't require real data (pure function tests)
describe('formatContact - Pure Function Tests', () => {
  it('should format contact with name and organization', () => {
    const contact = {
      displayName: 'John Doe',
      organization: 'Acme Corp'
    }
    expect(formatContact(contact)).toBe('John Doe (Acme Corp)')
  })

  it('should format contact with name only', () => {
    const contact = {
      displayName: 'John Doe',
      organization: null
    }
    expect(formatContact(contact)).toBe('John Doe')
  })

  it('should not duplicate organization in display', () => {
    const contact = {
      displayName: 'Acme Corp',
      organization: 'Acme Corp'
    }
    expect(formatContact(contact)).toBe('Acme Corp')
  })

  it('should return Unknown for null/undefined contact', () => {
    expect(formatContact(null)).toBe('Unknown')
    expect(formatContact(undefined)).toBe('Unknown')
  })
})
