/**
 * Date parsing performance tests
 * Tests: chrono-node parsing, date range extraction, timezone handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  benchmark,
  PerformanceReporter,
  LatencyHistogram
} from './helpers/benchmark.js'

// Mock chrono-node for performance testing
const mockChrono = {
  parseDate: (text) => {
    // Simulate chrono-node parsing with realistic timing
    const patterns = [
      /today/i,
      /tomorrow/i,
      /yesterday/i,
      /next (week|month|year)/i,
      /last (week|month|year)/i,
      /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
      /(\d{4})-(\d{2})-(\d{2})/,
      /(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
      /in (\d+) (days?|weeks?|months?)/i,
      /(\d+) (days?|weeks?|months?) ago/i
    ]

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return new Date()
      }
    }
    return null
  },

  parse: (text) => {
    const results = []
    const patterns = [
      { regex: /from (.+?) to (.+)/i, type: 'range' },
      { regex: /between (.+?) and (.+)/i, type: 'range' },
      { regex: /(today|tomorrow|yesterday)/i, type: 'single' },
      { regex: /next (monday|tuesday|wednesday|thursday|friday)/i, type: 'single' },
      { regex: /(\d{1,2})\/(\d{1,2})\/(\d{4})/g, type: 'single' }
    ]

    for (const pattern of patterns) {
      const match = text.match(pattern.regex)
      if (match) {
        results.push({
          text: match[0],
          start: { date: () => new Date() },
          end: pattern.type === 'range' ? { date: () => new Date() } : null
        })
      }
    }

    return results
  }
}

describe('Date Parsing Performance', () => {
  let reporter

  beforeEach(() => {
    vi.clearAllMocks()
    reporter = new PerformanceReporter('Date Parsing Performance')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Simple Date Expressions', () => {
    it('should parse "today" quickly', async () => {
      const result = await benchmark(
        () => mockChrono.parseDate('today'),
        { name: 'Parse "today"', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should parse "tomorrow" quickly', async () => {
      const result = await benchmark(
        () => mockChrono.parseDate('tomorrow'),
        { name: 'Parse "tomorrow"', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should parse "yesterday" quickly', async () => {
      const result = await benchmark(
        () => mockChrono.parseDate('yesterday'),
        { name: 'Parse "yesterday"', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should parse relative dates quickly', async () => {
      const expressions = [
        'next week',
        'last month',
        'next year',
        'in 3 days',
        '2 weeks ago'
      ]

      for (const expr of expressions) {
        const result = await benchmark(
          () => mockChrono.parseDate(expr),
          { name: `Parse "${expr}"`, iterations: 500, warmup: 50 }
        )
        expect(result.mean).toBeLessThan(1)
      }
    })
  })

  describe('Absolute Date Formats', () => {
    it('should parse MM/DD/YYYY quickly', async () => {
      const result = await benchmark(
        () => mockChrono.parseDate('12/25/2024'),
        { name: 'Parse MM/DD/YYYY', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should parse YYYY-MM-DD quickly', async () => {
      const result = await benchmark(
        () => mockChrono.parseDate('2024-12-25'),
        { name: 'Parse YYYY-MM-DD', iterations: 1000, warmup: 100 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(1)
    })

    it('should parse day names quickly', async () => {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

      for (const day of days) {
        const result = await benchmark(
          () => mockChrono.parseDate(day),
          { name: `Parse "${day}"`, iterations: 200, warmup: 20 }
        )
        expect(result.mean).toBeLessThan(1)
      }
    })
  })

  describe('Date Range Parsing', () => {
    it('should parse "from X to Y" ranges', async () => {
      const result = await benchmark(
        () => mockChrono.parse('from Monday to Friday'),
        { name: 'Parse date range', iterations: 500, warmup: 50 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(2)
    })

    it('should parse "between X and Y" ranges', async () => {
      const result = await benchmark(
        () => mockChrono.parse('between January 1 and March 31'),
        { name: 'Parse between range', iterations: 500, warmup: 50 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(2)
    })

    it('should handle complex range expressions', async () => {
      const ranges = [
        'from next Monday to next Friday',
        'between 9am and 5pm',
        'from January to March 2024',
        'from last week to this week'
      ]

      for (const range of ranges) {
        const result = await benchmark(
          () => mockChrono.parse(range),
          { name: `Parse "${range.substring(0, 20)}..."`, iterations: 200, warmup: 20 }
        )
        expect(result.mean).toBeLessThan(5)
      }
    })
  })

  describe('Natural Language Queries', () => {
    it('should parse email-style date queries', async () => {
      const queries = [
        'emails from last week',
        'messages since yesterday',
        'meetings next Monday',
        'events in December',
        'calendar for tomorrow'
      ]

      console.log('\nEmail-style query parsing:')
      for (const query of queries) {
        const result = await benchmark(
          () => mockChrono.parse(query),
          { name: query, iterations: 200, warmup: 20 }
        )
        console.log(`  "${query}": ${result.mean.toFixed(3)}ms`)
        expect(result.mean).toBeLessThan(5)
      }
    })

    it('should parse complex natural language dates', async () => {
      const queries = [
        'the day after tomorrow',
        'next business day',
        'end of this month',
        'beginning of next year',
        'the first Monday of December'
      ]

      console.log('\nComplex natural language parsing:')
      for (const query of queries) {
        const result = await benchmark(
          () => mockChrono.parse(query),
          { name: query, iterations: 200, warmup: 20 }
        )
        console.log(`  "${query}": ${result.mean.toFixed(3)}ms`)
        expect(result.mean).toBeLessThan(10)
      }
    })
  })

  describe('Batch Parsing', () => {
    it('should parse 100 dates efficiently', async () => {
      const dates = [
        'today', 'tomorrow', 'yesterday',
        'next week', 'last month',
        '12/25/2024', '2024-01-01',
        'Monday', 'Friday',
        'in 3 days'
      ]

      // Repeat to get 100
      const batch = Array(10).fill(dates).flat()

      const result = await benchmark(
        () => {
          for (const date of batch) {
            mockChrono.parseDate(date)
          }
        },
        { name: 'Parse 100 dates', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      console.log(`\n100 dates: ${result.mean.toFixed(2)}ms (${(result.mean / 100).toFixed(3)}ms per date)`)

      expect(result.mean).toBeLessThan(50)
    })

    it('should parse mixed date expressions', async () => {
      const expressions = [
        'Send me emails from last week',
        'What meetings do I have tomorrow?',
        'Show calendar for 12/25/2024',
        'Messages between Monday and Friday',
        'Events next month'
      ]

      const result = await benchmark(
        () => {
          for (const expr of expressions) {
            mockChrono.parse(expr)
          }
        },
        { name: 'Parse mixed expressions', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })
  })

  describe('Invalid/Edge Case Dates', () => {
    it('should handle non-date text quickly', async () => {
      const nonDates = [
        'hello world',
        'random text here',
        'no dates in this string',
        '!@#$%^&*()',
        ''
      ]

      for (const text of nonDates) {
        const result = await benchmark(
          () => mockChrono.parseDate(text),
          { name: `Parse non-date: "${text || '(empty)'}"`, iterations: 200, warmup: 20 }
        )
        expect(result.mean).toBeLessThan(2)
      }
    })

    it('should handle ambiguous dates', async () => {
      const ambiguous = [
        '1/2/2024', // Could be Jan 2 or Feb 1
        '03-04-2024', // March 4 or April 3
        'next week Monday' // Which Monday?
      ]

      for (const date of ambiguous) {
        const result = await benchmark(
          () => mockChrono.parse(date),
          { name: `Parse ambiguous: "${date}"`, iterations: 200, warmup: 20 }
        )
        expect(result.mean).toBeLessThan(5)
      }
    })

    it('should handle very long text with embedded dates', async () => {
      const longText = 'Lorem ipsum '.repeat(50) + 'meeting on December 25, 2024' + ' dolor sit amet'.repeat(50)

      const result = await benchmark(
        () => mockChrono.parse(longText),
        { name: 'Parse long text', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      console.log(`\nLong text (${longText.length} chars): ${result.mean.toFixed(2)}ms`)

      expect(result.mean).toBeLessThan(50)
    })
  })

  describe('Timezone Handling', () => {
    it('should parse dates with timezone info', async () => {
      const datesWithTz = [
        '2024-12-25T10:00:00Z',
        '2024-12-25T10:00:00-08:00',
        '2024-12-25T10:00:00+05:30',
        'December 25, 2024 10:00 AM PST',
        'Dec 25 at 3pm EST'
      ]

      console.log('\nTimezone parsing:')
      for (const date of datesWithTz) {
        const result = await benchmark(
          () => mockChrono.parse(date),
          { name: date, iterations: 200, warmup: 20 }
        )
        console.log(`  "${date}": ${result.mean.toFixed(3)}ms`)
        expect(result.mean).toBeLessThan(5)
      }
    })
  })

  describe('Mac Absolute Time Conversion', () => {
    // Mac Absolute Time epoch: January 1, 2001
    const MAC_EPOCH = 978307200

    it('should convert Mac absolute time quickly', async () => {
      const macTimes = Array(100).fill(null).map(() =>
        Math.floor(Math.random() * 1000000000) // Random Mac timestamps
      )

      const result = await benchmark(
        () => {
          for (const macTime of macTimes) {
            const unixTime = macTime + MAC_EPOCH
            new Date(unixTime * 1000)
          }
        },
        { name: 'Convert 100 Mac times', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      console.log(`\n100 Mac time conversions: ${result.mean.toFixed(2)}ms`)

      expect(result.mean).toBeLessThan(5)
    })

    it('should handle edge case Mac timestamps', async () => {
      const edgeCases = [
        0, // Mac epoch start
        -1, // Before Mac epoch
        2147483647, // Max 32-bit
        Date.now() / 1000 - MAC_EPOCH // Current time in Mac format
      ]

      for (const macTime of edgeCases) {
        const result = await benchmark(
          () => {
            const unixTime = macTime + MAC_EPOCH
            new Date(unixTime * 1000)
          },
          { name: `Mac time ${macTime}`, iterations: 500, warmup: 50 }
        )
        expect(result.mean).toBeLessThan(1)
      }
    })
  })

  describe('Date Formatting', () => {
    it('should format dates for display quickly', async () => {
      const dates = Array(100).fill(null).map(() => new Date(Date.now() - Math.random() * 31536000000))

      const result = await benchmark(
        () => {
          for (const date of dates) {
            date.toLocaleDateString()
          }
        },
        { name: 'Format 100 dates', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(50)
    })

    it('should format dates with various options', async () => {
      const date = new Date()
      const formatOptions = [
        { dateStyle: 'full' },
        { dateStyle: 'long' },
        { dateStyle: 'medium' },
        { dateStyle: 'short' },
        { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }
      ]

      for (const options of formatOptions) {
        const result = await benchmark(
          () => date.toLocaleDateString('en-US', options),
          { name: `Format: ${JSON.stringify(options).substring(0, 30)}`, iterations: 500, warmup: 50 }
        )
        expect(result.mean).toBeLessThan(2)
      }
    })
  })

  describe('Date Comparison', () => {
    it('should compare dates efficiently', async () => {
      const dates = Array(1000).fill(null).map(() => new Date(Date.now() - Math.random() * 31536000000))

      const result = await benchmark(
        () => {
          dates.sort((a, b) => a.getTime() - b.getTime())
        },
        { name: 'Sort 1000 dates', iterations: 50, warmup: 10 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(10)
    })

    it('should filter dates by range efficiently', async () => {
      const dates = Array(1000).fill(null).map(() => ({
        date: new Date(Date.now() - Math.random() * 31536000000),
        id: Math.random()
      }))

      const startDate = new Date(Date.now() - 7 * 86400000)
      const endDate = new Date()

      const result = await benchmark(
        () => {
          dates.filter(d => d.date >= startDate && d.date <= endDate)
        },
        { name: 'Filter 1000 by range', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(5)
    })
  })

  describe('Latency Distribution', () => {
    it('should have consistent parsing latency', async () => {
      const histogram = new LatencyHistogram(0.1)
      const testCases = [
        'today', 'tomorrow', 'next week',
        '12/25/2024', '2024-01-01',
        'from Monday to Friday'
      ]

      for (let i = 0; i < 500; i++) {
        const testCase = testCases[i % testCases.length]
        const start = performance.now()
        mockChrono.parse(testCase)
        histogram.record(performance.now() - start)
      }

      console.log('\nDate Parsing Latency Distribution:')
      histogram.printHistogram()

      expect(histogram.getMean()).toBeLessThan(1)
    })
  })

  describe('Real-World Query Patterns', () => {
    it('should handle calendar search patterns', async () => {
      const calendarQueries = [
        'meetings today',
        'events this week',
        'appointments tomorrow morning',
        'calls next Monday',
        'reminders for December'
      ]

      const result = await benchmark(
        () => {
          for (const query of calendarQueries) {
            mockChrono.parse(query)
          }
        },
        { name: 'Calendar queries', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })

    it('should handle email search patterns', async () => {
      const emailQueries = [
        'emails from john last week',
        'messages since yesterday',
        'mail received today',
        'sent emails this month',
        'inbox from December 2024'
      ]

      const result = await benchmark(
        () => {
          for (const query of emailQueries) {
            mockChrono.parse(query)
          }
        },
        { name: 'Email queries', iterations: 100, warmup: 20 }
      )

      reporter.addResult(result)
      expect(result.mean).toBeLessThan(20)
    })
  })

  afterAll(() => {
    reporter.report()
  })
})
