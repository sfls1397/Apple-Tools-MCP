/**
 * Calendar tools print meeting links without their query strings, so a join passcode
 * (zoom.us/j/...?pwd=...) in an event title or location never reaches a chat that reads
 * the calendar (Office Manager reads calendar_date up to four times a day).
 * Synthetic links only: example meeting ids and passcodes, no real ones.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { stripUrlQueries } from '../../lib/urlQuery.js'
import {
  formatCalendarResults,
  formatUpcomingEventsResults,
  formatWeekEventsResults,
  formatRecurringEventsResults
} from '../../search.js'

const PASS = 'FIXTUREpass1234'
const ZOOM = `https://example.zoom.us/j/1000000001?pwd=${PASS}`

describe('stripUrlQueries', () => {
  const cases = [
    [ZOOM, 'https://example.zoom.us/j/1000000001'],
    [`Join: ${ZOOM} (passcode inside)`, 'Join: https://example.zoom.us/j/1000000001 (passcode inside)'],
    [`(${ZOOM})`, '(https://example.zoom.us/j/1000000001)'],
    [`<${ZOOM}>`, '<https://example.zoom.us/j/1000000001>'],
    [`zoommtg://example.zoom.us/join?confno=1000000001&pwd=${PASS}`, 'zoommtg://example.zoom.us/join'],
    [`example.zoom.us/j/1000000001?pwd=${PASS}`, 'example.zoom.us/j/1000000001'],
    [`www.example.com?pwd=${PASS}`, 'www.example.com'],
    [`https://teams.example.com/l/meetup-join/19%3ameeting_X/0?context=%7b%22Tid%22%3a%22${PASS}%22%7d`, 'https://teams.example.com/l/meetup-join/19%3ameeting_X/0'],
    [`https://example.com/page#${PASS}`, 'https://example.com/page'],
    [`A: https://a.example.com/x?p=${PASS} B: https://b.example.com/y?q=${PASS}`, 'A: https://a.example.com/x B: https://b.example.com/y'],
  ]
  for (const [input, want] of cases) {
    it(`strips the query from ${JSON.stringify(input.slice(0, 40))}`, () => {
      const out = stripUrlQueries(input)
      expect(out).toBe(want)
      expect(out).not.toContain(PASS)
    })
  }

  it('leaves text without a URL query alone', () => {
    for (const text of [
      'Dinner?',
      'Lunch at 12:30? Maybe 1:00 p.m./1:30 p.m.?',
      'Q&A w/ the team?',
      'https://meet.example.com/abc-defg-hij',
      'Conference Room 4B',
      '',
    ]) {
      expect(stripUrlQueries(text)).toBe(text)
    }
    expect(stripUrlQueries(null)).toBe(null)
    expect(stripUrlQueries(undefined)).toBe(undefined)
  })
})

describe('calendar formatters print titles and locations without URL queries', () => {
  const event = {
    title: `Standup ${ZOOM}`,
    location: `Zoom: ${ZOOM}`,
    start: '2026-11-12 09:00:00',
    end: '2026-11-12 09:30:00',
    calendar: 'Calendar',
    isAllDay: 0,
    occurrenceCount: 3,
  }

  it('calendar_date / calendar_search', () => {
    const text = formatCalendarResults({
      success: true,
      date: 'Thursday, November 12, 2026',
      results: [{ ...event, index: 1, eventId: 'uid-1', isAllDay: false }],
    })
    expect(text).toContain('Event: Standup https://example.zoom.us/j/1000000001')
    expect(text).toContain('Location: Zoom: https://example.zoom.us/j/1000000001')
    expect(text).not.toContain(PASS)
    expect(text).not.toContain('pwd=')
  })

  it('calendar_upcoming', () => {
    const text = formatUpcomingEventsResults({ events: [event], showing: 1, hasMore: false })
    expect(text).toContain('1. Standup https://example.zoom.us/j/1000000001')
    expect(text).toContain('Location: Zoom: https://example.zoom.us/j/1000000001')
    expect(text).not.toContain(PASS)
  })

  it('calendar_week and calendar_recurring', () => {
    const week = formatWeekEventsResults({ events: [event], weekLabel: 'This Week', dateRange: 'Mon Nov 9 - Sun Nov 15' })
    expect(week).toContain('Standup https://example.zoom.us/j/1000000001')
    expect(week).not.toContain(PASS)
    const recurring = formatRecurringEventsResults({ events: [event], showing: 1, hasMore: false })
    expect(recurring).toContain('Standup https://example.zoom.us/j/1000000001')
    expect(recurring).not.toContain(PASS)
  })
})

describe('smart_search and person_search print calendar titles and locations without URL queries', () => {
  // formatSmartSearchResults and formatPersonSearchResults live inside index.js (not exported).
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js'), 'utf8')
  const body = (name) => {
    const start = src.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('\n}\n', start))
  }

  it('formatSmartSearchResults strips the timeline titles, event titles and locations', () => {
    const fn = body('formatSmartSearchResults')
    expect(fn).toContain('group.calendar.map(c => stripUrlQueries(c.title))')
    expect(fn).toContain('Event: ${stripUrlQueries(r.title)}')
    expect(fn).toContain('Location: ${stripUrlQueries(r.location)}')
    expect(fn).not.toMatch(/\$\{r\.(title|location)\}/)
  })

  it('formatPersonSearchResults strips event titles', () => {
    const fn = body('formatPersonSearchResults')
    expect(fn).toContain('${stripUrlQueries(r.title)}')
    expect(fn).not.toMatch(/\$\{r\.(title|location)\}/)
  })
})
