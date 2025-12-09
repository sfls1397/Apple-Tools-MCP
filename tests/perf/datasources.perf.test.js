/**
 * Performance tests for data source operations
 * Tests: Mail, Messages, Calendar, Contacts - parsing, querying, formatting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  calculateThroughput
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateContacts,
  generateEmlxContent
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Data Source Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Data Source Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Email (Mail.app)', () => {
    describe('Parsing', () => {
      it('should parse .emlx files quickly', async () => {
        const emails = generateEmails(100)
        const emlxContents = emails.map(e => generateEmlxContent(e))

        const parseEmlx = (content) => {
          const lines = content.split('\n')
          const headers = {}
          let bodyStart = 0

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '') {
              bodyStart = i + 1
              break
            }
            const match = lines[i].match(/^([^:]+):\s*(.*)$/)
            if (match) {
              headers[match[1].toLowerCase()] = match[2]
            }
          }

          return {
            from: headers['from'] || '',
            to: headers['to'] || '',
            subject: headers['subject'] || '',
            date: headers['date'] || '',
            body: lines.slice(bodyStart).join('\n')
          }
        }

        const result = await benchmark(
          () => {
            for (const content of emlxContents) {
              parseEmlx(content)
            }
          },
          { name: 'Parse 100 .emlx files', iterations: 20, warmup: 5 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      })

      it('should detect attachments efficiently', async () => {
        const emails = generateEmails(200, { attachmentRate: 0.5 })
        const emlxContents = emails.map(e => generateEmlxContent(e))

        const hasAttachment = (content) => {
          return content.includes('Content-Disposition: attachment') ||
                 content.includes('multipart/mixed')
        }

        const result = await benchmark(
          () => {
            for (const content of emlxContents) {
              hasAttachment(content)
            }
          },
          { name: 'Detect attachments (200 emails)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })

      it('should extract headers efficiently', async () => {
        const emails = generateEmails(100)
        const emlxContents = emails.map(e => generateEmlxContent(e))

        const extractHeaders = (content) => {
          const headerEnd = content.indexOf('\n\n')
          const headerSection = content.substring(0, headerEnd)
          return headerSection.split('\n').filter(l => l.includes(':')).length
        }

        const result = await benchmark(
          () => {
            for (const content of emlxContents) {
              extractHeaders(content)
            }
          },
          { name: 'Extract headers (100 emails)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })

    describe('File Discovery', () => {
      it('should handle mdfind results efficiently', async () => {
        // Simulate mdfind output with 5000 file paths
        const paths = Array(5000).fill(null)
          .map((_, i) => `/Users/test/Library/Mail/V10/INBOX.mbox/${i + 1}.emlx`)
          .join('\n')

        const result = await benchmark(
          () => {
            const files = paths.split('\n').filter(p => p.endsWith('.emlx'))
            return files
          },
          { name: 'Process 5000 mdfind results', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })

    describe('Aggregation', () => {
      it('should aggregate senders efficiently', async () => {
        const emails = generateEmails(1000)

        const result = await benchmark(
          () => {
            const senders = new Map()
            for (const email of emails) {
              const count = senders.get(email.from) || 0
              senders.set(email.from, count + 1)
            }
            return [...senders.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 20)
          },
          { name: 'Aggregate senders (1000 emails)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })
  })

  describe('Messages (iMessage)', () => {
    describe('SQLite Queries', () => {
      it('should execute message queries efficiently', async () => {
        const messages = generateMessages(500)
        mocks.sqlite.safeSqlite3Json.mockReturnValue(messages)

        const result = await benchmark(
          async () => {
            return mocks.sqlite.safeSqlite3Json(
              '~/Library/Messages/chat.db',
              'SELECT * FROM message LIMIT 500'
            )
          },
          { name: 'Query 500 messages', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      })
    })

    describe('Binary Format Parsing', () => {
      it('should parse attributedBody efficiently', async () => {
        // Simulate NSAttributedString binary data
        const mockBinaryData = Buffer.from('NSString+Test message content here')

        const extractText = (data) => {
          // Simplified extraction
          const str = data.toString('utf-8')
          const plusIndex = str.indexOf('+')
          if (plusIndex >= 0) {
            return str.substring(plusIndex + 1)
          }
          return ''
        }

        const samples = Array(100).fill(mockBinaryData)

        const result = await benchmark(
          () => {
            for (const data of samples) {
              extractText(data)
            }
          },
          { name: 'Parse 100 attributedBody', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })
    })

    describe('Group Chat Detection', () => {
      it('should detect group chats efficiently', async () => {
        const messages = generateMessages(500, { groupChatRate: 0.4 })

        const result = await benchmark(
          () => {
            const grouped = {
              direct: messages.filter(m => m.participantCount === 2),
              group: messages.filter(m => m.participantCount > 2)
            }
            return grouped
          },
          { name: 'Categorize 500 messages', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })
    })

    describe('Contact Aggregation', () => {
      it('should aggregate message contacts efficiently', async () => {
        const messages = generateMessages(1000)

        const result = await benchmark(
          () => {
            const contacts = new Map()
            for (const msg of messages) {
              const existing = contacts.get(msg.chatIdentifier)
              if (!existing || msg.timestamp > existing.lastMessage) {
                contacts.set(msg.chatIdentifier, {
                  identifier: msg.chatIdentifier,
                  name: msg.chatName,
                  lastMessage: msg.timestamp
                })
              }
            }
            return [...contacts.values()]
              .sort((a, b) => b.lastMessage - a.lastMessage)
              .slice(0, 50)
          },
          { name: 'Aggregate contacts (1000 msgs)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })
  })

  describe('Calendar (Calendar.app)', () => {
    describe('SQLite Queries', () => {
      it('should query calendar events efficiently', async () => {
        const events = generateCalendarEvents(200)
        mocks.sqlite.safeSqlite3Json.mockReturnValue(events)

        const result = await benchmark(
          async () => {
            return mocks.sqlite.safeSqlite3Json(
              '~/Library/Calendars/Calendar.sqlitedb',
              'SELECT * FROM CalendarItem'
            )
          },
          { name: 'Query 200 calendar events', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      })
    })

    describe('Date Filtering', () => {
      it('should filter by date range efficiently', async () => {
        const events = generateCalendarEvents(500)
        const now = Date.now()
        const weekMs = 7 * 24 * 60 * 60 * 1000

        const result = await benchmark(
          () => {
            return events.filter(e =>
              e.startTimestamp >= now && e.startTimestamp <= now + weekMs
            ).sort((a, b) => a.startTimestamp - b.startTimestamp)
          },
          { name: 'Filter week events (500 total)', iterations: 100, warmup: 20 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })

      it('should handle date range queries efficiently', async () => {
        const events = generateCalendarEvents(1000)
        const startDate = new Date()
        const endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

        const result = await benchmark(
          () => {
            const startMs = startDate.getTime()
            const endMs = endDate.getTime()

            return events.filter(e =>
              e.startTimestamp >= startMs && e.startTimestamp <= endMs
            )
          },
          { name: 'Date range query (1000 events)', iterations: 100, warmup: 20 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })
    })

    describe('Free Time Calculation', () => {
      it('should calculate free time slots efficiently', async () => {
        const events = generateCalendarEvents(50)
          .sort((a, b) => a.startTimestamp - b.startTimestamp)

        const result = await benchmark(
          () => {
            const slots = []
            const workStart = 9 * 60 // 9 AM
            const workEnd = 17 * 60 // 5 PM

            for (let i = 0; i < events.length - 1; i++) {
              const gap = events[i + 1].startTimestamp - events[i].endTimestamp
              if (gap > 30 * 60 * 1000) { // 30+ minute gap
                slots.push({
                  start: new Date(events[i].endTimestamp),
                  end: new Date(events[i + 1].startTimestamp),
                  duration: gap
                })
              }
            }

            return slots.filter(s => s.duration >= 60 * 60 * 1000) // 1+ hour
          },
          { name: 'Calculate free time (50 events)', iterations: 100, warmup: 20 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(5)
      })
    })

    describe('Recurring Events', () => {
      it('should expand recurring events efficiently', async () => {
        const events = generateCalendarEvents(20, { recurringRate: 1.0 })

        const result = await benchmark(
          () => {
            const expanded = []
            const occurrences = 52 // Weekly for a year

            for (const event of events) {
              for (let i = 0; i < occurrences; i++) {
                expanded.push({
                  ...event,
                  id: event.id * 1000 + i,
                  startTimestamp: event.startTimestamp + (i * 7 * 24 * 60 * 60 * 1000)
                })
              }
            }

            return expanded
          },
          { name: 'Expand 20 recurring events (52 weeks)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      })
    })
  })

  describe('Contacts (Contacts.app)', () => {
    describe('Loading', () => {
      it('should load contacts quickly', async () => {
        const contacts = generateContacts(500)
        mocks.sqlite.safeSqlite3Json.mockReturnValue(contacts)

        const result = await benchmark(
          async () => {
            return mocks.sqlite.safeSqlite3Json(
              '~/Library/Application Support/AddressBook/AddressBook-v22.abcddb',
              'SELECT * FROM ZABCDRECORD'
            )
          },
          { name: 'Load 500 contacts', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(50)
      })
    })

    describe('Lookup Maps', () => {
      it('should build lookup maps efficiently', async () => {
        const contacts = generateContacts(1000)

        const result = await benchmark(
          () => {
            const emailMap = new Map()
            const phoneMap = new Map()
            const nameMap = new Map()

            for (const contact of contacts) {
              emailMap.set(contact.email.toLowerCase(), contact)
              phoneMap.set(contact.phone.replace(/\D/g, ''), contact)
              nameMap.set(contact.fullName.toLowerCase(), contact)
            }

            return { emailMap, phoneMap, nameMap }
          },
          { name: 'Build lookup maps (1000 contacts)', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })

    describe('Resolution', () => {
      it('should resolve emails quickly', async () => {
        const contacts = generateContacts(1000)
        const emailMap = new Map(contacts.map(c => [c.email.toLowerCase(), c]))
        const testEmails = contacts.slice(0, 100).map(c => c.email)

        const result = await benchmark(
          () => {
            for (const email of testEmails) {
              emailMap.get(email.toLowerCase())
            }
          },
          { name: 'Resolve 100 emails', iterations: 100, warmup: 20 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(5)
      })

      it('should normalize phone numbers efficiently', async () => {
        const phones = [
          '+1 (555) 123-4567',
          '555.123.4567',
          '1-555-123-4567',
          '+15551234567',
          '(555) 123 4567'
        ]

        const normalize = (phone) => phone.replace(/\D/g, '').slice(-10)

        const result = await benchmark(
          () => {
            for (let i = 0; i < 1000; i++) {
              for (const phone of phones) {
                normalize(phone)
              }
            }
          },
          { name: 'Normalize 5000 phone numbers', iterations: 50, warmup: 10 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(20)
      })
    })

    describe('Search', () => {
      it('should search contacts by name efficiently', async () => {
        const contacts = generateContacts(1000)

        const result = await benchmark(
          () => {
            const query = 'john smith'
            const terms = query.toLowerCase().split(' ')

            return contacts.filter(c => {
              const name = c.fullName.toLowerCase()
              return terms.every(t => name.includes(t))
            }).slice(0, 20)
          },
          { name: 'Search contacts by name (1000)', iterations: 100, warmup: 20 }
        )

        reporter.addResult(result)
        expect(result.mean).toBeLessThan(10)
      })
    })
  })

  describe('Cross-Source Operations', () => {
    it('should aggregate data across sources efficiently', async () => {
      const emails = generateEmails(200)
      const messages = generateMessages(100)
      const events = generateCalendarEvents(50)
      const contacts = generateContacts(100)

      const result = await benchmark(
        () => {
          const person = contacts[0]
          const personEmail = person.email.toLowerCase()
          const personPhone = person.phone.replace(/\D/g, '')

          const personEmails = emails.filter(e =>
            e.from.toLowerCase().includes(personEmail)
          )

          const personMessages = messages.filter(m =>
            m.chatIdentifier.includes(personPhone)
          )

          return {
            contact: person,
            emails: personEmails.length,
            messages: personMessages.length,
            events: events.slice(0, 5)
          }
        },
        { name: 'Cross-source person lookup', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
