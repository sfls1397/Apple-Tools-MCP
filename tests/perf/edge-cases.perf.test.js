/**
 * Edge Case Performance Tests
 * Tests: boundary conditions, data limits, unusual inputs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  getMemoryUsage
} from './helpers/benchmark.js'
import {
  generateEmails,
  generateMessages,
  generateCalendarEvents,
  generateContacts
} from './helpers/data-generators.js'
import { createPerformanceMocks } from './helpers/mocks.js'

describe('Edge Case Performance', () => {
  let mocks
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    mocks = createPerformanceMocks()
    reporter = new PerformanceReporter('Edge Case Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Data Boundaries', () => {
    it('should handle empty datasets efficiently', async () => {
      const result = await benchmark(
        async () => {
          const emails = []
          const messages = []
          const events = []

          // Process empty arrays
          const emailTexts = emails.map(e => e.subject).filter(Boolean)
          const messageTexts = messages.map(m => m.text).filter(Boolean)
          const eventTexts = events.map(e => e.title).filter(Boolean)

          return { emails: 0, messages: 0, events: 0 }
        },
        { name: 'Empty datasets', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle single item datasets', async () => {
      const singleEmail = generateEmails(1)[0]
      const singleMessage = generateMessages(1)[0]
      const singleEvent = generateCalendarEvents(1)[0]

      const result = await benchmark(
        async () => {
          await mocks.embedder.embedder([singleEmail.subject])
          await mocks.embedder.embedder([singleMessage.text])
          await mocks.embedder.embedder([singleEvent.title])
        },
        { name: 'Single item datasets', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle exactly-at-limit boundaries', async () => {
      const limits = [10, 20, 50, 100]

      for (const limit of limits) {
        const emails = generateEmails(limit)

        const result = await benchmark(
          async () => {
            const results = emails.slice(0, limit)
            expect(results.length).toBe(limit)
          },
          { name: `Exactly ${limit} items`, iterations: 50, warmup: 10 }
        )

        expect(result.mean).toBeLessThan(5)
      }
    })

    it('should handle one-over-limit efficiently', async () => {
      const limit = 100
      const emails = generateEmails(limit + 1)

      const result = await benchmark(
        async () => {
          const results = emails.slice(0, limit)
          const hasMore = emails.length > limit
          return { results, hasMore }
        },
        { name: 'One over limit', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })
  })

  describe('Content Edge Cases', () => {
    it('should handle single character content', async () => {
      const singleCharInputs = ['a', '1', '.', '!', '中', '🎉']

      const result = await benchmark(
        async () => {
          for (const char of singleCharInputs) {
            await mocks.embedder.embedder([char])
          }
        },
        { name: 'Single character content', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle very long email subjects', async () => {
      const longSubject = 'Re: Fwd: '.repeat(100) + 'Important Meeting'

      const result = await benchmark(
        async () => {
          const truncated = longSubject.substring(0, 500)
          await mocks.embedder.embedder([truncated])
        },
        { name: 'Very long subjects (1000 chars)', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle Unicode/emoji-heavy content', async () => {
      const unicodeContent = [
        '🎉🎊🎈🎁 Party time! 🎉🎊🎈🎁',
        '中文测试消息 日本語テスト',
        'مرحبا بالعالم',
        'Привет мир',
        '🇺🇸🇬🇧🇫🇷🇩🇪🇯🇵🇨🇳',
        '✨💫⭐🌟✨💫⭐🌟',
        'Ä Ö Ü ß æ ø å',
        '한국어 테스트 メッセージ'
      ]

      const result = await benchmark(
        async () => {
          for (const content of unicodeContent) {
            await mocks.embedder.embedder([content])
          }
        },
        { name: 'Unicode/emoji content', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should handle whitespace-only content', async () => {
      const whitespaceContent = [
        '   ',
        '\t\t\t',
        '\n\n\n',
        '  \t  \n  ',
        '\u00A0\u00A0\u00A0', // Non-breaking spaces
        '\u2003\u2003\u2003'  // Em spaces
      ]

      const result = await benchmark(
        async () => {
          for (const content of whitespaceContent) {
            const trimmed = content.trim()
            if (trimmed.length === 0) {
              // Skip empty content
              continue
            }
            await mocks.embedder.embedder([trimmed])
          }
        },
        { name: 'Whitespace content', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle content with only attachments (no text)', async () => {
      const messagesNoText = generateMessages(50)
      messagesNoText.forEach(m => {
        m.text = ''
        m.attachmentCount = 3
      })

      const result = await benchmark(
        async () => {
          for (const msg of messagesNoText) {
            const text = msg.text || `[${msg.attachmentCount} attachments]`
            await mocks.embedder.embedder([text])
          }
        },
        { name: 'Messages with only attachments', iterations: 10, warmup: 2 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(100)
    })

    it('should handle emails with many recipients', async () => {
      const emails = generateEmails(10)
      emails.forEach(e => {
        e.to = Array(100).fill(null).map((_, i) => `recipient${i}@example.com`).join(', ')
        e.cc = Array(50).fill(null).map((_, i) => `cc${i}@example.com`).join(', ')
      })

      const result = await benchmark(
        async () => {
          for (const email of emails) {
            const recipientCount = email.to.split(',').length + (email.cc?.split(',').length || 0)
            await mocks.embedder.embedder([email.subject])
          }
        },
        { name: 'Emails with 150 recipients', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Date/Time Edge Cases', () => {
    it('should handle epoch boundary dates', async () => {
      const epochDates = [
        new Date(0),                         // Unix epoch (1970)
        new Date(978307200000),              // Mac epoch (2001)
        new Date(2147483647000),             // 32-bit overflow (2038)
        new Date('1969-12-31T23:59:59Z'),    // Just before Unix epoch
        new Date('2001-01-01T00:00:00Z'),    // Mac epoch exactly
      ]

      const result = await benchmark(
        async () => {
          for (const date of epochDates) {
            const timestamp = date.getTime()
            const iso = date.toISOString()
            const formatted = date.toLocaleDateString()
          }
        },
        { name: 'Epoch boundary dates', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle far future dates', async () => {
      const futureDates = [
        new Date('2099-12-31'),
        new Date('2050-06-15'),
        new Date('3000-01-01'),
      ]

      const result = await benchmark(
        async () => {
          for (const date of futureDates) {
            const timestamp = date.getTime()
            if (timestamp > Date.now()) {
              // Future date handling
            }
          }
        },
        { name: 'Far future dates', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle far past dates', async () => {
      const pastDates = [
        new Date('1990-01-01'),
        new Date('1980-06-15'),
        new Date('1970-01-02'),
      ]

      const result = await benchmark(
        async () => {
          for (const date of pastDates) {
            const timestamp = date.getTime()
            const age = Date.now() - timestamp
            const years = Math.floor(age / (365.25 * 24 * 60 * 60 * 1000))
          }
        },
        { name: 'Far past dates', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle DST transition dates', async () => {
      // US DST transitions (approximate - varies by year)
      const dstDates = [
        new Date('2024-03-10T02:30:00'),  // Spring forward
        new Date('2024-11-03T01:30:00'),  // Fall back
        new Date('2024-03-10T01:59:59'),  // Just before
        new Date('2024-03-10T03:00:01'),  // Just after
      ]

      const result = await benchmark(
        async () => {
          for (const date of dstDates) {
            const offset = date.getTimezoneOffset()
            const local = date.toLocaleString()
            const utc = date.toISOString()
          }
        },
        { name: 'DST transition dates', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle timezone extremes', async () => {
      const timezones = [
        'Pacific/Kiritimati',  // UTC+14
        'Pacific/Midway',      // UTC-11
        'UTC',
        'America/New_York',
        'Asia/Tokyo',
      ]

      const result = await benchmark(
        async () => {
          const now = new Date()
          for (const tz of timezones) {
            try {
              const formatted = now.toLocaleString('en-US', { timeZone: tz })
            } catch (e) {
              // Timezone not supported
            }
          }
        },
        { name: 'Timezone extremes', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle leap year dates', async () => {
      const leapDates = [
        new Date('2024-02-29'),  // Leap year
        new Date('2000-02-29'),  // Century leap year
        new Date('2100-02-28'),  // Not a leap year (century rule)
      ]

      const result = await benchmark(
        async () => {
          for (const date of leapDates) {
            const isLeapYear = (year) =>
              (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0)
            const year = date.getFullYear()
            const leap = isLeapYear(year)
          }
        },
        { name: 'Leap year dates', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })
  })

  describe('Search Edge Cases', () => {
    it('should handle query matching zero results', async () => {
      const emails = generateEmails(100)

      const result = await benchmark(
        async () => {
          const query = 'xyznonexistentquery123'
          const results = emails.filter(e =>
            e.subject.includes(query) || e.body.includes(query)
          )
          expect(results.length).toBe(0)
          return { results: [], message: 'No results found' }
        },
        { name: 'Zero results query', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle query matching all results', async () => {
      const emails = generateEmails(100)
      // Add common word to all
      emails.forEach(e => e.subject = 'meeting ' + e.subject)

      const result = await benchmark(
        async () => {
          const query = 'meeting'
          const results = emails.filter(e => e.subject.includes(query))
          expect(results.length).toBe(100)
          return results.slice(0, 20)
        },
        { name: 'All results match', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle stop-word-only queries', async () => {
      const stopWordQueries = [
        'the',
        'a an the',
        'is are was were',
        'to from for with',
        'and or but'
      ]

      const result = await benchmark(
        async () => {
          for (const query of stopWordQueries) {
            // Stop words should still be processed
            await mocks.embedder.embedder([query])
          }
        },
        { name: 'Stop-word queries', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should handle negation-only queries', async () => {
      const negationQueries = [
        '-meeting',
        'NOT budget',
        '-important -urgent',
        'NOT project NOT deadline',
        'without attachments'
      ]

      const result = await benchmark(
        async () => {
          for (const query of negationQueries) {
            const isNegation = query.startsWith('-') ||
                               query.startsWith('NOT ') ||
                               query.includes('without')
            // Process negation
          }
        },
        { name: 'Negation-only queries', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle queries with regex special characters', async () => {
      const regexQueries = [
        'file.txt',
        'price: $100',
        'ratio (1:1)',
        'path/to/file',
        'version 2.0.0',
        '[URGENT]',
        'email@domain.com',
        'C++ programming',
        'question? answer!',
        'price >= $50'
      ]

      const result = await benchmark(
        async () => {
          for (const query of regexQueries) {
            // Escape regex special chars
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            await mocks.embedder.embedder([query])
          }
        },
        { name: 'Regex special char queries', iterations: 20, warmup: 5 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })
  })

  describe('Threading Edge Cases', () => {
    it('should handle very deep email threads', async () => {
      const threadDepth = 100
      const emails = []

      for (let i = 0; i < threadDepth; i++) {
        emails.push({
          id: i,
          subject: 'Re: '.repeat(i) + 'Original Subject',
          messageId: `<msg${i}@example.com>`,
          inReplyTo: i > 0 ? `<msg${i - 1}@example.com>` : null
        })
      }

      const result = await benchmark(
        async () => {
          // Build thread tree
          const threadMap = new Map()
          for (const email of emails) {
            threadMap.set(email.messageId, email)
          }

          // Find root
          let current = emails[emails.length - 1]
          let depth = 0
          while (current.inReplyTo && threadMap.has(current.inReplyTo)) {
            current = threadMap.get(current.inReplyTo)
            depth++
          }

          return { depth, root: current }
        },
        { name: 'Thread depth 100', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should handle orphaned thread messages', async () => {
      const emails = generateEmails(50)
      // Create orphans (reference non-existent parents)
      emails.forEach((e, i) => {
        if (i % 5 === 0) {
          e.inReplyTo = '<nonexistent@example.com>'
        }
      })

      const result = await benchmark(
        async () => {
          const orphans = emails.filter(e =>
            e.inReplyTo && !emails.some(other =>
              other.messageId === e.inReplyTo
            )
          )
          return { orphans: orphans.length }
        },
        { name: 'Orphaned thread detection', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Contact Edge Cases', () => {
    it('should handle contacts with many email addresses', async () => {
      const contacts = generateContacts(10)
      contacts.forEach(c => {
        c.emails = Array(10).fill(null).map((_, i) =>
          `${c.firstName.toLowerCase()}${i}@example.com`
        )
      })

      const result = await benchmark(
        async () => {
          for (const contact of contacts) {
            for (const email of contact.emails) {
              // Look up by each email
            }
          }
        },
        { name: 'Contacts with 10 emails', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle international phone formats', async () => {
      const internationalPhones = [
        '+1 (555) 123-4567',
        '+44 20 7946 0958',
        '+81 3-1234-5678',
        '+86 10 1234 5678',
        '+49 30 123456',
        '+33 1 23 45 67 89',
        '+7 495 123-45-67',
        '+91 11 2345 6789',
        '+55 11 1234-5678',
        '+61 2 1234 5678'
      ]

      const normalizePhone = (phone) => {
        return phone.replace(/\D/g, '').slice(-10)
      }

      const result = await benchmark(
        async () => {
          for (const phone of internationalPhones) {
            const normalized = normalizePhone(phone)
          }
        },
        { name: 'International phone normalization', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle names with special characters', async () => {
      const specialNames = [
        "O'Brien",
        'María García',
        '김철수',
        'Müller',
        'Jean-Pierre',
        'Sr. José',
        'Dr. Smith Jr.',
        'Anne-Marie O\'Donnell',
        '山田太郎',
        'محمد علي'
      ]

      const result = await benchmark(
        async () => {
          for (const name of specialNames) {
            const normalized = name.toLowerCase()
            const searchable = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          }
        },
        { name: 'Special character names', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })
  })

  describe('Calendar Edge Cases', () => {
    it('should handle all-day events spanning multiple days', async () => {
      const multiDayEvents = Array(10).fill(null).map((_, i) => ({
        id: i,
        title: `Multi-day event ${i}`,
        isAllDay: true,
        startTimestamp: Date.now(),
        endTimestamp: Date.now() + (i + 1) * 24 * 60 * 60 * 1000  // 1-10 days
      }))

      const result = await benchmark(
        async () => {
          for (const event of multiDayEvents) {
            const days = Math.ceil(
              (event.endTimestamp - event.startTimestamp) / (24 * 60 * 60 * 1000)
            )
            // Expand to individual day occurrences
            for (let d = 0; d < days; d++) {
              const dayStart = event.startTimestamp + d * 24 * 60 * 60 * 1000
            }
          }
        },
        { name: 'Multi-day all-day events', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle recurring events with many exceptions', async () => {
      const recurringEvent = {
        id: 1,
        title: 'Weekly Meeting',
        recurrence: 'weekly',
        exceptions: Array(50).fill(null).map((_, i) => ({
          date: new Date(Date.now() + i * 7 * 24 * 60 * 60 * 1000),
          action: i % 3 === 0 ? 'cancelled' : 'modified'
        }))
      }

      const result = await benchmark(
        async () => {
          const exceptionMap = new Map(
            recurringEvent.exceptions.map(e => [e.date.toISOString(), e])
          )

          // Generate 52 weeks of occurrences
          const occurrences = []
          for (let w = 0; w < 52; w++) {
            const date = new Date(Date.now() + w * 7 * 24 * 60 * 60 * 1000)
            const exception = exceptionMap.get(date.toISOString())
            if (!exception || exception.action !== 'cancelled') {
              occurrences.push({ date, exception })
            }
          }

          return occurrences
        },
        { name: 'Recurring with 50 exceptions', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })

    it('should handle overlapping events', async () => {
      const now = Date.now()
      const events = Array(20).fill(null).map((_, i) => ({
        id: i,
        startTimestamp: now + (i % 5) * 30 * 60 * 1000,  // Staggered starts
        endTimestamp: now + ((i % 5) + 2) * 30 * 60 * 1000  // 1-hour events
      }))

      const result = await benchmark(
        async () => {
          // Find overlapping events
          const overlaps = []
          for (let i = 0; i < events.length; i++) {
            for (let j = i + 1; j < events.length; j++) {
              const a = events[i]
              const b = events[j]
              if (a.startTimestamp < b.endTimestamp && b.startTimestamp < a.endTimestamp) {
                overlaps.push([a.id, b.id])
              }
            }
          }
          return overlaps
        },
        { name: 'Detect overlapping events', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Result Edge Cases', () => {
    it('should handle duplicate results efficiently', async () => {
      const emails = generateEmails(50)
      // Create duplicates
      const withDuplicates = [...emails, ...emails.slice(0, 25)]

      const result = await benchmark(
        async () => {
          const seen = new Set()
          const unique = withDuplicates.filter(e => {
            if (seen.has(e.id)) return false
            seen.add(e.id)
            return true
          })
          return unique
        },
        { name: 'Deduplicate results', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should handle results with missing fields', async () => {
      const emails = generateEmails(50)
      // Remove random fields
      emails.forEach((e, i) => {
        if (i % 3 === 0) delete e.subject
        if (i % 4 === 0) delete e.from
        if (i % 5 === 0) delete e.date
      })

      const result = await benchmark(
        async () => {
          return emails.map(e => ({
            subject: e.subject || '(No subject)',
            from: e.from || '(Unknown sender)',
            date: e.date || new Date().toISOString()
          }))
        },
        { name: 'Handle missing fields', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
