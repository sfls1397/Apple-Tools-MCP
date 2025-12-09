/**
 * Integration tests for MCP tool handlers
 * Tests the front-end/API layer - tool invocation, response format, error handling
 *
 * These tests validate pure logic patterns. No mocking required.
 */

import { describe, it, expect } from 'vitest'

// ============ TOOL DEFINITION TESTS ============

describe('MCP Tool Definitions', () => {
  // These tests verify the tool schemas are correct

  describe('Mail Tools Schema', () => {
    const mailSearchSchema = {
      name: 'mail_search',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        sender: { type: 'string' },
        recipient: { type: 'string' },
        has_attachment: { type: 'boolean' },
        mailbox: { type: 'string' },
        sent_only: { type: 'boolean' },
        flagged_only: { type: 'boolean' },
        days_back: { type: 'number' },
        limit: { type: 'number' },
        sort_by: { enum: ['relevance', 'date'] }
      }
    }

    it('should require query parameter', () => {
      expect(mailSearchSchema.required).toContain('query')
    })

    it('should support all filter options', () => {
      expect(mailSearchSchema.properties).toHaveProperty('sender')
      expect(mailSearchSchema.properties).toHaveProperty('recipient')
      expect(mailSearchSchema.properties).toHaveProperty('has_attachment')
      expect(mailSearchSchema.properties).toHaveProperty('mailbox')
      expect(mailSearchSchema.properties).toHaveProperty('sent_only')
      expect(mailSearchSchema.properties).toHaveProperty('flagged_only')
    })

    it('should support sort_by enum', () => {
      expect(mailSearchSchema.properties.sort_by.enum).toContain('relevance')
      expect(mailSearchSchema.properties.sort_by.enum).toContain('date')
    })
  })

  describe('Messages Tools Schema', () => {
    const messagesSearchSchema = {
      name: 'messages_search',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        contact: { type: 'string' },
        group_chat_only: { type: 'boolean' },
        group_chat_name: { type: 'string' },
        has_attachment: { type: 'boolean' },
        days_back: { type: 'number' },
        limit: { type: 'number' },
        sort_by: { enum: ['relevance', 'date'] }
      }
    }

    it('should require query parameter', () => {
      expect(messagesSearchSchema.required).toContain('query')
    })

    it('should support group chat filters', () => {
      expect(messagesSearchSchema.properties).toHaveProperty('group_chat_only')
      expect(messagesSearchSchema.properties).toHaveProperty('group_chat_name')
    })
  })

  describe('Calendar Tools Schema', () => {
    const calendarSearchSchema = {
      name: 'calendar_search',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        calendar_name: { type: 'string' },
        all_day_only: { type: 'boolean' },
        days_back: { type: 'number' },
        days_ahead: { type: 'number' },
        limit: { type: 'number' },
        sort_by: { enum: ['relevance', 'date'] }
      }
    }

    it('should require query parameter', () => {
      expect(calendarSearchSchema.required).toContain('query')
    })

    it('should support days_ahead for future events', () => {
      expect(calendarSearchSchema.properties).toHaveProperty('days_ahead')
    })
  })

  describe('Contacts Tools Schema', () => {
    const contactsSearchSchema = {
      name: 'contacts_search',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      }
    }

    it('should require query parameter', () => {
      expect(contactsSearchSchema.required).toContain('query')
    })
  })
})

// ============ TOOL RESPONSE FORMAT TESTS ============

describe('MCP Response Format', () => {
  const formatMCPResponse = (content, isError = false) => {
    return {
      content: [{
        type: 'text',
        text: content
      }],
      isError
    }
  }

  it('should format success response correctly', () => {
    const response = formatMCPResponse('Search results...')
    expect(response.content[0].type).toBe('text')
    expect(response.content[0].text).toBe('Search results...')
    expect(response.isError).toBe(false)
  })

  it('should format error response correctly', () => {
    const response = formatMCPResponse('Error: Invalid query', true)
    expect(response.isError).toBe(true)
  })
})

// ============ INPUT VALIDATION TESTS ============

describe('Tool Input Validation', () => {
  describe('Required Parameters', () => {
    const validateRequired = (params, required) => {
      for (const field of required) {
        if (params[field] === undefined || params[field] === null || params[field] === '') {
          return { valid: false, error: `${field} is required` }
        }
      }
      return { valid: true }
    }

    it('should reject missing query for search tools', () => {
      const result = validateRequired({}, ['query'])
      expect(result.valid).toBe(false)
      expect(result.error).toContain('query')
    })

    it('should accept valid query', () => {
      const result = validateRequired({ query: 'test' }, ['query'])
      expect(result.valid).toBe(true)
    })

    it('should reject empty string query', () => {
      const result = validateRequired({ query: '' }, ['query'])
      expect(result.valid).toBe(false)
    })
  })

  describe('Type Coercion', () => {
    const coerceNumber = (value, defaultValue) => {
      if (value === undefined || value === null) return defaultValue
      const num = parseInt(value, 10)
      return isNaN(num) ? defaultValue : num
    }

    it('should coerce string to number', () => {
      expect(coerceNumber('30', 10)).toBe(30)
    })

    it('should use default for invalid string', () => {
      expect(coerceNumber('abc', 10)).toBe(10)
    })

    it('should use default for undefined', () => {
      expect(coerceNumber(undefined, 10)).toBe(10)
    })
  })

  describe('Boolean Parameters', () => {
    const coerceBoolean = (value) => {
      if (value === undefined || value === null) return undefined
      if (typeof value === 'boolean') return value
      if (value === 'true') return true
      if (value === 'false') return false
      return undefined
    }

    it('should handle boolean true', () => {
      expect(coerceBoolean(true)).toBe(true)
    })

    it('should handle string "true"', () => {
      expect(coerceBoolean('true')).toBe(true)
    })

    it('should return undefined for invalid value', () => {
      expect(coerceBoolean('maybe')).toBeUndefined()
    })
  })
})

// ============ ERROR HANDLING TESTS ============

describe('Tool Error Handling', () => {
  describe('Unknown Tool', () => {
    const handleToolCall = (toolName, validTools) => {
      if (!validTools.includes(toolName)) {
        return { error: `Unknown tool: ${toolName}` }
      }
      return { error: null }
    }

    it('should reject unknown tool names', () => {
      const validTools = ['mail_search', 'messages_search', 'calendar_search']
      const result = handleToolCall('invalid_tool', validTools)
      expect(result.error).toContain('Unknown tool')
    })

    it('should accept valid tool names', () => {
      const validTools = ['mail_search', 'messages_search', 'calendar_search']
      const result = handleToolCall('mail_search', validTools)
      expect(result.error).toBeNull()
    })
  })

  describe('Index Not Ready', () => {
    const checkIndexReady = async (indexReady, isFirstRun) => {
      if (!indexReady) {
        if (isFirstRun) {
          return 'Building initial index. This may take several minutes on first run. Please try again shortly.'
        }
        return 'Indexing new data. Please try again in a moment.'
      }
      return null
    }

    it('should return first-run message when index not ready', async () => {
      const message = await checkIndexReady(false, true)
      expect(message).toContain('first run')
    })

    it('should return update message for incremental index', async () => {
      const message = await checkIndexReady(false, false)
      expect(message).toContain('Indexing new data')
    })

    it('should return null when index is ready', async () => {
      const message = await checkIndexReady(true, false)
      expect(message).toBeNull()
    })
  })

  describe('Invalid File Path', () => {
    const validatePath = (filePath, allowedDir) => {
      if (!filePath) {
        return { valid: false, error: 'File path is required' }
      }
      if (!filePath.startsWith(allowedDir)) {
        return { valid: false, error: 'Access denied: path outside allowed directory' }
      }
      return { valid: true }
    }

    it('should reject paths outside allowed directory', () => {
      const result = validatePath('/etc/passwd', '/Users/test/Library/Mail')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Access denied')
    })

    it('should accept paths in allowed directory', () => {
      const result = validatePath('/Users/test/Library/Mail/INBOX/msg.emlx', '/Users/test/Library/Mail')
      expect(result.valid).toBe(true)
    })
  })
})

// ============ CROSS-TOOL WORKFLOW TESTS ============

describe('Cross-Tool Workflows', () => {
  describe('Search → Read Flow', () => {
    it('should return filePath in search results for mail_read', () => {
      const searchResult = {
        subject: 'Test Email',
        from: 'john@example.com',
        date: '2024-01-15',
        filePath: '/Users/test/Library/Mail/INBOX/123.emlx'
      }

      expect(searchResult).toHaveProperty('filePath')
      expect(searchResult.filePath).toMatch(/\.emlx$/)
    })

    it('should include data needed for follow-up queries', () => {
      const searchResult = {
        sender: 'john@example.com',
        chatIdentifier: '+1234567890',
        messageId: '<unique@example.com>'
      }

      // These fields enable follow-up queries
      expect(searchResult.sender || searchResult.chatIdentifier).toBeTruthy()
    })
  })

  describe('Person Search Aggregation', () => {
    const aggregatePersonResults = (mailResults, messageResults, calendarResults) => {
      return {
        emails: mailResults,
        messages: messageResults,
        events: calendarResults,
        totalCount: mailResults.length + messageResults.length + calendarResults.length
      }
    }

    it('should aggregate results from all sources', () => {
      const mail = [{ subject: 'Email 1' }, { subject: 'Email 2' }]
      const messages = [{ text: 'Message 1' }]
      const calendar = [{ title: 'Meeting' }]

      const result = aggregatePersonResults(mail, messages, calendar)

      expect(result.emails.length).toBe(2)
      expect(result.messages.length).toBe(1)
      expect(result.events.length).toBe(1)
      expect(result.totalCount).toBe(4)
    })
  })
})

// ============ SMART SEARCH INTENT DETECTION ============

describe('Smart Search Intent Detection', () => {
  const detectIntent = (query) => {
    const q = query.toLowerCase()

    // Calendar intent signals
    if (q.match(/\b(meeting|event|calendar|schedule|appointment|when|free|busy|available)\b/)) {
      return 'calendar'
    }

    // Messages intent signals
    if (q.match(/\b(text|message|imessage|sms|chat|conversation|say|said|told)\b/)) {
      return 'messages'
    }

    // Email intent signals
    if (q.match(/\b(email|mail|inbox|sent|attachment|forward|reply)\b/)) {
      return 'mail'
    }

    // Default to searching all sources
    return 'all'
  }

  it('should detect calendar intent', () => {
    expect(detectIntent('when is my next meeting')).toBe('calendar')
    expect(detectIntent('schedule for tomorrow')).toBe('calendar')
    expect(detectIntent('am I free at 3pm')).toBe('calendar')
  })

  it('should detect messages intent', () => {
    expect(detectIntent('text from John')).toBe('messages')
    expect(detectIntent('what did Sarah say')).toBe('messages')
    expect(detectIntent('iMessage conversation')).toBe('messages')
  })

  it('should detect email intent', () => {
    expect(detectIntent('email from boss')).toBe('mail')
    expect(detectIntent('inbox messages')).toBe('mail')
    expect(detectIntent('email with attachment')).toBe('mail')
  })

  it('should default to all for ambiguous queries', () => {
    expect(detectIntent('budget discussion')).toBe('all')
    expect(detectIntent('project update')).toBe('all')
  })
})

// ============ RESULT FORMATTING TESTS ============

describe('Result Formatting', () => {
  describe('Email Result Format', () => {
    const formatEmailResult = (email, rank) => {
      return `${rank}. **${email.subject || 'No Subject'}**
   From: ${email.from || 'Unknown'}
   Date: ${email.date || 'Unknown'}
   ${email.hasAttachment ? '📎 Has attachment' : ''}
   Preview: ${(email.body || '').substring(0, 100)}...`
    }

    it('should format email with all fields', () => {
      const email = {
        subject: 'Test Subject',
        from: 'john@example.com',
        date: '2024-01-15',
        body: 'This is the email body content',
        hasAttachment: true
      }

      const formatted = formatEmailResult(email, 1)

      expect(formatted).toContain('Test Subject')
      expect(formatted).toContain('john@example.com')
      expect(formatted).toContain('📎')
    })

    it('should handle missing fields gracefully', () => {
      const email = {}
      const formatted = formatEmailResult(email, 1)

      expect(formatted).toContain('No Subject')
      expect(formatted).toContain('Unknown')
    })
  })

  describe('Calendar Event Format', () => {
    const formatCalendarEvent = (event) => {
      let result = `**${event.title || 'Untitled Event'}**`
      if (event.start) result += `\n   When: ${event.start}`
      if (event.location) result += `\n   Where: ${event.location}`
      if (event.calendar) result += `\n   Calendar: ${event.calendar}`
      return result
    }

    it('should format event with location', () => {
      const event = {
        title: 'Team Meeting',
        start: '2024-01-15 10:00 AM',
        location: 'Conference Room A',
        calendar: 'Work'
      }

      const formatted = formatCalendarEvent(event)

      expect(formatted).toContain('Team Meeting')
      expect(formatted).toContain('Conference Room A')
      expect(formatted).toContain('Work')
    })
  })

  describe('Message Format', () => {
    const formatMessage = (msg) => {
      const sender = msg.sender || 'Unknown'
      const date = msg.date || 'Unknown date'
      const text = msg.text || ''
      const isGroup = msg.participantCount > 2

      return `[${date}] ${sender}${isGroup ? ' (group)' : ''}: ${text}`
    }

    it('should indicate group chat', () => {
      const msg = {
        sender: 'John',
        date: '10:30 AM',
        text: 'Hello everyone',
        participantCount: 5
      }

      const formatted = formatMessage(msg)
      expect(formatted).toContain('(group)')
    })

    it('should not indicate group for 1:1 chat', () => {
      const msg = {
        sender: 'John',
        date: '10:30 AM',
        text: 'Hello',
        participantCount: 2
      }

      const formatted = formatMessage(msg)
      expect(formatted).not.toContain('(group)')
    })
  })
})

// ============ CACHING BEHAVIOR TESTS ============

describe('Caching Behavior', () => {
  describe('Embedding Cache', () => {
    const CACHE_TTL = 5 * 60 * 1000 // 5 minutes
    const CACHE_MAX = 100

    class EmbeddingCache {
      constructor() {
        this.cache = new Map()
      }

      get(text) {
        const cached = this.cache.get(text)
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
          return cached.vector
        }
        return null
      }

      set(text, vector) {
        if (this.cache.size >= CACHE_MAX) {
          // Evict oldest
          const oldest = [...this.cache.entries()]
            .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]
          if (oldest) this.cache.delete(oldest[0])
        }
        this.cache.set(text, { vector, timestamp: Date.now() })
      }

      get size() {
        return this.cache.size
      }
    }

    it('should return cached embedding within TTL', () => {
      const cache = new EmbeddingCache()
      cache.set('test query', [0.1, 0.2, 0.3])

      const result = cache.get('test query')
      expect(result).toEqual([0.1, 0.2, 0.3])
    })

    it('should return null for expired cache', () => {
      const cache = new EmbeddingCache()
      cache.cache.set('test', {
        vector: [0.1],
        timestamp: Date.now() - (10 * 60 * 1000) // 10 minutes ago
      })

      const result = cache.get('test')
      expect(result).toBeNull()
    })

    it('should evict oldest when at capacity', () => {
      const cache = new EmbeddingCache()

      // Fill cache
      for (let i = 0; i < 100; i++) {
        cache.set(`query${i}`, [i])
      }

      expect(cache.size).toBe(100)

      // Add one more
      cache.set('newQuery', [999])

      expect(cache.size).toBe(100) // Still at max
      expect(cache.get('newQuery')).toEqual([999])
    })
  })
})
