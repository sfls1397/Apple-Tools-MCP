/**
 * Today's events never vanish, and a failed calendar read is an MCP error, never an empty day.
 *
 * The Thu Nov 12 2026 07:00 morning brief said the calendar was empty and put the next NAD+ on Mon Nov 16.
 * calendar_upcoming filtered OccurrenceCache.day >= now; day is the occurrence's local midnight, so every
 * event on the current day dropped out after midnight. The fixture below is that day's shape with
 * synthetic titles: a recurring all-day "Take NAD+" series whose master is dated Oct 21, plus one-offs
 * at 6:30 PM and 8:00 PM. It runs on a throwaway Calendar.sqlitedb under a temp HOME; never the real one.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const MAC_EPOCH = 978307200
// Core Data seconds for a Chicago wall time in Nov 2026 (CST, UTC-6).
const mac = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h + 6, mi, s) / 1000 - MAC_EPOCH
// 7:00 AM CT Thu Nov 12 2026, when the brief ran.
const BRIEF_TIME = new Date(Date.UTC(2026, 10, 12, 13, 0, 0))

const SCHEMA = `
CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE Location (ROWID INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY, summary TEXT, location_id INTEGER, start_date REAL, start_tz TEXT,
  end_date REAL, all_day INTEGER, calendar_id INTEGER, has_recurrences INTEGER, unique_identifier TEXT);
CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, occurrence_date REAL,
  occurrence_start_date REAL, occurrence_end_date REAL, latest_possible_alarm REAL, earliest_possible_alarm REAL, next_reminder_date REAL);
INSERT INTO Calendar VALUES (1, 'Calendar'), (2, 'US Holidays');
`

function nov12Sql() {
  const items = [
    [1, 'Take NAD+', mac(2026, 10, 21), '_float', mac(2026, 10, 21, 23, 59, 59), 1, 1, 1],
    [2, 'Dinner', mac(2026, 11, 12, 18, 30), 'America/Chicago', mac(2026, 11, 12, 19, 30), 0, 1, 0],
    [3, 'Phone call', mac(2026, 11, 12, 20), 'America/Chicago', mac(2026, 11, 12, 21), 0, 1, 0],
    [4, 'Veterans Day', mac(2026, 11, 11), '_float', mac(2026, 11, 11, 23, 59, 59), 1, 2, 1],
    [5, 'Book club', mac(2026, 11, 13, 20), 'America/Chicago', mac(2026, 11, 13, 21), 0, 1, 1],
  ]
  const occurrences = [
    [mac(2026, 10, 21), 1, mac(2026, 10, 21), mac(2026, 10, 21, 23, 59, 59)],
    [mac(2026, 11, 11), 4, mac(2026, 11, 11), mac(2026, 11, 11, 23, 59, 59)],
    [mac(2026, 11, 12), 1, mac(2026, 11, 12), mac(2026, 11, 12, 23, 59, 59)],
    [mac(2026, 11, 12), 2, mac(2026, 11, 12, 18, 30), mac(2026, 11, 12, 19, 30)],
    [mac(2026, 11, 12), 3, mac(2026, 11, 12, 20), mac(2026, 11, 12, 21)],
    [mac(2026, 11, 13), 5, mac(2026, 11, 13, 20), mac(2026, 11, 13, 21)],
    [mac(2026, 11, 16), 1, mac(2026, 11, 16), mac(2026, 11, 16, 23, 59, 59)],
  ]
  return SCHEMA +
    items.map(([id, title, start, tz, end, allDay, cal, rec]) =>
      `INSERT INTO CalendarItem VALUES (${id}, '${title}', NULL, ${start}, '${tz}', ${end}, ${allDay}, ${cal}, ${rec}, 'uid-${id}');`).join('\n') +
    occurrences.map(([day, id, start, end]) =>
      `INSERT INTO OccurrenceCache (day, event_id, calendar_id, store_id, occurrence_date, occurrence_end_date) VALUES (${day}, ${id}, 1, 1, ${start}, ${end});`).join('\n')
}

let home, calendarDir, calendarDb, savedHome, savedTz, indexer, search

function writeDb(sql) {
  fs.rmSync(calendarDir, { recursive: true, force: true })
  fs.mkdirSync(calendarDir, { recursive: true })
  if (sql === null) return
  const made = spawnSync('sqlite3', [calendarDb], { input: sql, encoding: 'utf8' })
  expect(made.status, made.stderr).toBe(0)
}

beforeAll(async () => {
  savedHome = process.env.HOME
  savedTz = process.env.TZ
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-tools-calendar-today-'))
  calendarDir = path.join(home, 'Library', 'Group Containers', 'group.com.apple.calendar')
  calendarDb = path.join(calendarDir, 'Calendar.sqlitedb')
  // The Mini runs in America/Chicago; the day must be that local day whatever the test host's zone.
  process.env.TZ = 'America/Chicago'
  process.env.HOME = home
  vi.resetModules()
  indexer = await import('../../indexer.js')
  search = await import('../../search.js')
})

afterAll(() => {
  process.env.HOME = savedHome
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
  vi.resetModules()
  fs.rmSync(home, { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('calendar_upcoming keeps every event on the current day (Nov 12 2026 shape)', () => {
  it('at 7:00 AM lists the all-day NAD+ and both evening one-offs first, before tomorrow', () => {
    writeDb(nov12Sql())
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(BRIEF_TIME)
    const result = indexer.getUpcomingEvents(10)
    expect(result.error).toBeUndefined()
    const titles = result.events.map((e) => e.title)
    expect(titles.slice(0, 3)).toEqual(['Take NAD+', 'Dinner', 'Phone call'])
    expect(titles).toEqual(['Take NAD+', 'Dinner', 'Phone call', 'Book club', 'Take NAD+'])
    expect(result.events[0].start).toBe('2026-11-12 00:00:00')
    expect(result.events[0].isAllDay).toBe(1)
    expect(result.events[1].start).toBe('2026-11-12 18:30:00')
    expect(result.events[2].start).toBe('2026-11-12 20:00:00')
    expect(titles).not.toContain('Veterans Day')
    const text = search.formatUpcomingEventsResults(result)
    expect(text.indexOf('Take NAD+')).toBeLessThan(text.indexOf('Book club'))
  })

  it('still lists all of today at 9:30 PM, after the evening events ended', () => {
    writeDb(nov12Sql())
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 13, 3, 30)))
    const titles = indexer.getUpcomingEvents(3).events.map((e) => e.title)
    expect(titles).toEqual(['Take NAD+', 'Dinner', 'Phone call'])
  })

  it('bounds the query by local midnight, not by now', () => {
    const sql = indexer.buildUpcomingEventsQuery(mac(2026, 11, 12), 11)
    expect(sql).toContain(`oc.day >= ${mac(2026, 11, 12)}`)
    expect(sql).toMatch(/ORDER BY sort_day ASC, ci\.all_day DESC/)
  })
})

describe('calendar_date for Nov 12 2026', () => {
  it('returns the recurring all-day NAD+ and both one-offs', async () => {
    writeDb(nov12Sql())
    const result = await search.getCalendarDateResults('2026-11-12')
    expect(result.success).toBe(true)
    expect(result.results.map((r) => r.title)).toEqual(['Take NAD+', 'Dinner', 'Phone call'])
    expect(result.results[0].isAllDay).toBe(true)
  })
})

describe('a calendar that cannot be read is an error, never an empty day', () => {
  const cases = {
    'no database': null,
    'a database with an empty OccurrenceCache': SCHEMA,
    'a database with no OccurrenceCache table': 'CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT);',
  }
  for (const [name, sql] of Object.entries(cases)) {
    it(`${name}: calendar_date, calendar_free_time and calendar_upcoming fail`, async () => {
      writeDb(sql)
      const date = await search.getCalendarDateResults('2026-11-12')
      expect(date.success).toBe(false)
      expect(() => search.requireCalendarRead(date)).toThrow(/calendar/i)
      const free = await search.calculateFreeTime('2026-11-12')
      expect(free.success).toBe(false)
      expect(() => search.requireCalendarRead(free)).toThrow()
      const upcoming = indexer.getUpcomingEvents(5)
      expect(upcoming.error).toBeTruthy()
      expect(() => search.requireCalendarRead(upcoming)).toThrow(/upcoming/i)
    })
  }

  it('a day with no events is still a successful read', async () => {
    writeDb(nov12Sql())
    const result = await search.getCalendarDateResults('2026-11-14')
    expect(result.success).toBe(true)
    expect(result.results).toEqual([])
    expect(search.requireCalendarRead(result)).toBe(result)
  })

  it('the MCP dispatcher turns each failed calendar read into isError', () => {
    const src = fs.readFileSync(path.join(root, 'index.js'), 'utf8')
    for (const call of [
      'formatCalendarResults(requireCalendarRead(await getCalendarDateResults(',
      'formatFreeTimeResults(requireCalendarRead(await calculateFreeTime(',
      'formatUpcomingEventsResults(requireCalendarRead(getUpcomingEvents(',
    ]) {
      expect(src).toContain(call)
    }
  })
})
