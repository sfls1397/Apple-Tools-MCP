/**
 * Unit tests for search logic in search.js
 * Tests query expansion, negation parsing, keyword extraction, hybrid scoring, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'

// ============ QUERY EXPANSION ============

describe('Query Expansion', () => {
  // Reimplementing expandQuery for testing
  const expandQuery = (query) => {
    const expansions = [query]

    // Simplified (remove time modifiers)
    const simplified = query.replace(/\b(recently|last \w+|this \w+|next \w+|about|regarding)\b/gi, '').trim()
    if (simplified && simplified !== query && simplified.length > 3) {
      expansions.push(simplified)
    }

    // Synonym replacement
    const synonymMap = {
      'meeting': ['call', 'sync', 'standup', 'discussion'],
      'budget': ['financial', 'costs', 'expense', 'spending'],
      'project': ['initiative', 'task', 'work', 'assignment'],
      'deadline': ['due date', 'due', 'timeline', 'delivery'],
      'review': ['feedback', 'evaluation', 'assessment', 'check'],
      'invoice': ['bill', 'payment', 'receipt', 'charge'],
      'schedule': ['calendar', 'appointment', 'booking'],
      'update': ['status', 'progress', 'news'],
      'help': ['assist', 'support', 'question'],
      'issue': ['problem', 'bug', 'error', 'concern']
    }

    for (const [word, syns] of Object.entries(synonymMap)) {
      if (query.toLowerCase().includes(word)) {
        expansions.push(query.replace(new RegExp(`\\b${word}\\b`, 'gi'), syns[0]))
        break
      }
    }

    return [...new Set(expansions)].slice(0, 3)
  }

  it('should include original query', () => {
    const result = expandQuery('team meeting')
    expect(result).toContain('team meeting')
  })

  it('should create simplified version without time modifiers', () => {
    const result = expandQuery('meeting last week')
    expect(result.some(q => !q.includes('last week'))).toBe(true)
  })

  it('should expand synonyms for meeting', () => {
    const result = expandQuery('team meeting')
    expect(result.some(q => q.includes('call'))).toBe(true)
  })

  it('should expand synonyms for budget', () => {
    const result = expandQuery('budget report')
    expect(result.some(q => q.includes('financial'))).toBe(true)
  })

  it('should expand synonyms for invoice', () => {
    const result = expandQuery('invoice from vendor')
    expect(result.some(q => q.includes('bill'))).toBe(true)
  })

  it('should limit to 3 variants', () => {
    const result = expandQuery('meeting about budget recently')
    expect(result.length).toBeLessThanOrEqual(3)
  })

  it('should deduplicate expansions', () => {
    const result = expandQuery('simple query')
    const unique = [...new Set(result)]
    expect(result.length).toBe(unique.length)
  })
})

// ============ NEGATION PARSING ============

describe('Negation Parsing', () => {
  const parseNegation = (query) => {
    const negations = []
    const negationPatterns = [
      /\bNOT\s+(\w+)/gi,
      /\s-(\w+)/g,
      /\bwithout\s+(\w+)/gi,
      /\bexcluding?\s+(\w+)/gi
    ]

    let cleanQuery = query
    for (const pattern of negationPatterns) {
      let match
      while ((match = pattern.exec(query)) !== null) {
        negations.push(match[1].toLowerCase())
      }
      cleanQuery = cleanQuery.replace(pattern, ' ')
    }

    return {
      cleanQuery: cleanQuery.replace(/\s+/g, ' ').trim(),
      negations: [...new Set(negations)]
    }
  }

  it('should parse NOT keyword', () => {
    const result = parseNegation('meeting NOT weekly')
    expect(result.negations).toContain('weekly')
    expect(result.cleanQuery).toBe('meeting')
  })

  it('should parse minus sign prefix', () => {
    const result = parseNegation('email -spam')
    expect(result.negations).toContain('spam')
  })

  it('should parse without keyword', () => {
    const result = parseNegation('documents without attachments')
    expect(result.negations).toContain('attachments')
  })

  it('should parse excluding keyword', () => {
    const result = parseNegation('messages excluding newsletters')
    expect(result.negations).toContain('newsletters')
  })

  it('should handle multiple negations', () => {
    const result = parseNegation('meeting NOT weekly -standup without zoom')
    expect(result.negations).toContain('weekly')
    expect(result.negations).toContain('standup')
    expect(result.negations).toContain('zoom')
  })

  it('should deduplicate negations', () => {
    const result = parseNegation('meeting NOT spam -spam')
    expect(result.negations.filter(n => n === 'spam').length).toBe(1)
  })

  it('should clean up query whitespace', () => {
    const result = parseNegation('meeting  NOT  weekly')
    expect(result.cleanQuery).toBe('meeting')
  })
})

// ============ KEYWORD EXTRACTION ============

describe('Keyword Extraction', () => {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
    'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'and', 'but', 'if', 'or', 'because', 'as', 'until', 'while', 'any', 'both', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'it', 'its', 'my',
    'your', 'his', 'her', 'our', 'their', 'me', 'him', 'them', 'us', 'i', 'you', 'we'])

  const extractKeywords = (query) => {
    return query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
  }

  it('should extract significant words', () => {
    const result = extractKeywords('meeting with John about budget')
    expect(result).toContain('meeting')
    expect(result).toContain('john')
    expect(result).toContain('budget')
  })

  it('should filter out stop words', () => {
    const result = extractKeywords('the meeting with a team')
    expect(result).not.toContain('the')
    expect(result).not.toContain('with')
    expect(result).not.toContain('a')
  })

  it('should filter out short words', () => {
    const result = extractKeywords('go to the meeting')
    expect(result).not.toContain('go')
    expect(result).not.toContain('to')
  })

  it('should lowercase keywords', () => {
    const result = extractKeywords('Meeting with JOHN')
    expect(result).toContain('meeting')
    expect(result).toContain('john')
  })

  it('should handle punctuation', () => {
    const result = extractKeywords('email, phone, and messages!')
    expect(result).toContain('email')
    expect(result).toContain('phone')
    expect(result).toContain('messages')
  })
})

// ============ KEYWORD MATCHING ============

describe('Keyword Matching', () => {
  const keywordMatch = (text, keywords) => {
    if (!text || !keywords || keywords.length === 0) return 0

    const textLower = text.toLowerCase()
    let matches = 0
    let totalWeight = 0

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase()
      const wordBoundary = new RegExp(`\\b${kwLower}\\b`, 'i')
      if (wordBoundary.test(text)) {
        matches += 1.0 // Exact word match
      } else if (textLower.includes(kwLower)) {
        matches += 0.5 // Partial match
      }
      totalWeight += 1
    }

    return totalWeight > 0 ? matches / totalWeight : 0
  }

  it('should return 1.0 for exact single keyword match', () => {
    const score = keywordMatch('Team meeting tomorrow', ['meeting'])
    expect(score).toBe(1.0)
  })

  it('should return 0.5 for partial match', () => {
    const score = keywordMatch('Meetings are scheduled', ['meeting'])
    // "meeting" is contained in "Meetings" but not exact word boundary
    // Actually "Meetings" contains "meeting" as substring, score = 0.5
    expect(score).toBe(0.5)
  })

  it('should return 0 for no match', () => {
    const score = keywordMatch('Team discussion tomorrow', ['meeting'])
    expect(score).toBe(0)
  })

  it('should average scores for multiple keywords', () => {
    const score = keywordMatch('Team meeting about budget', ['meeting', 'budget'])
    expect(score).toBe(1.0) // Both exact matches
  })

  it('should handle mixed matches', () => {
    const score = keywordMatch('Team meeting', ['meeting', 'budget'])
    expect(score).toBe(0.5) // 1 match out of 2
  })

  it('should return 0 for empty inputs', () => {
    expect(keywordMatch('', ['meeting'])).toBe(0)
    expect(keywordMatch('text', [])).toBe(0)
    expect(keywordMatch(null, ['meeting'])).toBe(0)
  })
})

// ============ FILTER EXTRACTION FROM QUERY ============

describe('Filter Extraction from Natural Language', () => {
  const extractFiltersFromQuery = (query) => {
    const filters = {}
    const q = query.toLowerCase()

    // Extract person names
    const safeQuery = query.length > 500 ? query.substring(0, 500) : query
    const personPatterns = [
      /(?:from|with|to)\s+([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)/,
      /([A-Z][a-z]{1,20}(?:\s[A-Z][a-z]{1,20})?)\s+(?:said|sent|wrote|messaged|texted|emailed)/,
      /(?:emails?|messages?|texts?|calls?)\s+(?:from|to|with)\s+([A-Z][a-z]{1,20})/i
    ]

    for (const pattern of personPatterns) {
      const match = safeQuery.match(pattern)
      if (match && match[1] && match[1].length > 2) {
        filters.person = match[1]
        break
      }
    }

    // Extract date ranges
    const datePatterns = {
      'yesterday': 1,
      'last week': 7,
      'this week': 7,
      'last month': 30,
      'this month': 30,
      'last few days': 3,
      'past week': 7,
      'past month': 30,
      'recent': 7,
      'recently': 7,
      'today': 1
    }

    for (const [phrase, days] of Object.entries(datePatterns)) {
      if (q.includes(phrase)) {
        filters.daysBack = days
        break
      }
    }

    // Extract "last N days" pattern
    const lastNDays = q.match(/last\s+(\d+)\s+days?/i)
    if (lastNDays) {
      filters.daysBack = parseInt(lastNDays[1], 10)
    }

    return filters
  }

  describe('Person extraction', () => {
    it('should extract "from John" pattern', () => {
      const filters = extractFiltersFromQuery('emails from John')
      expect(filters.person).toBe('John')
    })

    it('should extract "from John Smith" pattern', () => {
      const filters = extractFiltersFromQuery('messages from John Smith')
      expect(filters.person).toBe('John Smith')
    })

    it('should extract "John said" pattern', () => {
      const filters = extractFiltersFromQuery('what John said about the project')
      expect(filters.person).toBe('John')
    })

    it('should extract "emails from John" pattern', () => {
      const filters = extractFiltersFromQuery('emails from Sarah')
      expect(filters.person).toBe('Sarah')
    })
  })

  describe('Date extraction', () => {
    it('should extract yesterday', () => {
      const filters = extractFiltersFromQuery('emails from yesterday')
      expect(filters.daysBack).toBe(1)
    })

    it('should extract last week', () => {
      const filters = extractFiltersFromQuery('messages from last week')
      expect(filters.daysBack).toBe(7)
    })

    it('should extract last month', () => {
      const filters = extractFiltersFromQuery('calendar events last month')
      expect(filters.daysBack).toBe(30)
    })

    it('should extract "last N days" pattern', () => {
      const filters = extractFiltersFromQuery('emails from last 14 days')
      expect(filters.daysBack).toBe(14)
    })

    it('should extract recently', () => {
      const filters = extractFiltersFromQuery('recent messages')
      expect(filters.daysBack).toBe(7)
    })
  })
})

// ============ PRONOUN RESOLUTION ============

describe('Pronoun Resolution', () => {
  it('should replace a leading pronoun (RegExp lastIndex must not skip it)', async () => {
    const { resolvePronouns, updateContext } = await import('../../search.js')
    updateContext('emails from John', { person: 'John' }, 'mail')
    expect(resolvePronouns('they sent a report')).toBe('John sent a report')
  })

  it('should replace every pronoun in the query', async () => {
    const { resolvePronouns, updateContext } = await import('../../search.js')
    updateContext('emails from John', { person: 'John' }, 'mail')
    expect(resolvePronouns('what did they send to their team')).toBe('what did John send to John team')
  })

  it('documents that /g + test() lastIndex alternates across calls', () => {
    const re = /\b(they|them|their|he|him|his|she|her|hers)\b/gi
    expect(re.test('they sent a report')).toBe(true)
    expect(re.test('they sent a report')).toBe(false)
    expect(re.test('they sent a report')).toBe(true)
  })

  it('repeated resolvePronouns calls stay stable (no lastIndex leftover)', async () => {
    const { resolvePronouns, updateContext } = await import('../../search.js')
    updateContext('emails from John', { person: 'John' }, 'mail')
    for (let i = 0; i < 20; i++) {
      expect(resolvePronouns('they sent a report')).toBe('John sent a report')
      expect(resolvePronouns('what did they send to their team')).toBe('what did John send to John team')
      expect(resolvePronouns('emails about Q3')).toBe('emails about Q3')
    }
  })

  it('resolvePronouns does not use /g with RegExp#test', async () => {
    const src = fs.readFileSync(new URL('../../search.js', import.meta.url), 'utf8')
    const fn = src.slice(src.indexOf('function resolvePronouns'), src.indexOf('function extractFiltersFromQuery'))
    expect(fn).not.toMatch(/\.test\s*\(/)
    expect(fn).toContain('new RegExp')
  })
})

// ============ RESULT QUALITY ASSESSMENT ============

describe('Result Quality Assessment', () => {
  const MIN_CONFIDENCE_SCORE = 0.5

  const assessResultQuality = (results) => {
    if (!results || results.length === 0) {
      return { quality: 'empty', shouldRetry: true }
    }

    const topScore = results[0]._distance ? (1 - results[0]._distance) : 0

    if (topScore < MIN_CONFIDENCE_SCORE) {
      return { quality: 'low_confidence', shouldRetry: true, topScore }
    }

    if (results.length < 3 && topScore < 0.7) {
      return { quality: 'sparse', shouldRetry: true, topScore }
    }

    return { quality: 'good', shouldRetry: false, topScore }
  }

  it('should return empty for no results', () => {
    expect(assessResultQuality([])).toEqual({ quality: 'empty', shouldRetry: true })
    expect(assessResultQuality(null)).toEqual({ quality: 'empty', shouldRetry: true })
  })

  it('should return low_confidence for poor top score', () => {
    const results = [{ _distance: 0.8 }] // score = 0.2
    const quality = assessResultQuality(results)
    expect(quality.quality).toBe('low_confidence')
    expect(quality.shouldRetry).toBe(true)
  })

  it('should return sparse for few results with moderate score', () => {
    const results = [{ _distance: 0.35 }, { _distance: 0.4 }] // scores 0.65, 0.6
    const quality = assessResultQuality(results)
    expect(quality.quality).toBe('sparse')
  })

  it('should return good for high-quality results', () => {
    const results = [
      { _distance: 0.1 }, // score 0.9
      { _distance: 0.2 },
      { _distance: 0.3 }
    ]
    const quality = assessResultQuality(results)
    expect(quality.quality).toBe('good')
    expect(quality.shouldRetry).toBe(false)
  })
})

// ============ QUERY BROADENING ============

describe('Query Broadening', () => {
  const broadenQuery = (query) => {
    let broader = query.replace(/\b(recently|last \w+|this \w+|next \w+|yesterday|today|tomorrow)\b/gi, '')
    broader = broader.replace(/\b(about|regarding|concerning|from|to|with)\b/gi, '')
    broader = broader.replace(/\s+/g, ' ').trim()
    return broader.length > 3 ? broader : query
  }

  it('should remove time constraints', () => {
    expect(broadenQuery('meeting yesterday')).toBe('meeting')
    expect(broadenQuery('emails last week')).toBe('emails')
    expect(broadenQuery('events next month')).toBe('events')
  })

  it('should remove prepositions', () => {
    expect(broadenQuery('meeting with John')).toBe('meeting John')
    expect(broadenQuery('email from Sarah')).toBe('email Sarah')
  })

  it('should clean up whitespace', () => {
    expect(broadenQuery('meeting   with   John')).toBe('meeting John')
  })

  it('should return original if result too short', () => {
    expect(broadenQuery('from me')).toBe('from me')
  })
})

// ============ RECIPROCAL RANK FUSION ============

describe('Reciprocal Rank Fusion (RRF)', () => {
  const RRF_K = 60

  const reciprocalRankFusion = (resultSets, keyField) => {
    const scores = new Map()

    for (const results of resultSets) {
      for (let rank = 0; rank < results.length; rank++) {
        const doc = results[rank]
        const key = doc[keyField]
        if (!key) continue

        const rrfScore = 1 / (RRF_K + rank + 1)
        const existing = scores.get(key)

        if (existing) {
          existing.rrfScore += rrfScore
          if (doc._distance && (!existing.doc._distance || doc._distance < existing.doc._distance)) {
            existing.doc = doc
          }
        } else {
          scores.set(key, { doc, rrfScore })
        }
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .map(({ doc, rrfScore }) => ({ ...doc, _rrfScore: rrfScore }))
  }

  it('should merge results from multiple sets', () => {
    const set1 = [{ id: 'a', _distance: 0.1 }, { id: 'b', _distance: 0.2 }]
    const set2 = [{ id: 'b', _distance: 0.15 }, { id: 'c', _distance: 0.3 }]

    const merged = reciprocalRankFusion([set1, set2], 'id')

    expect(merged.length).toBe(3)
    // 'b' appears in both sets, should have higher RRF score
    const bResult = merged.find(r => r.id === 'b')
    const aResult = merged.find(r => r.id === 'a')
    expect(bResult._rrfScore).toBeGreaterThan(aResult._rrfScore)
  })

  it('should sort by RRF score descending', () => {
    const set1 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const set2 = [{ id: 'c' }, { id: 'a' }, { id: 'b' }]

    const merged = reciprocalRankFusion([set1, set2], 'id')

    // All items appear in both sets at different ranks
    // Verify sorted by _rrfScore
    for (let i = 0; i < merged.length - 1; i++) {
      expect(merged[i]._rrfScore).toBeGreaterThanOrEqual(merged[i + 1]._rrfScore)
    }
  })

  it('should handle empty result sets', () => {
    const set1 = [{ id: 'a' }]
    const set2 = []

    const merged = reciprocalRankFusion([set1, set2], 'id')
    expect(merged.length).toBe(1)
  })

  it('should skip items without key field', () => {
    const set1 = [{ id: 'a' }, { noId: 'x' }]

    const merged = reciprocalRankFusion([set1], 'id')
    expect(merged.length).toBe(1)
  })
})

// ============ JUNK MAIL FILTERING ============

describe('Junk Mail Filtering', () => {
  const EXCLUDED_MAILBOXES = ['junk', 'trash', 'deleted messages', 'spam']

  const excludeJunkMail = (results, includeJunk = false, explicitMailbox = null) => {
    if (includeJunk || explicitMailbox) return results
    return results.filter(r =>
      !EXCLUDED_MAILBOXES.some(mb =>
        (r.mailbox || "").toLowerCase().includes(mb)
      )
    )
  }

  it('should filter out junk mail by default', () => {
    const results = [
      { mailbox: 'INBOX', subject: 'Important' },
      { mailbox: 'Junk', subject: 'Spam offer' },
      { mailbox: 'Archive', subject: 'Old email' }
    ]
    const filtered = excludeJunkMail(results)
    expect(filtered.length).toBe(2)
    expect(filtered.every(r => r.mailbox !== 'Junk')).toBe(true)
  })

  it('should filter out trash', () => {
    const results = [
      { mailbox: 'INBOX', subject: 'Important' },
      { mailbox: 'Trash', subject: 'Deleted' }
    ]
    const filtered = excludeJunkMail(results)
    expect(filtered.length).toBe(1)
  })

  it('should include junk when explicitly requested', () => {
    const results = [
      { mailbox: 'INBOX', subject: 'Important' },
      { mailbox: 'Junk', subject: 'Spam offer' }
    ]
    const filtered = excludeJunkMail(results, true)
    expect(filtered.length).toBe(2)
  })

  it('should not filter when explicit mailbox specified', () => {
    const results = [
      { mailbox: 'Junk', subject: 'Spam offer' }
    ]
    const filtered = excludeJunkMail(results, false, 'Junk')
    expect(filtered.length).toBe(1)
  })
})

describe('Formatter error surfacing', () => {
  it('should show calendar source errors instead of "no events"', async () => {
    const { formatUpcomingEventsResults, formatRecurringEventsResults, formatMessageContactsResults } =
      await import('../../search.js')

    expect(formatUpcomingEventsResults({ events: [], error: 'database is locked' }))
      .toContain('database is locked')
    expect(formatRecurringEventsResults({ events: [], error: 'authorization denied' }))
      .toContain('authorization denied')
    expect(formatMessageContactsResults({ error: 'unable to open database' }))
      .toContain('unable to open database')
  })

  it('should mention truncated result sets', async () => {
    const { formatEmailResults } = await import('../../search.js')
    const text = formatEmailResults({
      success: true,
      hasMore: true,
      showing: 1,
      results: [{
        rank: 1,
        from: 'a@b.com',
        to: 'c@d.com',
        subject: 'Hi',
        date: 'today',
        preview: 'hello',
        filePath: '/tmp/x.emlx'
      }]
    })
    expect(text).toContain('More matches exist')
  })
})
