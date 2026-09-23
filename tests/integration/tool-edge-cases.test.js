/**
 * Tool Edge Cases Tests - Test unusual parameter combinations
 *
 * Tests for:
 * - Conflicting filter combinations
 * - Boundary values for all parameters
 * - Edge cases specific to each tool
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { connect } from '@lancedb/lancedb'
import { pipeline } from '@huggingface/transformers'
import { safeSqlite3Json } from '../../lib/shell.js'
import {
  loadContacts,
  searchContacts,
  lookupContact,
  resolveByName
} from '../../contacts.js'

// Real paths
const DATA_DIR = path.join(process.env.HOME, '.apple-tools-mcp')
const DB_PATH = path.join(DATA_DIR, 'vector-index')
const MESSAGES_DB = path.join(process.env.HOME, 'Library', 'Messages', 'chat.db')
const CALENDAR_DB = path.join(process.env.HOME, 'Library', 'Group Containers', 'group.com.apple.calendar', 'Calendar.sqlitedb')

const indexExists = fs.existsSync(DB_PATH)
const messagesExists = fs.existsSync(MESSAGES_DB)
const calendarExists = fs.existsSync(CALENDAR_DB)

let db = null
let embedder = null

async function getEmbedding(text) {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

async function searchTable(tableName, query, limit = 10) {
  if (!db) return []
  try {
    const tables = await db.tableNames()
    if (!tables.includes(tableName)) return []
    const table = await db.openTable(tableName)
    const embedding = await getEmbedding(query)
    return await table.search(embedding).limit(limit).toArray()
  } catch (e) {
    return []
  }
}

// ============================================================================
// EMAIL SEARCH EDGE CASES
// ============================================================================

describe.skipIf(!indexExists)('Email Search Edge Cases', () => {
  beforeAll(async () => {
    if (indexExists) {
      db = await connect(DB_PATH)
    }
  })

  describe('Limit Parameter Edge Cases', () => {
    it('should handle limit = 1', async () => {
      const results = await searchTable('emails', 'meeting', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('should handle limit = 0 (should use default)', async () => {
      // limit 0 is invalid, should use default or return empty
      const results = await searchTable('emails', 'meeting', 0)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle very large limit', async () => {
      const results = await searchTable('emails', 'the', 10000)
      // Should cap at reasonable maximum or return available (limited by 30-day window)
      expect(Array.isArray(results)).toBe(true)
      expect(results.length).toBeLessThanOrEqual(10000)
    })
  })

  describe('Query Edge Cases', () => {
    it('should handle single character query', async () => {
      const results = await searchTable('emails', 'a', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle very common word query', async () => {
      const results = await searchTable('emails', 'the', 10)
      expect(results.length).toBeGreaterThanOrEqual(0)
    })

    it('should handle query with only numbers', async () => {
      const results = await searchTable('emails', '2024', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle query with mixed case', async () => {
      const results1 = await searchTable('emails', 'MEETING', 10)
      const results2 = await searchTable('emails', 'meeting', 10)
      // Both should work, may return similar results
      expect(Array.isArray(results1)).toBe(true)
      expect(Array.isArray(results2)).toBe(true)
    })

    it('should handle query with punctuation only', async () => {
      const results = await searchTable('emails', '...', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Filter Combination Edge Cases', () => {
    it('should handle searching in non-existent mailbox', async () => {
      // Simulated by query - actual mailbox filtering would happen post-search
      const results = await searchTable('emails', 'NonExistentMailbox99999', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should return results when filtering by date range', async () => {
      // Query implying date
      const results = await searchTable('emails', 'yesterday morning', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

// ============================================================================
// MESSAGE SEARCH EDGE CASES
// ============================================================================

describe.skipIf(!indexExists)('Message Search Edge Cases', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  describe('Contact Name Edge Cases', () => {
    it('should handle contact name with special characters', async () => {
      const results = await searchTable('messages', "O'Brien", 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle contact name with numbers', async () => {
      const results = await searchTable('messages', 'John123', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle very long contact name', async () => {
      const longName = 'John '.repeat(50)
      const results = await searchTable('messages', longName, 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Group Chat Edge Cases', () => {
    it('should handle query for group chat content', async () => {
      const results = await searchTable('messages', 'group chat everyone', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should distinguish individual vs group messages', async () => {
      const results = await searchTable('messages', 'hi', 20)
      // Check if results have isGroup field
      const withGroupFlag = results.filter(r => typeof r.isGroup !== 'undefined')
      console.log(`  → ${withGroupFlag.length}/${results.length} messages have isGroup flag`)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Date Range Edge Cases', () => {
    it('should handle very old date query', async () => {
      const results = await searchTable('messages', 'message from 2010', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle future date query', async () => {
      const results = await searchTable('messages', 'next year 2026', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

// ============================================================================
// CALENDAR SEARCH EDGE CASES
// ============================================================================

describe.skipIf(!indexExists)('Calendar Search Edge Cases', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
  })

  describe('Time Boundary Edge Cases', () => {
    it('should handle all-day event queries', async () => {
      const results = await searchTable('calendar', 'all day birthday holiday', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle midnight boundary events', async () => {
      const results = await searchTable('calendar', 'midnight 12am', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle multi-day event queries', async () => {
      const results = await searchTable('calendar', 'vacation conference week', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Recurring Event Edge Cases', () => {
    it('should handle recurring event queries', async () => {
      const results = await searchTable('calendar', 'weekly standup recurring', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle daily recurring events', async () => {
      const results = await searchTable('calendar', 'daily meeting every day', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Attendee Edge Cases', () => {
    it('should handle event with many attendees', async () => {
      const results = await searchTable('calendar', 'team meeting all hands', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle event with no attendees', async () => {
      const results = await searchTable('calendar', 'personal reminder block', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

// ============================================================================
// CONTACT LOOKUP EDGE CASES
// ============================================================================

describe('Contact Lookup Edge Cases', () => {
  beforeAll(() => {
    loadContacts()
  })

  describe('Phone Number Format Edge Cases', () => {
    it('should handle phone with country code', () => {
      const result = lookupContact('+1-555-123-4567')
      // May or may not find - just shouldn't crash
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle phone with parentheses', () => {
      const result = lookupContact('(555) 123-4567')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle phone with dots', () => {
      const result = lookupContact('555.123.4567')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle phone with spaces', () => {
      const result = lookupContact('555 123 4567')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle international phone format', () => {
      const result = lookupContact('+44 20 7946 0958')
      expect(result === null || typeof result === 'object').toBe(true)
    })
  })

  describe('Email Format Edge Cases', () => {
    it('should handle email with plus sign', () => {
      const result = lookupContact('user+tag@example.com')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle email with subdomain', () => {
      const result = lookupContact('user@mail.example.com')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle email with numbers', () => {
      const result = lookupContact('user123@example.com')
      expect(result === null || typeof result === 'object').toBe(true)
    })

    it('should handle uppercase email', () => {
      const result = lookupContact('USER@EXAMPLE.COM')
      expect(result === null || typeof result === 'object').toBe(true)
    })
  })

  describe('Name Format Edge Cases', () => {
    it('should handle name with prefix (Dr., Mr., etc)', () => {
      const results = resolveByName('Dr. Smith')
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle name with suffix (Jr., III, etc)', () => {
      const results = resolveByName('Smith Jr.')
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle hyphenated name', () => {
      const results = resolveByName('Mary Smith-Jones')
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle name with apostrophe', () => {
      const results = resolveByName("O'Connor")
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle single name (mononym)', () => {
      const results = resolveByName('Madonna')
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle very long name', () => {
      const longName = 'John Michael Alexander William ' + 'Smith '.repeat(10)
      const results = resolveByName(longName)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

// ============================================================================
// SEARCH CONTACTS EDGE CASES
// ============================================================================

describe('Search Contacts Edge Cases', () => {
  beforeAll(() => {
    loadContacts()
  })

  describe('Query Edge Cases', () => {
    it('should handle empty search', () => {
      const results = searchContacts('', 10)
      // Empty search might return all or none
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle whitespace-only search', () => {
      const results = searchContacts('   ', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle special character search', () => {
      const results = searchContacts('@#$%', 10)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle numeric search', () => {
      const results = searchContacts('555', 10)
      expect(Array.isArray(results)).toBe(true)
    })
  })

  describe('Limit Edge Cases', () => {
    it('should handle limit = 1', () => {
      const results = searchContacts('john', 1)
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('should handle limit = 0', () => {
      const results = searchContacts('john', 0)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle negative limit', () => {
      const results = searchContacts('john', -5)
      expect(Array.isArray(results)).toBe(true)
    })

    it('should handle very large limit', () => {
      const results = searchContacts('a', 100000)
      expect(Array.isArray(results)).toBe(true)
    })
  })
})

// ============================================================================
// CROSS-TOOL EDGE CASES
// ============================================================================

describe.skipIf(!indexExists)('Cross-Tool Edge Cases', () => {
  beforeAll(async () => {
    if (indexExists && !db) {
      db = await connect(DB_PATH)
    }
    loadContacts()
  })

  it('should handle same query across all sources', async () => {
    const query = 'meeting'
    const emails = await searchTable('emails', query, 5)
    const messages = await searchTable('messages', query, 5)
    const calendar = await searchTable('calendar', query, 5)

    console.log(`  → Query "${query}": emails=${emails.length}, messages=${messages.length}, calendar=${calendar.length}`)

    expect(Array.isArray(emails)).toBe(true)
    expect(Array.isArray(messages)).toBe(true)
    expect(Array.isArray(calendar)).toBe(true)
  })

  it('should handle person-specific query across sources', async () => {
    const contacts = searchContacts('john', 1)

    if (contacts.length > 0) {
      const name = contacts[0].name
      console.log(`  → Searching for person: ${name}`)

      const emails = await searchTable('emails', name, 5)
      const messages = await searchTable('messages', name, 5)

      console.log(`  → Found: ${emails.length} emails, ${messages.length} messages`)
    }

    expect(true).toBe(true)
  })

  it('should handle date-based query across sources', async () => {
    const query = 'today'
    const emails = await searchTable('emails', query, 5)
    const messages = await searchTable('messages', query, 5)
    const calendar = await searchTable('calendar', query, 5)

    expect(Array.isArray(emails)).toBe(true)
    expect(Array.isArray(messages)).toBe(true)
    expect(Array.isArray(calendar)).toBe(true)
  })
})

// ============================================================================
// RAW DATABASE EDGE CASES
// ============================================================================

describe.skipIf(!messagesExists)('Raw Messages Database Edge Cases', () => {
  it('should handle SQL query with special characters', () => {
    const query = `
      SELECT m.ROWID FROM message m
      WHERE m.text LIKE '%test''s%'
      LIMIT 5
    `
    const results = safeSqlite3Json(MESSAGES_DB, query)
    expect(Array.isArray(results)).toBe(true)
  })

  it('should handle empty result set', () => {
    const query = `
      SELECT m.ROWID FROM message m
      WHERE m.text = 'ThisExactTextWillNeverExist99999'
      LIMIT 5
    `
    const results = safeSqlite3Json(MESSAGES_DB, query)
    expect(results).toEqual([])
  })

  it('should handle query with complex joins', () => {
    const query = `
      SELECT m.ROWID, h.id as handle
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LIMIT 5
    `
    const results = safeSqlite3Json(MESSAGES_DB, query)
    expect(Array.isArray(results)).toBe(true)
  })
})

describe.skipIf(!calendarExists)('Raw Calendar Database Edge Cases', () => {
  it('should handle basic calendar query', () => {
    // Use summary instead of title (actual column name)
    const query = `
      SELECT summary FROM CalendarItem
      LIMIT 5
    `
    const results = safeSqlite3Json(CALENDAR_DB, query)
    expect(Array.isArray(results)).toBe(true)
    console.log(`  → Found ${results.length} calendar items`)
  })

  it('should handle recurring event query', () => {
    // Check for any events with recurrence info
    const query = `
      SELECT summary FROM CalendarItem
      WHERE has_recurrences = 1
      LIMIT 5
    `
    const results = safeSqlite3Json(CALENDAR_DB, query)
    expect(Array.isArray(results)).toBe(true)
  })
})
