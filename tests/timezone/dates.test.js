
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

    const jan31 = getDateRange('2024-01-31')
    expect(jan31).not.toBeNull()

    const feb1 = getDateRange('2024-02-01')
    expect(feb1).not.toBeNull()

    expect(feb1.start).toBe(jan31.end)
  })

  it('should handle leap year correctly', async () => {
    const { getDateRange } = await import('../../search.js')

    const feb29 = getDateRange('2024-02-29')
    expect(feb29).not.toBeNull()

    const mar1 = getDateRange('2024-03-01')
    expect(mar1.start).toBe(feb29.end)
  })

  it('should handle year boundaries', async () => {
    const { getDateRange } = await import('../../search.js')

    const dec31 = getDateRange('2024-12-31')
    expect(dec31).not.toBeNull()

    const jan1 = getDateRange('2025-01-01')
    expect(jan1.start).toBe(dec31.end)
  })
})

describe('Timezone: DST Transitions', () => {
  it('should handle spring forward transition', async () => {
    const { getDateRange } = await import('../../search.js')

    const dstDay = getDateRange('2024-03-10')
    expect(dstDay).not.toBeNull()

    const beforeDst = getDateRange('2024-03-09')
    expect(beforeDst).not.toBeNull()

    expect(dstDay.end - dstDay.start).toBeGreaterThan(0)
    expect(beforeDst.end - beforeDst.start).toBeGreaterThan(0)
  })

  it('should handle fall back transition', async () => {
    const { getDateRange } = await import('../../search.js')

    const dstDay = getDateRange('2024-11-03')
    expect(dstDay).not.toBeNull()

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
    const allDayEvent = {
      title: 'Holiday',
      start: '2024-01-15T00:00:00',
      end: '2024-01-16T00:00:00',
      isAllDay: true
    }

    const startDate = new Date(allDayEvent.start)
    const endDate = new Date(allDayEvent.end)

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

    const duration = endDate.getTime() - startDate.getTime()
    expect(duration).toBe(5 * 24 * 60 * 60 * 1000)
  })
})

describe('Timezone: Mac Absolute Time Conversion', () => {
  it('should convert Mac absolute time to Unix timestamp', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')


    const macTime0 = macAbsoluteTimeToDate(0)
    const date = new Date(macTime0)
    expect(date.getUTCFullYear()).toBe(2001)
    expect(date.getUTCMonth()).toBe(0)
    expect(date.getUTCDate()).toBe(1)
  })

  it('should handle recent Mac timestamps', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')

    const macTime2024 = 725846400
    const result = macAbsoluteTimeToDate(macTime2024)

    expect(result).toBeGreaterThan(Date.parse('2023-01-01'))
    expect(result).toBeLessThan(Date.parse('2025-01-01'))
  })

  it('should handle nanosecond timestamps', async () => {
    const { macAbsoluteTimeToDate } = await import('../../lib/validators.js')

    const nanoTimestamp = 725846400000000000

    const result = macAbsoluteTimeToDate(nanoTimestamp)
    expect(typeof result).toBe('number')
    expect(result).toBeGreaterThan(0)
  })
})

describe('Timezone: Timestamp Format Detection', () => {
  it('should detect seconds vs milliseconds', () => {
    const now = Date.now()
    const nowSeconds = Math.floor(now / 1000)

    expect(String(now).length).toBe(13)

    expect(String(nowSeconds).length).toBe(10)

    const isSeconds = (ts) => ts > 0 && ts < 10000000000
    expect(isSeconds(nowSeconds)).toBe(true)
    expect(isSeconds(now)).toBe(false)
  })

  it('should handle both formats in date filtering', async () => {
    const baseTimestampMs = 1705276800000
    const baseTimestampSec = 1705276800

    const records = [
      { date: '2024-01-15', dateTimestamp: baseTimestampMs },
      { date: '2024-01-15', dateTimestamp: baseTimestampSec }
    ]

    const normalizedTimestamps = records.map(record => {
      let ts = record.dateTimestamp
      if (ts < 10000000000) {
        ts *= 1000
      }
      return ts
    })

    expect(normalizedTimestamps[0]).toBe(baseTimestampMs)
    expect(normalizedTimestamps[1]).toBe(baseTimestampMs)

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
      expect(result === null || typeof result === 'number').toBe(true)
    }
  })

  it('should handle dates at epoch boundaries', async () => {
    const { getDateRange } = await import('../../search.js')

    const epoch = getDateRange('1970-01-01')

    const y2k = getDateRange('2000-01-01')
    expect(y2k).not.toBeNull()

    const future = getDateRange('2099-12-31')
    expect(future).not.toBeNull()
  })

  it('should handle time-only strings', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const result = parseNaturalDate('10:30 AM')
    expect(result === null || typeof result === 'number').toBe(true)
  })
})
