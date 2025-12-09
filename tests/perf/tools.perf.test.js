/**
 * Performance tests for MCP tool operations
 * Tests: individual tools, tool dispatch, concurrent tool calls
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram,
  calculateThroughput
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateContacts,
  generateSearchQueries
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Tool Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Tool Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Email Tools', () => {
    it('mail_search should complete within 100ms', async () => {
      const result = await benchmark(
        async () => {
          // Simulate mail_search tool
          await mocks.embedder.embedder(['search query'])
          const results = generateEmails(20)
          return results
        },
        { name: 'mail_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('mail_recent should complete within 50ms', async () => {
      const emails = generateEmails(50)

      const result = await benchmark(
        async () => {
          // Simulate mail_recent - no embedding needed
          return emails.slice(0, 20)
        },
        { name: 'mail_recent', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })

    it('mail_read should complete within 30ms', async () => {
      const emailContent = generateEmails(1)[0]

      const result = await benchmark(
        async () => {
          // Simulate reading email file
          return emailContent
        },
        { name: 'mail_read', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(30)
    })

    it('mail_thread should complete within 100ms', async () => {
      const emails = generateEmails(20)

      const result = await benchmark(
        async () => {
          // Simulate thread retrieval
          await mocks.embedder.embedder(['thread subject'])
          return emails
        },
        { name: 'mail_thread', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('mail_senders should complete within 50ms', async () => {
      const emails = generateEmails(100)

      const result = await benchmark(
        async () => {
          // Aggregate senders
          const senders = new Map()
          for (const email of emails) {
            const count = senders.get(email.from) || 0
            senders.set(email.from, count + 1)
          }
          return [...senders.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
        },
        { name: 'mail_senders', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })
  })

  describe('Message Tools', () => {
    it('messages_search should complete within 100ms', async () => {
      const result = await benchmark(
        async () => {
          await mocks.embedder.embedder(['search query'])
          return generateMessages(20)
        },
        { name: 'messages_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('messages_recent should complete within 50ms', async () => {
      const messages = generateMessages(50)

      const result = await benchmark(
        async () => {
          return messages.slice(0, 20)
        },
        { name: 'messages_recent', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })

    it('messages_conversation should complete within 80ms', async () => {
      const messages = generateMessages(100)
      const targetContact = '+15551234567'

      const result = await benchmark(
        async () => {
          // Filter by contact
          return messages.filter(m =>
            m.sender === targetContact || m.chatIdentifier === targetContact
          ).slice(0, 50)
        },
        { name: 'messages_conversation', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(80)
    })

    it('messages_contacts should complete within 50ms', async () => {
      const messages = generateMessages(200)

      const result = await benchmark(
        async () => {
          // Aggregate unique contacts
          const contacts = new Map()
          for (const msg of messages) {
            if (!contacts.has(msg.chatIdentifier)) {
              contacts.set(msg.chatIdentifier, {
                identifier: msg.chatIdentifier,
                name: msg.chatName,
                lastMessage: msg.timestamp
              })
            }
          }
          return [...contacts.values()].slice(0, 50)
        },
        { name: 'messages_contacts', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })
  })

  describe('Calendar Tools', () => {
    it('calendar_search should complete within 100ms', async () => {
      const result = await benchmark(
        async () => {
          await mocks.embedder.embedder(['search query'])
          return generateCalendarEvents(20)
        },
        { name: 'calendar_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('calendar_date should complete within 50ms', async () => {
      const events = generateCalendarEvents(100)
      const targetDate = new Date()

      const result = await benchmark(
        async () => {
          const dayStart = new Date(targetDate).setHours(0, 0, 0, 0)
          const dayEnd = new Date(targetDate).setHours(23, 59, 59, 999)

          return events.filter(e =>
            e.startTimestamp >= dayStart && e.startTimestamp <= dayEnd
          )
        },
        { name: 'calendar_date', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })

    it('calendar_upcoming should complete within 30ms', async () => {
      const events = generateCalendarEvents(50)
      const now = Date.now()

      const result = await benchmark(
        async () => {
          return events
            .filter(e => e.startTimestamp > now)
            .sort((a, b) => a.startTimestamp - b.startTimestamp)
            .slice(0, 10)
        },
        { name: 'calendar_upcoming', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(30)
    })

    it('calendar_free_time should complete within 100ms', async () => {
      const events = generateCalendarEvents(50)

      const result = await benchmark(
        async () => {
          // Simulate free time calculation
          const workStart = 9 * 60 // 9 AM in minutes
          const workEnd = 17 * 60 // 5 PM in minutes
          const slots = []

          // Find gaps between events
          for (let i = 0; i < events.length - 1; i++) {
            const gap = events[i + 1].startTimestamp - events[i].endTimestamp
            if (gap > 30 * 60 * 1000) { // 30+ minute gap
              slots.push({
                start: events[i].endTimestamp,
                end: events[i + 1].startTimestamp,
                duration: gap
              })
            }
          }

          return slots.slice(0, 10)
        },
        { name: 'calendar_free_time', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('calendar_week should complete within 50ms', async () => {
      const events = generateCalendarEvents(100)
      const now = Date.now()
      const weekMs = 7 * 24 * 60 * 60 * 1000

      const result = await benchmark(
        async () => {
          return events.filter(e =>
            e.startTimestamp >= now && e.startTimestamp <= now + weekMs
          ).sort((a, b) => a.startTimestamp - b.startTimestamp)
        },
        { name: 'calendar_week', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })
  })

  describe('Contact Tools', () => {
    it('contacts_search should complete within 50ms', async () => {
      const contacts = generateContacts(500)

      const result = await benchmark(
        async () => {
          const query = 'john smith'
          const terms = query.toLowerCase().split(' ')

          return contacts.filter(c => {
            const text = `${c.fullName} ${c.email} ${c.company}`.toLowerCase()
            return terms.every(t => text.includes(t))
          }).slice(0, 20)
        },
        { name: 'contacts_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(50)
    })

    it('contacts_lookup should complete within 20ms', async () => {
      const contacts = generateContacts(500)
      const contactMap = new Map(contacts.map(c => [c.email, c]))

      const result = await benchmark(
        async () => {
          return contactMap.get('john.smith10@example.com')
        },
        { name: 'contacts_lookup', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(20)
    })

    it('person_search should complete within 200ms', async () => {
      const contacts = generateContacts(100)
      const emails = generateEmails(200)
      const messages = generateMessages(100)
      const events = generateCalendarEvents(50)

      const result = await benchmark(
        async () => {
          const person = contacts[0]

          // Search across all sources
          const [personEmails, personMessages, personEvents] = await Promise.all([
            Promise.resolve(emails.filter(e => e.from.includes(person.email))),
            Promise.resolve(messages.filter(m => m.chatIdentifier.includes(person.phone))),
            Promise.resolve(events) // Calendar doesn't have direct person link
          ])

          return {
            person,
            emails: personEmails.slice(0, 10),
            messages: personMessages.slice(0, 10),
            events: personEvents.slice(0, 5)
          }
        },
        { name: 'person_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(200)
    })
  })

  describe('Smart Search Tool', () => {
    it('smart_search should complete within 150ms', async () => {
      const result = await benchmark(
        async () => {
          // Smart search queries all sources
          await mocks.embedder.embedder(['smart search query'])

          // Parallel source searches
          const [emailResults, messageResults, calendarResults] = await Promise.all([
            Promise.resolve(generateEmails(10)),
            Promise.resolve(generateMessages(10)),
            Promise.resolve(generateCalendarEvents(5))
          ])

          // Merge and rank
          return {
            emails: emailResults,
            messages: messageResults,
            calendar: calendarResults
          }
        },
        { name: 'smart_search', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(150)
    })
  })

  describe('Tool Dispatch', () => {
    it('should dispatch tools with minimal overhead', async () => {
      const tools = [
        'mail_search', 'mail_recent', 'mail_read',
        'messages_search', 'messages_recent',
        'calendar_search', 'calendar_upcoming',
        'contacts_search'
      ]

      const toolHandlers = new Map(tools.map(t => [t, async () => ({ result: t })]))

      const result = await benchmark(
        async () => {
          for (const tool of tools) {
            const handler = toolHandlers.get(tool)
            if (handler) await handler()
          }
        },
        { name: 'Tool dispatch (8 tools)', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10) // Dispatch should be very fast
    })
  })

  describe('Concurrent Tool Execution', () => {
    it('should handle 5 concurrent tool calls', async () => {
      const result = await benchmark(
        async () => {
          await Promise.all([
            mocks.embedder.embedder(['query1']),
            mocks.embedder.embedder(['query2']),
            mocks.embedder.embedder(['query3']),
            mocks.embedder.embedder(['query4']),
            mocks.embedder.embedder(['query5'])
          ])
        },
        { name: '5 concurrent tool calls', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(100)
    })

    it('should handle 10 sequential tool calls', async () => {
      const result = await benchmark(
        async () => {
          for (let i = 0; i < 10; i++) {
            await mocks.embedder.embedder([`query${i}`])
          }
        },
        { name: '10 sequential tool calls', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.p95).toBeLessThan(200)
    })
  })

  describe('Tool Response Formatting', () => {
    it('should format responses quickly', async () => {
      const emails = generateEmails(50)

      const formatEmailResults = (emails) => {
        const header = `Found ${emails.length} emails\n\n`
        const formatted = emails.map(e =>
          `**From:** ${e.from}\n**Subject:** ${e.subject}\n**Date:** ${e.date}\n`
        ).join('\n---\n')
        return header + formatted
      }

      const result = await benchmark(
        () => formatEmailResults(emails),
        { name: 'Format 50 email results', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
