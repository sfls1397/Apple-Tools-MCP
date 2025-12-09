/**
 * Tests for contact resolution from various identifiers
 * Tests phone number normalization, email matching, and name resolution
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Contact Resolution', () => {
  describe('phone number normalization', () => {
    const normalizePhone = (phone) => {
      if (typeof phone !== 'string') return ''

      // Remove all non-digit characters except +
      let normalized = phone.replace(/[^\d+]/g, '')

      // Handle US numbers without country code
      if (normalized.length === 10 && !normalized.startsWith('+')) {
        normalized = '+1' + normalized
      }

      // Handle US numbers with 1 but no +
      if (normalized.length === 11 && normalized.startsWith('1')) {
        normalized = '+' + normalized
      }

      return normalized
    }

    it('should normalize phone with dashes', () => {
      expect(normalizePhone('555-123-4567')).toBe('+15551234567')
    })

    it('should normalize phone with parentheses', () => {
      expect(normalizePhone('(555) 123-4567')).toBe('+15551234567')
    })

    it('should normalize phone with spaces', () => {
      expect(normalizePhone('555 123 4567')).toBe('+15551234567')
    })

    it('should normalize phone with dots', () => {
      expect(normalizePhone('555.123.4567')).toBe('+15551234567')
    })

    it('should preserve existing country code', () => {
      expect(normalizePhone('+1-555-123-4567')).toBe('+15551234567')
    })

    it('should add + to country code if missing', () => {
      expect(normalizePhone('1-555-123-4567')).toBe('+15551234567')
    })

    it('should handle international numbers', () => {
      expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
    })

    it('should return empty string for non-string', () => {
      expect(normalizePhone(null)).toBe('')
      expect(normalizePhone(undefined)).toBe('')
      expect(normalizePhone(123)).toBe('')
    })
  })

  describe('email normalization', () => {
    const normalizeEmail = (email) => {
      if (typeof email !== 'string') return ''
      return email.trim().toLowerCase()
    }

    it('should lowercase email', () => {
      expect(normalizeEmail('John@Example.COM')).toBe('john@example.com')
    })

    it('should trim whitespace', () => {
      expect(normalizeEmail('  john@example.com  ')).toBe('john@example.com')
    })

    it('should handle already normalized email', () => {
      expect(normalizeEmail('john@example.com')).toBe('john@example.com')
    })

    it('should return empty for non-string', () => {
      expect(normalizeEmail(null)).toBe('')
    })
  })

  describe('contact matching', () => {
    const mockContacts = [
      {
        id: '1',
        firstName: 'John',
        lastName: 'Doe',
        emails: ['john@example.com', 'jdoe@work.com'],
        phones: ['+15551234567', '+15559876543']
      },
      {
        id: '2',
        firstName: 'Jane',
        lastName: 'Smith',
        emails: ['jane@example.com'],
        phones: ['+15551112222']
      },
      {
        id: '3',
        firstName: 'Bob',
        lastName: 'Johnson',
        emails: ['bob@company.org'],
        phones: []
      }
    ]

    const normalizePhone = (phone) => {
      if (typeof phone !== 'string') return ''
      let normalized = phone.replace(/[^\d+]/g, '')
      if (normalized.length === 10) normalized = '+1' + normalized
      if (normalized.length === 11 && normalized.startsWith('1')) normalized = '+' + normalized
      return normalized
    }

    const findContactByEmail = (email, contacts) => {
      const normalized = email.toLowerCase().trim()
      return contacts.find(c =>
        c.emails.some(e => e.toLowerCase() === normalized)
      )
    }

    const findContactByPhone = (phone, contacts) => {
      const normalized = normalizePhone(phone)
      return contacts.find(c =>
        c.phones.some(p => normalizePhone(p) === normalized)
      )
    }

    const findContactByName = (name, contacts) => {
      const lower = name.toLowerCase().trim()
      return contacts.find(c => {
        const fullName = `${c.firstName} ${c.lastName}`.toLowerCase()
        return fullName === lower || c.firstName.toLowerCase() === lower || c.lastName.toLowerCase() === lower
      })
    }

    it('should find contact by email', () => {
      const contact = findContactByEmail('john@example.com', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('John')
    })

    it('should find contact by secondary email', () => {
      const contact = findContactByEmail('jdoe@work.com', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('John')
    })

    it('should be case-insensitive for email', () => {
      const contact = findContactByEmail('JANE@EXAMPLE.COM', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('Jane')
    })

    it('should find contact by phone', () => {
      const contact = findContactByPhone('+15551234567', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('John')
    })

    it('should normalize phone before matching', () => {
      const contact = findContactByPhone('555-123-4567', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('John')
    })

    it('should find contact by full name', () => {
      const contact = findContactByName('Jane Smith', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.id).toBe('2')
    })

    it('should find contact by first name only', () => {
      const contact = findContactByName('Bob', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.lastName).toBe('Johnson')
    })

    it('should return undefined for no match', () => {
      expect(findContactByEmail('unknown@example.com', mockContacts)).toBeUndefined()
      expect(findContactByPhone('+19999999999', mockContacts)).toBeUndefined()
      expect(findContactByName('Unknown Person', mockContacts)).toBeUndefined()
    })
  })

  describe('identifier type detection', () => {
    const detectIdentifierType = (identifier) => {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        return 'unknown'
      }

      const trimmed = identifier.trim()

      // Check for email pattern
      if (trimmed.includes('@') && trimmed.includes('.')) {
        return 'email'
      }

      // Check for phone pattern (contains mostly digits)
      const digitsOnly = trimmed.replace(/[^\d]/g, '')
      if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
        // Check if identifier is mostly digits
        if (digitsOnly.length / trimmed.replace(/\s/g, '').length > 0.5) {
          return 'phone'
        }
      }

      // Otherwise treat as name
      return 'name'
    }

    it('should detect email', () => {
      expect(detectIdentifierType('john@example.com')).toBe('email')
      expect(detectIdentifierType('john.doe@company.co.uk')).toBe('email')
    })

    it('should detect phone', () => {
      expect(detectIdentifierType('+1-555-123-4567')).toBe('phone')
      expect(detectIdentifierType('555.123.4567')).toBe('phone')
      expect(detectIdentifierType('(555) 123-4567')).toBe('phone')
    })

    it('should detect name', () => {
      expect(detectIdentifierType('John Doe')).toBe('name')
      expect(detectIdentifierType('Jane')).toBe('name')
    })

    it('should return unknown for empty/invalid', () => {
      expect(detectIdentifierType('')).toBe('unknown')
      expect(detectIdentifierType(null)).toBe('unknown')
      expect(detectIdentifierType(undefined)).toBe('unknown')
    })
  })

  describe('smart contact lookup', () => {
    const mockContacts = [
      {
        id: '1',
        firstName: 'John',
        lastName: 'Doe',
        emails: ['john@example.com'],
        phones: ['+15551234567']
      }
    ]

    const lookupContact = (identifier, contacts) => {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        return null
      }

      const trimmed = identifier.trim()

      // Try email match
      if (trimmed.includes('@')) {
        const byEmail = contacts.find(c =>
          c.emails.some(e => e.toLowerCase() === trimmed.toLowerCase())
        )
        if (byEmail) return byEmail
      }

      // Try phone match
      const digitsOnly = trimmed.replace(/[^\d]/g, '')
      if (digitsOnly.length >= 7) {
        let normalized = digitsOnly
        if (normalized.length === 10) normalized = '1' + normalized
        const byPhone = contacts.find(c =>
          c.phones.some(p => {
            const pDigits = p.replace(/[^\d]/g, '')
            return pDigits === normalized || pDigits.endsWith(normalized)
          })
        )
        if (byPhone) return byPhone
      }

      // Try name match
      const lower = trimmed.toLowerCase()
      const byName = contacts.find(c => {
        const fullName = `${c.firstName} ${c.lastName}`.toLowerCase()
        return fullName.includes(lower) || lower.includes(fullName)
      })
      if (byName) return byName

      return null
    }

    it('should find by email automatically', () => {
      const contact = lookupContact('john@example.com', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.id).toBe('1')
    })

    it('should find by phone automatically', () => {
      const contact = lookupContact('555-123-4567', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.id).toBe('1')
    })

    it('should find by name automatically', () => {
      const contact = lookupContact('John Doe', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.id).toBe('1')
    })

    it('should return null for no match', () => {
      expect(lookupContact('unknown@test.com', mockContacts)).toBeNull()
    })
  })

  describe('contact cache', () => {
    it('should cache contact lookups', () => {
      const cache = new Map()
      const lookupCount = { count: 0 }

      const cachedLookup = (key, lookupFn) => {
        if (cache.has(key)) {
          return cache.get(key)
        }
        lookupCount.count++
        const result = lookupFn(key)
        cache.set(key, result)
        return result
      }

      const mockLookup = (key) => ({ id: key, name: 'Test' })

      // First lookup
      const result1 = cachedLookup('test@example.com', mockLookup)
      expect(lookupCount.count).toBe(1)

      // Second lookup - should be cached
      const result2 = cachedLookup('test@example.com', mockLookup)
      expect(lookupCount.count).toBe(1)
      expect(result2).toEqual(result1)

      // Different key - should trigger new lookup
      cachedLookup('other@example.com', mockLookup)
      expect(lookupCount.count).toBe(2)
    })

    it('should expire cache entries', async () => {
      const cache = new Map()
      const TTL_MS = 50 // 50ms for test

      const setWithTTL = (key, value) => {
        cache.set(key, { value, expires: Date.now() + TTL_MS })
      }

      const getWithTTL = (key) => {
        const entry = cache.get(key)
        if (!entry) return null
        if (Date.now() > entry.expires) {
          cache.delete(key)
          return null
        }
        return entry.value
      }

      setWithTTL('key1', 'value1')
      expect(getWithTTL('key1')).toBe('value1')

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 60))

      expect(getWithTTL('key1')).toBeNull()
    })
  })

  describe('contact display name formatting', () => {
    const formatDisplayName = (contact) => {
      if (!contact) return 'Unknown'

      if (contact.firstName && contact.lastName) {
        return `${contact.firstName} ${contact.lastName}`
      }
      if (contact.firstName) return contact.firstName
      if (contact.lastName) return contact.lastName
      if (contact.emails && contact.emails.length > 0) {
        return contact.emails[0]
      }
      if (contact.phones && contact.phones.length > 0) {
        return contact.phones[0]
      }
      return 'Unknown'
    }

    it('should format full name', () => {
      const contact = { firstName: 'John', lastName: 'Doe' }
      expect(formatDisplayName(contact)).toBe('John Doe')
    })

    it('should handle first name only', () => {
      const contact = { firstName: 'John' }
      expect(formatDisplayName(contact)).toBe('John')
    })

    it('should fall back to email', () => {
      const contact = { emails: ['john@example.com'] }
      expect(formatDisplayName(contact)).toBe('john@example.com')
    })

    it('should fall back to phone', () => {
      const contact = { phones: ['+15551234567'] }
      expect(formatDisplayName(contact)).toBe('+15551234567')
    })

    it('should return Unknown for null contact', () => {
      expect(formatDisplayName(null)).toBe('Unknown')
    })
  })

  describe('message handle resolution', () => {
    const resolveHandle = (handleId, contacts) => {
      if (!handleId) return null

      // Handle can be email or phone
      const isEmail = handleId.includes('@')
      const isPhone = /^\+?\d/.test(handleId)

      if (isEmail) {
        const found = contacts.find(c =>
          c.emails?.some(e => e.toLowerCase() === handleId.toLowerCase())
        )
        return found || null
      }

      if (isPhone) {
        const normalized = handleId.replace(/[^\d]/g, '')
        const found = contacts.find(c =>
          c.phones?.some(p => p.replace(/[^\d]/g, '') === normalized)
        )
        return found || null
      }

      return null
    }

    const mockContacts = [
      {
        firstName: 'Alice',
        emails: ['alice@example.com'],
        phones: ['+15551234567']
      }
    ]

    it('should resolve email handle', () => {
      const contact = resolveHandle('alice@example.com', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('Alice')
    })

    it('should resolve phone handle', () => {
      const contact = resolveHandle('+15551234567', mockContacts)
      expect(contact).toBeDefined()
      expect(contact.firstName).toBe('Alice')
    })

    it('should return null for unknown handle', () => {
      expect(resolveHandle('unknown@test.com', mockContacts)).toBeNull()
    })

    it('should return null for null handle', () => {
      expect(resolveHandle(null, mockContacts)).toBeNull()
    })
  })

  describe('group chat participant resolution', () => {
    const resolveParticipants = (handles, contacts) => {
      return handles.map(handle => {
        const contact = contacts.find(c =>
          c.phones?.some(p => p.replace(/[^\d]/g, '') === handle.replace(/[^\d]/g, '')) ||
          c.emails?.some(e => e.toLowerCase() === handle.toLowerCase())
        )

        return {
          handle,
          contact: contact || null,
          displayName: contact
            ? `${contact.firstName} ${contact.lastName}`.trim()
            : handle
        }
      })
    }

    const mockContacts = [
      { firstName: 'John', lastName: 'Doe', phones: ['+15551111111'] },
      { firstName: 'Jane', lastName: 'Smith', phones: ['+15552222222'] }
    ]

    it('should resolve multiple participants', () => {
      const handles = ['+15551111111', '+15552222222', '+15553333333']
      const resolved = resolveParticipants(handles, mockContacts)

      expect(resolved).toHaveLength(3)
      expect(resolved[0].displayName).toBe('John Doe')
      expect(resolved[1].displayName).toBe('Jane Smith')
      expect(resolved[2].displayName).toBe('+15553333333') // Unknown
    })

    it('should preserve original handle for unknown contacts', () => {
      const handles = ['+15559999999']
      const resolved = resolveParticipants(handles, mockContacts)

      expect(resolved[0].contact).toBeNull()
      expect(resolved[0].displayName).toBe('+15559999999')
    })
  })
})
