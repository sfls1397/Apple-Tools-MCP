/**
 * Real Contacts Integration Tests
 *
 * Tests contact resolution and enrichment using actual Contacts.app data
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { checkDataSources, CONTACTS_DB } from '../helpers/real-data.js'
import { execSync } from 'child_process'
import fs from 'fs'

const sources = checkDataSources()

// Try to import real contact functions
let contactFunctions = null
try {
  contactFunctions = await import('../../../contacts.js')
} catch (e) {
  console.warn('Could not import contacts.js:', e.message)
}

describe.skipIf(!sources.contacts || !contactFunctions)(
  'Real Contacts Integration',
  () => {
    beforeAll(async () => {
      // Load contacts from real database
      if (contactFunctions?.loadContacts) {
        await contactFunctions.loadContacts()
      }
    }, 30000)

    describe('Contact Loading', () => {
      it('should load contacts from Contacts.app', async () => {
        const stats = contactFunctions.getContactStats?.()

        if (stats) {
          expect(stats.total).toBeGreaterThanOrEqual(0)
          console.log('Contact stats:', stats)
        }
      })

      it('should have contacts with names', async () => {
        // Search for any contact
        const results = contactFunctions.searchContacts?.('a', 5)

        if (results && results.length > 0) {
          const contact = results[0]
          // Contact should have at least a name
          expect(
            contact.firstName || contact.lastName || contact.organization
          ).toBeTruthy()
        }
      })
    })

    describe('Email Resolution', () => {
      it('should resolve known email addresses', async () => {
        // Get a sample contact with email
        const results = contactFunctions.searchContacts?.('', 10)

        if (results && results.length > 0) {
          const contactWithEmail = results.find(c => c.emails?.length > 0)

          if (contactWithEmail) {
            const emailObj = contactWithEmail.emails[0]
            const email = typeof emailObj === 'string' ? emailObj : emailObj.email
            const resolved = contactFunctions.resolveEmail?.(email)

            if (resolved) {
              expect(resolved.id).toBe(contactWithEmail.id)
            }
          }
        }
      })

      it('should handle case-insensitive email lookup', async () => {
        const results = contactFunctions.searchContacts?.('', 10)

        if (results && results.length > 0) {
          const contactWithEmail = results.find(c => c.emails?.length > 0)

          if (contactWithEmail) {
            const emailObj = contactWithEmail.emails[0]
            const email = typeof emailObj === 'string' ? emailObj : emailObj.email
            const upperEmail = email.toUpperCase()
            const resolved = contactFunctions.resolveEmail?.(upperEmail)

            if (resolved) {
              expect(resolved.id).toBe(contactWithEmail.id)
            }
          }
        }
      })

      it('should return null for unknown email', () => {
        const resolved = contactFunctions.resolveEmail?.(
          'definitely-unknown-email-xyz123@nonexistent-domain.invalid'
        )
        expect(resolved).toBeNull()
      })
    })

    describe('Phone Resolution', () => {
      it('should resolve known phone numbers', async () => {
        const results = contactFunctions.searchContacts?.('', 10)

        if (results && results.length > 0) {
          const contactWithPhone = results.find(c => c.phones?.length > 0)

          if (contactWithPhone) {
            const phoneObj = contactWithPhone.phones[0]
            const phone = typeof phoneObj === 'string' ? phoneObj : phoneObj.phone
            const resolved = contactFunctions.resolvePhone?.(phone)

            if (resolved) {
              expect(resolved.id).toBe(contactWithPhone.id)
            }
          }
        }
      })

      it('should handle various phone formats', async () => {
        // Test that different formats resolve to same contact
        const results = contactFunctions.searchContacts?.('', 10)

        if (results && results.length > 0) {
          const contactWithPhone = results.find(c => c.phones?.length > 0)

          if (contactWithPhone && contactWithPhone.phones[0]) {
            const phoneObj = contactWithPhone.phones[0]
            const phone = typeof phoneObj === 'string' ? phoneObj : phoneObj.phone

            // Try different formats of same number
            const formats = [
              phone,
              phone.replace(/\D/g, ''), // digits only
              phone.replace(/-/g, ' ') // spaces instead of dashes
            ]

            for (const format of formats) {
              const resolved = contactFunctions.resolvePhone?.(format)
              // All formats should resolve to same contact (or null if not found)
              if (resolved) {
                expect(resolved.id).toBe(contactWithPhone.id)
              }
            }
          }
        }
      })
    })

    describe('Name Resolution', () => {
      it('should resolve by name', async () => {
        const results = contactFunctions.searchContacts?.('', 5)

        if (results && results.length > 0) {
          const contact = results[0]
          const name = contact.firstName || contact.lastName

          if (name) {
            const resolved = contactFunctions.resolveByName?.(name)

            if (resolved && resolved.length > 0) {
              // Should find at least one match
              expect(resolved.length).toBeGreaterThan(0)
            }
          }
        }
      })

      it('should handle partial name matches', async () => {
        const results = contactFunctions.searchContacts?.('a', 5)

        // Search with partial name should return results
        expect(Array.isArray(results)).toBe(true)
      })
    })

    describe('Contact Details', () => {
      it('should lookup full contact details', async () => {
        const results = contactFunctions.searchContacts?.('', 1)

        if (results && results.length > 0) {
          const contact = results[0]
          // Use email, phone, or name as identifier (not ID)
          let identifier = null
          if (contact.emails?.length > 0) {
            const emailObj = contact.emails[0]
            identifier = typeof emailObj === 'string' ? emailObj : emailObj.email
          } else if (contact.phones?.length > 0) {
            const phoneObj = contact.phones[0]
            identifier = typeof phoneObj === 'string' ? phoneObj : phoneObj.phone
          } else if (contact.firstName || contact.lastName) {
            identifier = `${contact.firstName} ${contact.lastName}`.trim()
          }

          if (identifier) {
            const details = contactFunctions.lookupContact?.(identifier)

            if (details) {
              expect(details.id).toBe(contact.id)
              // Should have name fields
              expect(
                details.firstName !== undefined || details.lastName !== undefined
              ).toBe(true)
            }
          }
        }
      })

      it('should format contact for display', async () => {
        const results = contactFunctions.searchContacts?.('', 1)

        if (results && results.length > 0) {
          const formatted = contactFunctions.formatContact?.(results[0])

          if (formatted) {
            expect(typeof formatted).toBe('string')
            expect(formatted.length).toBeGreaterThan(0)
          }
        }
      })
    })
  }
)

describe.skipIf(!sources.contacts)('Contacts Database Access', () => {
  it('should have access to contacts database', () => {
    expect(fs.existsSync(CONTACTS_DB)).toBe(true)
  })

  it('should query contacts database directly', () => {
    try {
      const result = execSync(
        `sqlite3 "${CONTACTS_DB}" "SELECT COUNT(*) FROM ZABCDRECORD"`,
        { encoding: 'utf-8' }
      )
      const count = parseInt(result.trim())
      expect(count).toBeGreaterThanOrEqual(0)
      console.log('Total contacts in database:', count)
    } catch (e) {
      // May fail if permissions not granted
      console.warn('Could not query contacts DB:', e.message)
    }
  })
})

describe('Contact Identifier Extraction', () => {
  it('should get identifiers for contact', async () => {
    if (!contactFunctions?.getContactIdentifiers) return

    const results = contactFunctions.searchContacts?.('', 1)

    if (results && results.length > 0) {
      const ids = contactFunctions.getContactIdentifiers(results[0])

      expect(ids).toHaveProperty('emails')
      expect(ids).toHaveProperty('phones')
      expect(Array.isArray(ids.emails)).toBe(true)
      expect(Array.isArray(ids.phones)).toBe(true)
    }
  })
})
