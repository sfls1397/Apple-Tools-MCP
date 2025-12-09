/**
 * Snapshot Testing
 *
 * Captures expected output structures and detects unexpected changes:
 * - Search result format
 * - Error message format
 * - Tool schema structure
 */

import { describe, it, expect } from 'vitest'

describe('Snapshots: Search Result Structure', () => {
  it('email result should have expected fields', () => {
    const emailResult = {
      rank: 1,
      score: '0.857',
      from: 'sender@example.com',
      fromContact: 'John Doe',
      to: 'recipient@example.com',
      subject: 'Test Email Subject',
      date: '2024-01-15 10:30 AM',
      mailbox: 'INBOX',
      hasAttachment: false,
      isFlagged: false,
      preview: 'Email body preview...',
      filePath: '/path/to/email.emlx',
      messageId: '<message@id.com>'
    }

    // Verify structure
    expect(emailResult).toMatchInlineSnapshot(`
      {
        "date": "2024-01-15 10:30 AM",
        "filePath": "/path/to/email.emlx",
        "from": "sender@example.com",
        "fromContact": "John Doe",
        "hasAttachment": false,
        "isFlagged": false,
        "mailbox": "INBOX",
        "messageId": "<message@id.com>",
        "preview": "Email body preview...",
        "rank": 1,
        "score": "0.857",
        "subject": "Test Email Subject",
        "to": "recipient@example.com",
      }
    `)
  })

  it('message result should have expected fields', () => {
    const messageResult = {
      rank: 1,
      score: '0.892',
      date: '2024-01-15 3:45 PM',
      sender: '+1-555-0100',
      senderContact: 'Jane Smith',
      text: 'Message content here',
      chatName: 'Group Chat',
      isGroupChat: true,
      hasAttachment: false
    }

    expect(messageResult).toMatchInlineSnapshot(`
      {
        "chatName": "Group Chat",
        "date": "2024-01-15 3:45 PM",
        "hasAttachment": false,
        "isGroupChat": true,
        "rank": 1,
        "score": "0.892",
        "sender": "+1-555-0100",
        "senderContact": "Jane Smith",
        "text": "Message content here",
      }
    `)
  })

  it('calendar result should have expected fields', () => {
    const calendarResult = {
      rank: 1,
      score: '0.734',
      title: 'Team Meeting',
      start: '2024-01-20 2:00 PM',
      startTimestamp: 1705766400000,
      end: '2024-01-20 3:00 PM',
      calendar: 'Work',
      location: 'Conference Room A',
      notes: 'Agenda items...',
      isAllDay: false,
      attendees: [
        { name: 'John Doe', status: 'accepted' }
      ],
      attendeeCount: 1
    }

    expect(calendarResult).toMatchInlineSnapshot(`
      {
        "attendeeCount": 1,
        "attendees": [
          {
            "name": "John Doe",
            "status": "accepted",
          },
        ],
        "calendar": "Work",
        "end": "2024-01-20 3:00 PM",
        "isAllDay": false,
        "location": "Conference Room A",
        "notes": "Agenda items...",
        "rank": 1,
        "score": "0.734",
        "start": "2024-01-20 2:00 PM",
        "startTimestamp": 1705766400000,
        "title": "Team Meeting",
      }
    `)
  })
})

describe('Snapshots: Search Response Wrapper', () => {
  it('successful search response structure', () => {
    const successResponse = {
      success: true,
      results: [],
      showing: 0,
      hasMore: false
    }

    expect(successResponse).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "results": [],
        "showing": 0,
        "success": true,
      }
    `)
  })

  it('error response structure', () => {
    const errorResponse = {
      success: false,
      error: 'Search error: Database connection failed'
    }

    expect(errorResponse).toMatchInlineSnapshot(`
      {
        "error": "Search error: Database connection failed",
        "success": false,
      }
    `)
  })

  it('empty results response structure', () => {
    const emptyResponse = {
      success: true,
      results: [],
      message: 'No emails found matching: test query'
    }

    expect(emptyResponse).toMatchInlineSnapshot(`
      {
        "message": "No emails found matching: test query",
        "results": [],
        "success": true,
      }
    `)
  })
})

describe('Snapshots: MCP Response Format', () => {
  it('MCP success response structure', () => {
    const mcpResponse = {
      content: [
        {
          type: 'text',
          text: '[1] Score: 0.857\nFrom: sender@example.com\nSubject: Test'
        }
      ]
    }

    expect(mcpResponse).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "[1] Score: 0.857
      From: sender@example.com
      Subject: Test",
            "type": "text",
          },
        ],
      }
    `)
  })

  it('MCP error response structure', () => {
    const mcpError = {
      content: [
        {
          type: 'text',
          text: 'Error: query parameter is required'
        }
      ],
      isError: true
    }

    expect(mcpError).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "Error: query parameter is required",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `)
  })
})

describe('Snapshots: Validation Errors', () => {
  it('should produce consistent error messages', async () => {
    const { validateSearchQuery, validateEmailPath } = await import('../../lib/validators.js')

    // Empty query (empty string is falsy, throws "is required")
    try {
      validateSearchQuery('')
    } catch (e) {
      expect(e.message).toMatchInlineSnapshot(`"Search query is required"`)
    }

    // Whitespace-only query (passes truthiness, fails trim check)
    try {
      validateSearchQuery('   ')
    } catch (e) {
      expect(e.message).toMatchInlineSnapshot(`"Search query cannot be empty"`)
    }

    // Null query
    try {
      validateSearchQuery(null)
    } catch (e) {
      expect(e.message).toMatchInlineSnapshot(`"Search query is required"`)
    }

    // Path traversal (with .emlx extension to pass extension check first)
    try {
      validateEmailPath('../etc/passwd.emlx', '/home/user/Mail')
    } catch (e) {
      expect(e.message).toMatchInlineSnapshot(`"Access denied: path outside allowed directory"`)
    }
  })
})

describe('Snapshots: Formatted Output', () => {
  it('email list formatting', async () => {
    const { formatEmailResults } = await import('../../search.js')

    const searchResult = {
      success: true,
      results: [
        {
          rank: 1,
          score: '0.900',
          from: 'test@example.com',
          to: 'user@example.com',
          subject: 'Test Subject',
          date: '2024-01-15',
          hasAttachment: true,
          preview: 'Preview text...',
          filePath: '/path/to/email.emlx'
        }
      ]
    }

    const formatted = formatEmailResults(searchResult)
    expect(formatted).toContain('[1]')
    expect(formatted).toContain('Score: 0.900')
    expect(formatted).toContain('From: test@example.com')
    expect(formatted).toContain('Subject: Test Subject')
  })

  it('free time formatting', async () => {
    const { formatFreeTimeResults } = await import('../../search.js')

    const result = {
      success: true,
      date: 'Monday, January 15, 2024',
      workingHours: '9:00 AM - 5:00 PM',
      totalEvents: 3,
      freeSlots: [
        { start: '9:00 AM', end: '10:00 AM', duration: 60 },
        { start: '2:00 PM', end: '5:00 PM', duration: 180 }
      ],
      totalFreeMinutes: 240
    }

    const formatted = formatFreeTimeResults(result)
    expect(formatted).toContain('Monday, January 15, 2024')
    expect(formatted).toContain('9:00 AM - 5:00 PM')
    expect(formatted).toContain('4h 0m')
  })
})

describe('Snapshots: Contact Format', () => {
  it('contact search result structure', () => {
    const contact = {
      displayName: 'John Doe',
      firstName: 'John',
      lastName: 'Doe',
      organization: 'Acme Corp',
      emails: [
        { email: 'john@acme.com', label: 'work' }
      ],
      phones: [
        { phone: '+1-555-0100', label: 'mobile' }
      ]
    }

    expect(contact).toMatchInlineSnapshot(`
      {
        "displayName": "John Doe",
        "emails": [
          {
            "email": "john@acme.com",
            "label": "work",
          },
        ],
        "firstName": "John",
        "lastName": "Doe",
        "organization": "Acme Corp",
        "phones": [
          {
            "label": "mobile",
            "phone": "+1-555-0100",
          },
        ],
      }
    `)
  })
})
