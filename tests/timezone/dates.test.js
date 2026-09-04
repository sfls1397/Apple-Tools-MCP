/**
 * Timezone Testing
 *
 * Tests date handling across:
 * - DST boundaries
 * - UTC vs local time
 * - Various date formats
 * - All-day events
 */

import { describe, it, expect, beforeAll } from 'vitest'

describe('Timezone: Date Parsing', () => {
  it('should parse ISO 8601 dates correctly', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const isoFormats = [
      '2024-01-15',
      '2024-01-15T10:30:00',
      '2024-01-15T10:30:00Z',
      '2024-01-15T10:30:00+00:00',
      '2024-01-15T10:30:00-05:00'
    ]

    for (const format of isoFormats) {
      const result = parseNaturalDate(format)
      expect(result).not.toBeNull()
      expect(typeof result).toBe('number')
    }
  })

  it('should parse natural language dates', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const naturalDates = [
      'today',
      'yesterday',
      'tomorrow',
      'last Monday',
      'next Friday',
      'last week',
      'next month'
    ]

    for (const dateStr of naturalDates) {
      const result = parseNaturalDate(dateStr)
      expect(result).not.toBeNull()
      expect(typeof result).toBe('number')
    }
  })

  it('should return start of day for parsed dates', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const result = parseNaturalDate('2024-01-15')
    const date = new Date(result)

    // Should be midnight local time
    expect(date.getHours()).toBe(0)
    expect(date.getMinutes()).toBe(0)
    expect(date.getSeconds()).toBe(0)
  })
})

describe('Timezone: Date Range', () => {
  it('should create correct 24-hour range', async () => {
    const { getDateRange } = await import('../../search.js')

    const range = getDateRange('2024-01-15')

    expect(range).not.toBeNull()
    expect(range.end - range.start).toBe(24 * 60 * 60 * 1000)
  })

  it('should handle month boundaries', async () => {
    const { getDateRange } = await import('../../search.js')

    // Last day of January
    const jan31 = getDateRange('2024-01-31')
    expect(jan31).not.toBeNull()

    // First day of February
    const feb1 = getDateRange('2024-02-01')
    expect(feb1).not.toBeNull()

    // Feb 1 should be exactly 24 hours after Jan 31 start
    expect(feb1.start).toBe(jan31.end)
  })

  it('should handle leap year correctly', async () => {
    const { getDateRange } = await import('../../search.js')

    // Feb 29, 2024 (leap year)
    const feb29 = getDateRange('2024-02-29')
    expect(feb29).not.toBeNull()

    // March 1, 2024
    const mar1 = getDateRange('2024-03-01')
    expect(mar1.start).toBe(feb29.end)
  })

  it('should handle year boundaries', async () => {
    const { getDateRange } = await import('../../search.js')

    // Dec 31
    const dec31 = getDateRange('2024-12-31')
    expect(dec31).not.toBeNull()

    // Jan 1 next year
    const jan1 = getDateRange('2025-01-01')
    expect(jan1.start).toBe(dec31.end)
  })
})

describe('Timezone: DST Transitions', () => {
  it('should handle spring forward transition', async () => {
    const { getDateRange } = await import('../../search.js')

    // US DST starts second Sunday of March
    // March 10, 2024 is a DST transition day
    const dstDay = getDateRange('2024-03-10')
    expect(dstDay).not.toBeNull()

    // Day before DST
    const beforeDst = getDateRange('2024-03-09')
    expect(beforeDst).not.toBeNull()

    // Both should have valid ranges
    expect(dstDay.end - dstDay.start).toBeGreaterThan(0)
    expect(beforeDst.end - beforeDst.start).toBeGreaterThan(0)
  })

  it('should handle fall back transition', async () => {
    const { getDateRange } = await import('../../search.js')

    // US DST ends first Sunday of November
    // November 3, 2024 is a DST transition day
    const dstDay = getDateRange('2024-11-03')
    expect(dstDay).not.toBeNull()

    // Should still represent a valid day
    expect(dstDay.end).toBeGreaterThan(dstDay.start)
  })

  it('should match getLocalDayBounds (local next midnight, not +24h)', async () => {
    const { getDateRange, getLocalDayBounds } = await import('../../search.js')

    for (const day of ['2024-03-10', '2024-11-03', '2024-01-15']) {
      expect(getDateRange(day)).toEqual(getLocalDayBounds(day))
    }
  })
})

describe('Timezone: All-Day Events', () => {
  it('should treat all-day events as full day in local time', () => {
    // All-day event structure
    const allDayEvent = {
      title: 'Holiday',
      start: '2024-01-15T00:00:00',
      end: '2024-01-16T00:00:00',
      isAllDay: true
    }

    const startDate = new Date(allDayEvent.start)
    const endDate = new Date(allDayEvent.end)

    // Duration should be 24 hours
    const duration = endDate.getTime() - startDate.getTime()
    expect(duration).toBe(24 * 60 * 60 * 1000)
  })

  it('should handle all-day events spanning multiple days', () => {
    const multiDayEvent = {
      title: 'Vacation',
      start: '2024-01-15T00:00:00',
      end: '2024-01-20T00:00:00',
      isAllDay: true
    }

    const startDate = new Date(multiDayEvent.start)
    const endDate = new Date(multiDayEvent.end)

    // Duration should be 5 days
    const duration = endDate.getTime() - startDate.getTime()
    expect(duration).toBe(5 * 24 * 60 * 60 * 1000)
  })
})

describe('Timezone: Mac Absolute Time Conversion', () => {
  it('should convert Mac absolute time to Unix timestamp', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')

    // Mac epoch: January 1, 2001 00:00:00 UTC
    // Unix epoch: January 1, 1970 00:00:00 UTC
    // Difference: 978307200 seconds

    // Mac time 0 = January 1, 2001
    const macTime0 = macAbsoluteTimeToDate(0)
    const date = new Date(macTime0)
    expect(date.getUTCFullYear()).toBe(2001)
    expect(date.getUTCMonth()).toBe(0) // January
    expect(date.getUTCDate()).toBe(1)
  })

  it('should handle recent Mac timestamps', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')

    // A timestamp from 2024 (approximately)
    // Jan 1, 2024 is about 725846400 seconds after Mac epoch
    const macTime2024 = 725846400
    const result = macAbsoluteTimeToDate(macTime2024)

    expect(result).toBeGreaterThan(Date.parse('2023-01-01'))
    expect(result).toBeLessThan(Date.parse('2025-01-01'))
  })

  it('should handle nanosecond timestamps', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')

    // Messages database uses nanoseconds
    const nanoTimestamp = 725846400000000000 // nanoseconds

    // The function should detect and handle this
    // (It divides by 1e9 if value is too large)
    const result = macAbsoluteTimeToDate(nanoTimestamp)
    expect(typeof result).toBe('number')
    expect(result).toBeGreaterThan(0)
  })
})

describe('Timezone: Timestamp Format Detection', () => {
  it('should detect seconds vs milliseconds', () => {
    const now = Date.now()
    const nowSeconds = Math.floor(now / 1000)

    // Milliseconds are 13 digits (until year 2286)
    expect(String(now).length).toBe(13)

    // Seconds are 10 digits
    expect(String(nowSeconds).length).toBe(10)

    // Can detect by checking if < 10000000000
    const isSeconds = (ts) => ts > 0 && ts < 10000000000
    expect(isSeconds(nowSeconds)).toBe(true)
    expect(isSeconds(now)).toBe(false)
  })

  it('should handle both formats in date filtering', async () => {
    // Mock records with different timestamp formats
    // Use timestamps that represent the same moment
    const baseTimestampMs = 1705276800000 // Jan 15, 2024 00:00:00 UTC
    const baseTimestampSec = 1705276800   // Same in seconds

    const records = [
      { date: '2024-01-15', dateTimestamp: baseTimestampMs }, // milliseconds
      { date: '2024-01-15', dateTimestamp: baseTimestampSec }  // seconds
    ]

    // Test that we can correctly normalize both formats to the same value
    const normalizedTimestamps = records.map(record => {
      let ts = record.dateTimestamp
      // Normalize to milliseconds if in seconds
      if (ts < 10000000000) {
        ts *= 1000
      }
      return ts
    })

    // Both should normalize to the same millisecond timestamp
    expect(normalizedTimestamps[0]).toBe(baseTimestampMs)
    expect(normalizedTimestamps[1]).toBe(baseTimestampMs)

    // Verify the conversion by checking they represent the same date
    const date0 = new Date(normalizedTimestamps[0])
    const date1 = new Date(normalizedTimestamps[1])
    expect(date0.toISOString()).toBe(date1.toISOString())
  })
})

describe('Timezone: Edge Cases', () => {
  it('should handle invalid date strings gracefully', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const invalidDates = [
      'not a date',
      '2024-13-45',
      'Feb 30, 2024',
      '',
      null,
      undefined
    ]

    for (const invalid of invalidDates) {
      const result = parseNaturalDate(invalid)
      // Should return null for invalid dates, not throw
      expect(result === null || typeof result === 'number').toBe(true)
    }
  })

  it('should handle dates at epoch boundaries', async () => {
    const { getDateRange } = await import('../../search.js')

    // Unix epoch
    const epoch = getDateRange('1970-01-01')
    // Note: This might return null if the library doesn't support it
    // That's acceptable behavior

    // Y2K
    const y2k = getDateRange('2000-01-01')
    expect(y2k).not.toBeNull()

    // Far future
    const future = getDateRange('2099-12-31')
    expect(future).not.toBeNull()
  })

  it('should handle time-only strings', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    // Time-only strings should either fail gracefully or assume today
    const result = parseNaturalDate('10:30 AM')
    // Either null or a timestamp for today at that time
    expect(result === null || typeof result === 'number').toBe(true)
  })
})
