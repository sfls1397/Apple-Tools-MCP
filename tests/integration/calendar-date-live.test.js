/**
 * Live calendar_date: OccurrenceCache per occurrence, /tmp copy, local TZ bounds.
 * Does not use the vector index. Skips live sqlite when Calendar.sqlitedb is missing.
 */

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  buildEventsOnDateQuery,
  localDayToMacBounds,
  getEventsOnDate,
  CALENDAR_TMP_PREFIX
} from '../../indexer.js'
import {
  getLocalDayBounds,
  getCalendarDateResults,
  clampBusyToLocalDay
} from '../../search.js'

const MAC_ABSOLUTE_EPOCH = 978307200
const CALENDAR_DB = path.join(
  process.env.HOME,
  'Library',
  'Group Containers',
  'group.com.apple.calendar',
  'Calendar.sqlitedb'
)
const calendarExists = fs.existsSync(CALENDAR_DB)

function tmpCalendarCopies() {
  return fs.readdirSync('/tmp').filter(
    (name) => name.startsWith(CALENDAR_TMP_PREFIX)
  )
}

describe('calendar_date live query SQL', () => {
  it('does not GROUP BY ci.ROWID', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).not.toMatch(/GROUP\s+BY\s+ci\.ROWID/i)
    expect(sql).not.toMatch(/GROUP\s+BY/i)
  })

  it('filters OccurrenceCache.day to the day range', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toContain('oc.day >= 1000')
    expect(sql).toContain('oc.day < 2000')
    expect(sql).toContain('FROM OccurrenceCache oc')
    expect(sql).toContain('INNER JOIN CalendarItem ci')
    expect(sql).toContain('LEFT JOIN Calendar c')
    expect(sql).toContain('LEFT JOIN Location l')
  })

  it('skips empty titles', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toContain('ci.summary IS NOT NULL')
    expect(sql).toContain("ci.summary <> ''")
  })

  it('excludes suggestion calendars', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toContain("c.title NOT IN ('Found in Mail', 'Found in Natural Language')")
  })

  it('includes timed events that overlap the day', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toContain('ci.all_day = 0')
    expect(sql).toContain('AND COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date) < 1000')
    expect(sql).toContain('AND COALESCE(oc.occurrence_end_date, ci.end_date) > 1000')
  })

  it('dedups with DISTINCT and itemId, not GROUP BY', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toMatch(/SELECT\s+DISTINCT/i)
    expect(sql).toContain('ci.ROWID as itemId')
    expect(sql).toContain('ORDER BY startMac ASC, title ASC')
  })

  it('snaps all-day start with calendar-day arithmetic', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).toContain("round((ci.end_date - ci.start_date) / 86400.0)")
    expect(sql).toContain("date(COALESCE(oc.occurrence_end_date, ci.end_date) + 978307200, 'unixepoch', 'localtime'")
    expect(sql).not.toContain('+ 978307200 + 1')
    expect(sql).not.toContain('CASE WHEN ci.all_day THEN oc.day')
  })

  it('snaps DST spring-forward all-day starts to the correct local date', () => {
    const snap = (occEndUnix, durationSeconds) => {
      const query = `SELECT date(${occEndUnix}, 'unixepoch', 'localtime', '-' || (CAST(round(${durationSeconds} / 86400.0) AS INTEGER) - 1) || ' days') AS d`
      const result = spawnSync('sqlite3', ['-json', ':memory:', query], { encoding: 'utf-8' })
      expect(result.status).toBe(0)
      return JSON.parse(result.stdout)[0].d
    }
    const oneDay = spawnSync('sqlite3', ['-json', ':memory:',
      "SELECT strftime('%s','2026-03-08 23:59:59','utc') AS u"], { encoding: 'utf-8' })
    const threeDay = spawnSync('sqlite3', ['-json', ':memory:',
      "SELECT strftime('%s','2026-03-09 23:59:59','utc') AS u"], { encoding: 'utf-8' })
    const oneDayEnd = JSON.parse(oneDay.stdout)[0].u
    const threeDayEnd = JSON.parse(threeDay.stdout)[0].u
    expect(snap(oneDayEnd, 86399)).toBe('2026-03-08')
    expect(snap(threeDayEnd, 3 * 86400 - 1)).toBe('2026-03-07')
  })

  it('does not hardcode a timezone name', () => {
    const sql = buildEventsOnDateQuery(1000, 2000)
    expect(sql).not.toMatch(/America\/Chicago/)
    expect(sql).not.toMatch(/America\/New_York/)
    expect(sql).toContain("'localtime'")
  })
})

describe('calendar_date local Mac bounds', () => {
  it('converts local midnight to Apple/Core Data seconds', () => {
    const start = new Date(2026, 8, 1) // local Sep 1, 2026 00:00
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)

    const { startMac, endMac } = localDayToMacBounds(start.getTime(), end.getTime())

    expect(startMac).toBe(Math.floor(start.getTime() / 1000) - MAC_ABSOLUTE_EPOCH)
    expect(endMac).toBe(Math.floor(end.getTime() / 1000) - MAC_ABSOLUTE_EPOCH)
    expect(endMac).toBeGreaterThan(startMac)
  })

  it('getLocalDayBounds uses next local midnight, not a hardcoded zone', () => {
    const range = getLocalDayBounds('2026-09-01')
    expect(range).not.toBeNull()

    const start = new Date(range.start)
    expect(start.getFullYear()).toBe(2026)
    expect(start.getMonth()).toBe(8)
    expect(start.getDate()).toBe(1)
    expect(start.getHours()).toBe(0)
    expect(start.getMinutes()).toBe(0)
    expect(start.getSeconds()).toBe(0)

    const expectedEnd = new Date(start)
    expectedEnd.setDate(expectedEnd.getDate() + 1)
    expect(range.end).toBe(expectedEnd.getTime())
    expect(new Date(range.end).getHours()).toBe(0)
  })
})

describe('calendar_free_time overnight clamp', () => {
  it('keeps only the in-day slice of a 23:00-01:00 event', () => {
    const dayStart = new Date(2026, 8, 2)
    dayStart.setHours(0, 0, 0, 0)
    const dayEnd = new Date(dayStart)
    dayEnd.setDate(dayEnd.getDate() + 1)

    const evtStart = new Date(2026, 8, 1)
    evtStart.setHours(23, 0, 0, 0)
    const evtEnd = new Date(2026, 8, 2)
    evtEnd.setHours(1, 0, 0, 0)

    const day2 = clampBusyToLocalDay(
      evtStart.getTime(),
      evtEnd.getTime(),
      dayStart.getTime(),
      dayEnd.getTime()
    )
    expect(day2).not.toBeNull()
    expect(day2.startMinutes).toBe(0)
    expect(day2.endMinutes).toBe(60)

    const day1Start = new Date(2026, 8, 1)
    day1Start.setHours(0, 0, 0, 0)
    const day1End = new Date(day1Start)
    day1End.setDate(day1End.getDate() + 1)

    const day1 = clampBusyToLocalDay(
      evtStart.getTime(),
      evtEnd.getTime(),
      day1Start.getTime(),
      day1End.getTime()
    )
    expect(day1).not.toBeNull()
    expect(day1.startMinutes).toBe(23 * 60)
    expect(day1.endMinutes).toBe(24 * 60)
  })
})

describe.skipIf(!calendarExists)('calendar_date live Calendar.sqlitedb', () => {
  it('returns events without leaving /tmp copies', () => {
    const before = new Set(tmpCalendarCopies())
    const range = getLocalDayBounds('today')
    const { events, error } = getEventsOnDate(range.start, range.end)

    expect(error).toBeNull()
    expect(Array.isArray(events)).toBe(true)
    for (const e of events) {
      expect(e.title).toBeTruthy()
      expect(String(e.title).trim().length).toBeGreaterThan(0)
    }

    const leftover = tmpCalendarCopies().filter((name) => !before.has(name))
    expect(leftover).toEqual([])
  })

  it('getCalendarDateResults does not wait on the vector index', async () => {
    const result = await getCalendarDateResults('today')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.results)).toBe(true)
    expect(typeof result.date).toBe('string')
  })

  it('getCalendarDateResults for a named day succeeds without index gating', async () => {
    const result = await getCalendarDateResults('2026-09-01')
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(Array.isArray(result.results)).toBe(true)
    for (const row of result.results) {
      expect(row.title).toBeTruthy()
      expect(String(row.title).trim().length).toBeGreaterThan(0)
      expect(row.calendar).not.toBe('Found in Mail')
      expect(row.calendar).not.toBe('Found in Natural Language')
    }
  })

  it('returns one row for a multi-day timed event', () => {
    const range = getLocalDayBounds('2025-08-02')
    const { events, error } = getEventsOnDate(range.start, range.end)
    expect(error).toBeNull()
    const festival = events.filter((e) => e.title === 'Sioux River Folk Festival')
    expect(festival).toHaveLength(1)
  })

  it('shows all-day multi-day events from the first local day', () => {
    const range = getLocalDayBounds('2026-08-23')
    const { events, error } = getEventsOnDate(range.start, range.end)
    expect(error).toBeNull()
    const dad = events.find((e) => e.title === 'Dad - Time?')
    expect(dad).toBeTruthy()
    expect(String(dad.start)).toMatch(/2026-08-22/)
    expect(String(dad.start)).not.toMatch(/2026-08-23/)
  })

  it('sorts a named day by start time', () => {
    const range = getLocalDayBounds('2026-09-01')
    const { events, error } = getEventsOnDate(range.start, range.end)
    expect(error).toBeNull()
    const starts = events.map((e) => Number(e.startMac))
    const sorted = [...starts].sort((a, b) => a - b)
    expect(starts).toEqual(sorted)
  })
})
