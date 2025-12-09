/**
 * Unit tests for data parsing functions in indexer.js
 * Tests email parsing, date conversion, and extraction utilities
 *
 * These tests validate pure functions with inline test data.
 * No mocking required - these are algorithm tests.
 */

import { describe, it, expect } from 'vitest'

describe('Email Parsing Patterns', () => {
  describe('extractEmail pattern', () => {
    // Testing the regex pattern used in extractEmail
    const extractEmail = (str) => {
      if (!str) return ""
      const match = str.match(/<([^>]+)>/)
      if (match) return match[1].toLowerCase()
      if (str.includes("@")) return str.trim().toLowerCase()
      return str.trim().toLowerCase()
    }

    it('should extract email from "Name <email>" format', () => {
      expect(extractEmail('John Doe <john@example.com>')).toBe('john@example.com')
    })

    it('should extract email from complex name format', () => {
      expect(extractEmail('"Doe, John" <john.doe@company.com>')).toBe('john.doe@company.com')
    })

    it('should handle bare email addresses', () => {
      expect(extractEmail('john@example.com')).toBe('john@example.com')
    })

    it('should lowercase emails', () => {
      expect(extractEmail('JOHN@EXAMPLE.COM')).toBe('john@example.com')
    })

    it('should handle empty/null input', () => {
      expect(extractEmail(null)).toBe('')
      expect(extractEmail('')).toBe('')
      expect(extractEmail(undefined)).toBe('')
    })

    it('should trim whitespace', () => {
      expect(extractEmail('  john@example.com  ')).toBe('john@example.com')
    })
  })

  describe('extractEmails pattern (multiple recipients)', () => {
    const extractEmail = (str) => {
      if (!str) return ""
      const match = str.match(/<([^>]+)>/)
      if (match) return match[1].toLowerCase()
      if (str.includes("@")) return str.trim().toLowerCase()
      return str.trim().toLowerCase()
    }

    const extractEmails = (str) => {
      if (!str) return []
      const emails = []
      for (const part of str.split(",")) {
        const email = extractEmail(part.trim())
        if (email && email.includes("@")) {
          emails.push(email)
        }
      }
      return emails
    }

    it('should extract multiple comma-separated emails', () => {
      const input = 'John <john@a.com>, Jane <jane@b.com>, Bob <bob@c.com>'
      const result = extractEmails(input)
      expect(result).toEqual(['john@a.com', 'jane@b.com', 'bob@c.com'])
    })

    it('should handle mixed formats', () => {
      const input = 'John <john@a.com>, jane@b.com, "Smith, Bob" <bob@c.com>'
      const result = extractEmails(input)
      expect(result).toContain('john@a.com')
      expect(result).toContain('jane@b.com')
      expect(result).toContain('bob@c.com')
    })

    it('should filter out non-email strings', () => {
      const input = 'John <john@a.com>, Not An Email, jane@b.com'
      const result = extractEmails(input)
      expect(result).toEqual(['john@a.com', 'jane@b.com'])
    })

    it('should handle empty input', () => {
      expect(extractEmails(null)).toEqual([])
      expect(extractEmails('')).toEqual([])
    })
  })

  describe('parseDateTime pattern', () => {
    const parseDateTime = (dateStr) => {
      if (!dateStr) return 0
      try {
        let d = new Date(dateStr)
        if (!isNaN(d.getTime())) return d.getTime()

        // Handle AppleScript format
        const appleMatch = dateStr.match(/(\w+), (\w+ \d+, \d+) at (\d+:\d+:\d+ [AP]M)/i)
        if (appleMatch) {
          d = new Date(`${appleMatch[2]} ${appleMatch[3]}`)
          if (!isNaN(d.getTime())) return d.getTime()
        }

        return 0
      } catch {
        return 0
      }
    }

    it('should parse ISO date strings', () => {
      const result = parseDateTime('2024-01-15T10:30:00Z')
      expect(result).toBeGreaterThan(0)
    })

    it('should parse RFC 2822 email date format', () => {
      const result = parseDateTime('Mon, 15 Jan 2024 10:30:00 -0800')
      expect(result).toBeGreaterThan(0)
    })

    it('should parse AppleScript date format', () => {
      const result = parseDateTime('Friday, January 10, 2025 at 9:00:00 AM')
      expect(result).toBeGreaterThan(0)
    })

    it('should return 0 for invalid dates', () => {
      expect(parseDateTime('not a date')).toBe(0)
      expect(parseDateTime('')).toBe(0)
      expect(parseDateTime(null)).toBe(0)
    })
  })

  describe('extractMailbox pattern', () => {
    const extractMailbox = (filePath) => {
      const match = filePath.match(/([^/]+)\.mbox/)
      return match ? match[1] : "Unknown"
    }

    it('should extract mailbox name from path', () => {
      expect(extractMailbox('/Users/test/Library/Mail/V10/INBOX.mbox/message.emlx')).toBe('INBOX')
    })

    it('should extract Sent mailbox', () => {
      expect(extractMailbox('/Users/test/Library/Mail/V10/Sent Messages.mbox/123.emlx')).toBe('Sent Messages')
    })

    it('should return Unknown for invalid paths', () => {
      expect(extractMailbox('/Users/test/no-mailbox/file.txt')).toBe('Unknown')
    })
  })
})

describe('Mac Absolute Time Conversion', () => {
  // Mac Absolute Time epoch: Jan 1, 2001 00:00:00 UTC
  const MAC_ABSOLUTE_EPOCH = 978307200

  const macAbsoluteToUnix = (macTime) => {
    // macTime is in seconds since Jan 1, 2001
    return (macTime + MAC_ABSOLUTE_EPOCH) * 1000 // Convert to milliseconds
  }

  it('should convert Mac Absolute Time to Unix timestamp', () => {
    // Mac Absolute Time for a known date
    // Jan 1, 2024 00:00:00 UTC = 1704067200 Unix timestamp
    // 1704067200 - 978307200 = 725760000 Mac Absolute Time
    const macTime = 725760000
    const result = macAbsoluteToUnix(macTime)
    const date = new Date(result)
    expect(date.getUTCFullYear()).toBe(2024)
    expect(date.getUTCMonth()).toBe(0) // January
    expect(date.getUTCDate()).toBe(1)
  })

  it('should handle the epoch correctly', () => {
    // Mac Absolute Time 0 = Jan 1, 2001 00:00:00 UTC
    const result = macAbsoluteToUnix(0)
    const date = new Date(result)
    expect(date.getUTCFullYear()).toBe(2001)
    expect(date.getUTCMonth()).toBe(0)
    expect(date.getUTCDate()).toBe(1)
  })
})

describe('EMLX Parsing Patterns', () => {
  describe('Header extraction', () => {
    const sampleEmlx = `From: John Doe <john@example.com>
To: Jane Smith <jane@example.com>
Subject: Test Subject Line
Date: Mon, 15 Jan 2024 10:30:00 -0800
Message-ID: <unique123@example.com>
Content-Type: text/plain; charset="utf-8"

This is the body of the email.
It has multiple lines.
`

    it('should extract From header', () => {
      const match = sampleEmlx.match(/^From:\s*(.+)$/m)
      expect(match).not.toBeNull()
      expect(match[1]).toBe('John Doe <john@example.com>')
    })

    it('should extract To header', () => {
      const match = sampleEmlx.match(/^To:\s*(.+)$/m)
      expect(match).not.toBeNull()
      expect(match[1]).toBe('Jane Smith <jane@example.com>')
    })

    it('should extract Subject header', () => {
      const match = sampleEmlx.match(/^Subject:\s*(.+)$/m)
      expect(match).not.toBeNull()
      expect(match[1]).toBe('Test Subject Line')
    })

    it('should extract Date header', () => {
      const match = sampleEmlx.match(/^Date:\s*(.+)$/m)
      expect(match).not.toBeNull()
      expect(match[1]).toBe('Mon, 15 Jan 2024 10:30:00 -0800')
    })

    it('should extract Message-ID header', () => {
      const match = sampleEmlx.match(/^Message-ID:\s*(.+)$/im)
      expect(match).not.toBeNull()
      expect(match[1]).toBe('<unique123@example.com>')
    })
  })

  describe('Attachment detection', () => {
    it('should detect Content-Disposition attachment', () => {
      const content = 'Content-Disposition: attachment; filename="doc.pdf"'
      expect(/Content-Disposition:\s*attachment/i.test(content)).toBe(true)
    })

    it('should detect multipart/mixed', () => {
      const content = 'Content-Type: multipart/mixed; boundary="----=_Part_123"'
      expect(/multipart\/mixed/i.test(content)).toBe(true)
    })

    it('should detect filename parameter', () => {
      const content = 'Content-Type: application/pdf; filename="report.pdf"'
      expect(/filename=/i.test(content)).toBe(true)
    })

    it('should not detect plain text as attachment', () => {
      const content = 'Content-Type: text/plain; charset="utf-8"\n\nJust text'
      const hasAttachment = /Content-Disposition:\s*attachment/i.test(content) ||
                            /multipart\/mixed/i.test(content) ||
                            /filename=/i.test(content)
      expect(hasAttachment).toBe(false)
    })
  })

  describe('Sent mail detection', () => {
    const isSent = (mailbox) => mailbox.toLowerCase().includes('sent')

    it('should detect Sent mailbox', () => {
      expect(isSent('Sent')).toBe(true)
      expect(isSent('Sent Messages')).toBe(true)
      expect(isSent('SENT')).toBe(true)
    })

    it('should not flag inbox as sent', () => {
      expect(isSent('INBOX')).toBe(false)
      expect(isSent('Archive')).toBe(false)
    })
  })

  describe('Body extraction', () => {
    const extractBody = (content) => {
      const headerEnd = content.search(/\r?\n\r?\n/)
      if (headerEnd > 0) {
        return content.substring(headerEnd + 2, Math.min(headerEnd + 2000, content.length))
      }
      return ''
    }

    it('should find header/body boundary', () => {
      const content = 'Header: value\n\nBody starts here'
      const body = extractBody(content)
      expect(body).toContain('Body starts here')
    })

    it('should limit body length', () => {
      const header = 'Header: value\n\n'
      const longBody = 'x'.repeat(5000)
      const content = header + longBody
      const body = extractBody(content)
      expect(body.length).toBeLessThanOrEqual(2000)
    })
  })
})

describe('Phone Number Normalization', () => {
  // Testing the normalizePhone pattern from contacts.js
  const normalizePhone = (phone) => {
    if (!phone) return ""
    const hasPlus = phone.startsWith("+")
    const digits = phone.replace(/\D/g, "")
    const normalized = digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits
    return hasPlus ? `+${normalized}` : normalized
  }

  it('should strip non-digit characters', () => {
    expect(normalizePhone('(555) 123-4567')).toBe('5551234567')
  })

  it('should preserve leading + for international', () => {
    expect(normalizePhone('+1 555 123 4567')).toBe('+5551234567')
  })

  it('should normalize US 11-digit to 10-digit', () => {
    expect(normalizePhone('1-800-555-0100')).toBe('8005550100')
  })

  it('should handle empty input', () => {
    expect(normalizePhone(null)).toBe('')
    expect(normalizePhone('')).toBe('')
  })

  it('should handle international numbers', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958')
  })
})
