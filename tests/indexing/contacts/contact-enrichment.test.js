/**
 * Tests for contact enrichment in search results
 * Tests adding contact info to emails, messages, and calendar events
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Contact Enrichment', () => {
  const mockContacts = [
    {
      id: '1',
      firstName: 'John',
      lastName: 'Doe',
      emails: ['john@example.com', 'jdoe@work.com'],
      phones: ['+15551234567'],
      organization: 'Acme Corp'
    },
    {
      id: '2',
      firstName: 'Jane',
      lastName: 'Smith',
      emails: ['jane@example.com'],
      phones: ['+15559876543'],
      organization: 'Tech Inc'
    }
  ]

  const findContactByEmail = (email, contacts) => {
    if (!email) return null
    const normalized = email.toLowerCase().trim()
    return contacts.find(c =>
      c.emails?.some(e => e.toLowerCase() === normalized)
    ) || null
  }

  const findContactByPhone = (phone, contacts) => {
    if (!phone) return null
    const digits = phone.replace(/[^\d]/g, '')
    return contacts.find(c =>
      c.phones?.some(p => p.replace(/[^\d]/g, '') === digits)
    ) || null
  }

  describe('email result enrichment', () => {
    const enrichEmailResult = (email, contacts) => {
      const senderContact = findContactByEmail(email.from, contacts)
      const recipientContacts = email.to
        ?.split(',')
        .map(addr => findContactByEmail(addr.trim(), contacts))
        .filter(Boolean) || []

      return {
        ...email,
        senderName: senderContact
          ? `${senderContact.firstName} ${senderContact.lastName}`
          : null,
        senderOrganization: senderContact?.organization || null,
        recipientNames: recipientContacts.map(c => `${c.firstName} ${c.lastName}`)
      }
    }

    it('should add sender name from contact', () => {
      const email = {
        id: 'e1',
        from: 'john@example.com',
        to: 'unknown@test.com',
        subject: 'Test'
      }

      const enriched = enrichEmailResult(email, mockContacts)

      expect(enriched.senderName).toBe('John Doe')
      expect(enriched.senderOrganization).toBe('Acme Corp')
    })

    it('should add recipient names', () => {
      const email = {
        id: 'e2',
        from: 'unknown@test.com',
        to: 'jane@example.com',
        subject: 'Test'
      }

      const enriched = enrichEmailResult(email, mockContacts)

      expect(enriched.recipientNames).toContain('Jane Smith')
    })

    it('should handle multiple recipients', () => {
      const email = {
        id: 'e3',
        from: 'unknown@test.com',
        to: 'john@example.com, jane@example.com',
        subject: 'Group Email'
      }

      const enriched = enrichEmailResult(email, mockContacts)

      expect(enriched.recipientNames).toHaveLength(2)
      expect(enriched.recipientNames).toContain('John Doe')
      expect(enriched.recipientNames).toContain('Jane Smith')
    })

    it('should handle unknown sender', () => {
      const email = {
        id: 'e4',
        from: 'unknown@test.com',
        to: 'jane@example.com',
        subject: 'Test'
      }

      const enriched = enrichEmailResult(email, mockContacts)

      expect(enriched.senderName).toBeNull()
      expect(enriched.senderOrganization).toBeNull()
    })

    it('should preserve original email properties', () => {
      const email = {
        id: 'e5',
        from: 'john@example.com',
        to: 'jane@example.com',
        subject: 'Important',
        date: '2024-01-01'
      }

      const enriched = enrichEmailResult(email, mockContacts)

      expect(enriched.id).toBe('e5')
      expect(enriched.subject).toBe('Important')
      expect(enriched.date).toBe('2024-01-01')
    })
  })

  describe('message result enrichment', () => {
    const enrichMessageResult = (message, contacts) => {
      const senderContact = message.isFromMe
        ? null
        : findContactByPhone(message.handle, contacts)

      return {
        ...message,
        senderName: message.isFromMe
          ? 'Me'
          : senderContact
            ? `${senderContact.firstName} ${senderContact.lastName}`
            : message.handle,
        senderContact: senderContact || null
      }
    }

    it('should show "Me" for outgoing messages', () => {
      const message = {
        id: 'm1',
        text: 'Hello',
        isFromMe: true,
        handle: '+15551234567'
      }

      const enriched = enrichMessageResult(message, mockContacts)

      expect(enriched.senderName).toBe('Me')
    })

    it('should resolve contact for incoming messages', () => {
      const message = {
        id: 'm2',
        text: 'Hi there',
        isFromMe: false,
        handle: '+15551234567'
      }

      const enriched = enrichMessageResult(message, mockContacts)

      expect(enriched.senderName).toBe('John Doe')
      expect(enriched.senderContact).toBeDefined()
    })

    it('should use handle for unknown contacts', () => {
      const message = {
        id: 'm3',
        text: 'Unknown sender',
        isFromMe: false,
        handle: '+19999999999'
      }

      const enriched = enrichMessageResult(message, mockContacts)

      expect(enriched.senderName).toBe('+19999999999')
      expect(enriched.senderContact).toBeNull()
    })
  })

  describe('calendar event enrichment', () => {
    const enrichCalendarEvent = (event, contacts) => {
      const enrichedAttendees = event.attendees?.map(attendee => {
        const contact = findContactByEmail(attendee.email, contacts)
        return {
          ...attendee,
          contactName: contact
            ? `${contact.firstName} ${contact.lastName}`
            : null,
          organization: contact?.organization || null
        }
      }) || []

      const organizerContact = findContactByEmail(event.organizer, contacts)

      return {
        ...event,
        attendees: enrichedAttendees,
        organizerName: organizerContact
          ? `${organizerContact.firstName} ${organizerContact.lastName}`
          : null
      }
    }

    it('should enrich attendee list', () => {
      const event = {
        id: 'ev1',
        title: 'Meeting',
        attendees: [
          { email: 'john@example.com', status: 'accepted' },
          { email: 'unknown@test.com', status: 'pending' }
        ],
        organizer: 'jane@example.com'
      }

      const enriched = enrichCalendarEvent(event, mockContacts)

      expect(enriched.attendees[0].contactName).toBe('John Doe')
      expect(enriched.attendees[0].organization).toBe('Acme Corp')
      expect(enriched.attendees[1].contactName).toBeNull()
    })

    it('should resolve organizer', () => {
      const event = {
        id: 'ev2',
        title: 'Review',
        attendees: [],
        organizer: 'jane@example.com'
      }

      const enriched = enrichCalendarEvent(event, mockContacts)

      expect(enriched.organizerName).toBe('Jane Smith')
    })

    it('should handle missing attendees', () => {
      const event = {
        id: 'ev3',
        title: 'Personal Event',
        organizer: 'john@example.com'
      }

      const enriched = enrichCalendarEvent(event, mockContacts)

      expect(enriched.attendees).toEqual([])
      expect(enriched.organizerName).toBe('John Doe')
    })
  })

  describe('batch enrichment', () => {
    const batchEnrichEmails = (emails, contacts) => {
      // Pre-build email lookup map for efficiency
      const emailToContact = new Map()
      for (const contact of contacts) {
        for (const email of contact.emails || []) {
          emailToContact.set(email.toLowerCase(), contact)
        }
      }

      return emails.map(email => {
        const senderContact = emailToContact.get(email.from?.toLowerCase())
        return {
          ...email,
          senderName: senderContact
            ? `${senderContact.firstName} ${senderContact.lastName}`
            : null
        }
      })
    }

    it('should efficiently enrich multiple emails', () => {
      const emails = [
        { id: '1', from: 'john@example.com', subject: 'Email 1' },
        { id: '2', from: 'jane@example.com', subject: 'Email 2' },
        { id: '3', from: 'john@example.com', subject: 'Email 3' },
        { id: '4', from: 'unknown@test.com', subject: 'Email 4' }
      ]

      const enriched = batchEnrichEmails(emails, mockContacts)

      expect(enriched[0].senderName).toBe('John Doe')
      expect(enriched[1].senderName).toBe('Jane Smith')
      expect(enriched[2].senderName).toBe('John Doe')
      expect(enriched[3].senderName).toBeNull()
    })

    it('should handle large batches', () => {
      const emails = Array.from({ length: 1000 }, (_, i) => ({
        id: String(i),
        from: i % 2 === 0 ? 'john@example.com' : 'unknown@test.com',
        subject: `Email ${i}`
      }))

      const start = performance.now()
      const enriched = batchEnrichEmails(emails, mockContacts)
      const duration = performance.now() - start

      expect(enriched).toHaveLength(1000)
      expect(duration).toBeLessThan(100) // Should be fast
    })
  })

  describe('person search across sources', () => {
    const searchPersonCommunication = (personName, data, contacts) => {
      // Find contact
      const contact = contacts.find(c =>
        `${c.firstName} ${c.lastName}`.toLowerCase() === personName.toLowerCase()
      )

      if (!contact) {
        return { emails: [], messages: [], events: [] }
      }

      // Search each source
      const emailMatches = data.emails.filter(e =>
        contact.emails.some(ce =>
          e.from?.toLowerCase().includes(ce.toLowerCase()) ||
          e.to?.toLowerCase().includes(ce.toLowerCase())
        )
      )

      const messageMatches = data.messages.filter(m =>
        contact.phones.some(p =>
          m.handle?.replace(/[^\d]/g, '') === p.replace(/[^\d]/g, '')
        )
      )

      const eventMatches = data.events.filter(ev =>
        ev.attendees?.some(a =>
          contact.emails.some(ce => a.email?.toLowerCase() === ce.toLowerCase())
        )
      )

      return {
        emails: emailMatches,
        messages: messageMatches,
        events: eventMatches
      }
    }

    const mockData = {
      emails: [
        { id: 'e1', from: 'john@example.com', to: 'me@test.com', subject: 'Hello' },
        { id: 'e2', from: 'unknown@test.com', to: 'john@example.com', subject: 'Reply' },
        { id: 'e3', from: 'jane@example.com', to: 'me@test.com', subject: 'Other' }
      ],
      messages: [
        { id: 'm1', handle: '+15551234567', text: 'Hey' },
        { id: 'm2', handle: '+19999999999', text: 'Unknown' }
      ],
      events: [
        { id: 'ev1', title: 'Meeting', attendees: [{ email: 'john@example.com' }] },
        { id: 'ev2', title: 'Other', attendees: [{ email: 'other@test.com' }] }
      ]
    }

    it('should find all communication with a person', () => {
      const results = searchPersonCommunication('John Doe', mockData, mockContacts)

      expect(results.emails).toHaveLength(2)
      expect(results.messages).toHaveLength(1)
      expect(results.events).toHaveLength(1)
    })

    it('should return empty results for unknown person', () => {
      const results = searchPersonCommunication('Unknown Person', mockData, mockContacts)

      expect(results.emails).toHaveLength(0)
      expect(results.messages).toHaveLength(0)
      expect(results.events).toHaveLength(0)
    })
  })

  describe('contact field extraction', () => {
    const extractContactInfo = (contact) => {
      return {
        displayName: contact.firstName && contact.lastName
          ? `${contact.firstName} ${contact.lastName}`
          : contact.firstName || contact.lastName || 'Unknown',
        primaryEmail: contact.emails?.[0] || null,
        primaryPhone: contact.phones?.[0] || null,
        organization: contact.organization || null,
        allEmails: contact.emails || [],
        allPhones: contact.phones || []
      }
    }

    it('should extract all contact fields', () => {
      const contact = mockContacts[0]
      const info = extractContactInfo(contact)

      expect(info.displayName).toBe('John Doe')
      expect(info.primaryEmail).toBe('john@example.com')
      expect(info.primaryPhone).toBe('+15551234567')
      expect(info.organization).toBe('Acme Corp')
      expect(info.allEmails).toHaveLength(2)
    })

    it('should handle partial contact', () => {
      const partialContact = { firstName: 'Alice' }
      const info = extractContactInfo(partialContact)

      expect(info.displayName).toBe('Alice')
      expect(info.primaryEmail).toBeNull()
      expect(info.primaryPhone).toBeNull()
    })

    it('should handle empty contact', () => {
      const emptyContact = {}
      const info = extractContactInfo(emptyContact)

      expect(info.displayName).toBe('Unknown')
      expect(info.allEmails).toEqual([])
      expect(info.allPhones).toEqual([])
    })
  })

  describe('sender frequency analysis', () => {
    const analyzeSenderFrequency = (emails, contacts) => {
      const senderCounts = new Map()

      for (const email of emails) {
        const sender = email.from?.toLowerCase()
        if (sender) {
          senderCounts.set(sender, (senderCounts.get(sender) || 0) + 1)
        }
      }

      // Sort by frequency
      const sorted = Array.from(senderCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([email, count]) => {
          const contact = contacts.find(c =>
            c.emails?.some(e => e.toLowerCase() === email)
          )
          return {
            email,
            count,
            name: contact ? `${contact.firstName} ${contact.lastName}` : null
          }
        })

      return sorted
    }

    it('should rank senders by email count', () => {
      const emails = [
        { from: 'john@example.com' },
        { from: 'john@example.com' },
        { from: 'john@example.com' },
        { from: 'jane@example.com' },
        { from: 'unknown@test.com' }
      ]

      const frequency = analyzeSenderFrequency(emails, mockContacts)

      expect(frequency[0].email).toBe('john@example.com')
      expect(frequency[0].count).toBe(3)
      expect(frequency[0].name).toBe('John Doe')
    })

    it('should include unknown senders', () => {
      const emails = [
        { from: 'unknown@test.com' },
        { from: 'unknown@test.com' }
      ]

      const frequency = analyzeSenderFrequency(emails, mockContacts)

      expect(frequency[0].email).toBe('unknown@test.com')
      expect(frequency[0].count).toBe(2)
      expect(frequency[0].name).toBeNull()
    })
  })

  describe('contact thumbnail/photo handling', () => {
    const getContactPhoto = (contact, defaultPhoto = null) => {
      if (!contact) return defaultPhoto
      if (contact.photoData) return contact.photoData
      if (contact.photoUrl) return contact.photoUrl

      // Generate initials-based placeholder
      const initials = [contact.firstName?.[0], contact.lastName?.[0]]
        .filter(Boolean)
        .join('')
        .toUpperCase()

      return { type: 'initials', value: initials || '?' }
    }

    it('should return photo data if available', () => {
      const contact = { firstName: 'John', photoData: 'base64data...' }
      expect(getContactPhoto(contact)).toBe('base64data...')
    })

    it('should return photo URL if available', () => {
      const contact = { firstName: 'John', photoUrl: 'https://example.com/photo.jpg' }
      expect(getContactPhoto(contact)).toBe('https://example.com/photo.jpg')
    })

    it('should generate initials placeholder', () => {
      const contact = { firstName: 'John', lastName: 'Doe' }
      const photo = getContactPhoto(contact)

      expect(photo.type).toBe('initials')
      expect(photo.value).toBe('JD')
    })

    it('should handle single name', () => {
      const contact = { firstName: 'Alice' }
      const photo = getContactPhoto(contact)

      expect(photo.value).toBe('A')
    })

    it('should return default for null contact', () => {
      expect(getContactPhoto(null, 'default.png')).toBe('default.png')
    })
  })
})
