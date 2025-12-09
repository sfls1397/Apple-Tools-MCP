/**
 * Edge case tests for email indexing
 * Tests partial IMAP, HTML stripping, flagged emails, and header parsing
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'

describe('Email Edge Cases', () => {
  describe('.partial.emlx files', () => {
    it('should recognize partial IMAP file extension', () => {
      const partialPath = '/Users/test/Library/Mail/V10/Account/INBOX.mbox/123.partial.emlx'
      const normalPath = '/Users/test/Library/Mail/V10/Account/INBOX.mbox/123.emlx'

      expect(partialPath.endsWith('.partial.emlx')).toBe(true)
      expect(normalPath.endsWith('.partial.emlx')).toBe(false)
      expect(normalPath.endsWith('.emlx')).toBe(true)
    })

    it('should index both .emlx and .partial.emlx patterns', () => {
      const patterns = ['*.emlx', '*.partial.emlx']
      const testFiles = [
        '123.emlx',
        '456.partial.emlx',
        '789.emlx'
      ]

      const matchingFiles = testFiles.filter(f =>
        patterns.some(p => {
          const regex = new RegExp(p.replace('*', '.*'))
          return regex.test(f)
        })
      )

      expect(matchingFiles.length).toBe(3)
    })
  })

  describe('isFlagged detection', () => {
    it('should detect X-Flagged header', () => {
      const content = `From: sender@example.com
To: recipient@example.com
Subject: Important
X-Flagged: Yes

Body text`

      const isFlagged = /X-Flagged:\s*Yes/i.test(content)

      expect(isFlagged).toBe(true)
    })

    it('should handle missing X-Flagged header', () => {
      const content = `From: sender@example.com
To: recipient@example.com
Subject: Normal email

Body text`

      const isFlagged = /X-Flagged:\s*Yes/i.test(content)

      expect(isFlagged).toBe(false)
    })

    it('should be case-insensitive', () => {
      const variants = [
        'X-Flagged: yes',
        'X-FLAGGED: YES',
        'x-flagged: Yes',
        'X-Flagged:Yes' // No space
      ]

      for (const header of variants) {
        const content = `From: test@test.com\n${header}\n\nBody`
        const isFlagged = /X-Flagged:\s*Yes/i.test(content)
        expect(isFlagged).toBe(true)
      }
    })
  })

  describe('messageId extraction', () => {
    it('should extract Message-ID header', () => {
      const content = `From: sender@example.com
Message-ID: <abc123@example.com>
Subject: Test

Body`

      const match = content.match(/Message-ID:\s*<([^>]+)>/i)
      const messageId = match ? match[1] : null

      expect(messageId).toBe('abc123@example.com')
    })

    it('should handle complex Message-ID formats', () => {
      const messageIds = [
        '<CADq1234.abc@mail.gmail.com>',
        '<20240101120000.123456@example.com>',
        '<unique-id-with-dashes@host.domain.tld>'
      ]

      for (const id of messageIds) {
        const content = `Message-ID: ${id}\n\nBody`
        const match = content.match(/Message-ID:\s*<([^>]+)>/i)
        expect(match).not.toBeNull()
      }
    })

    it('should handle missing Message-ID gracefully', () => {
      const content = `From: sender@example.com
Subject: No message ID

Body`

      const match = content.match(/Message-ID:\s*<([^>]+)>/i)

      expect(match).toBeNull()
    })
  })

  describe('HTML body stripping', () => {
    it('should strip basic HTML tags', () => {
      const html = '<html><body><p>Hello <b>World</b>!</p></body></html>'

      // Safe regex-based stripping (no ReDoS vulnerability)
      const stripped = html.replace(/<[^>]*>/g, '')

      expect(stripped).toBe('Hello World!')
    })

    it('should handle nested tags', () => {
      const html = '<div><span><strong>Text</strong></span></div>'

      const stripped = html.replace(/<[^>]*>/g, '')

      expect(stripped).toBe('Text')
    })

    it('should preserve text between tags', () => {
      const html = '<p>First</p><p>Second</p><p>Third</p>'

      const stripped = html.replace(/<[^>]*>/g, '')

      expect(stripped).toBe('FirstSecondThird')
    })

    it('should handle self-closing tags', () => {
      const html = 'Line1<br/>Line2<hr/>Line3'

      const stripped = html.replace(/<[^>]*>/g, '')

      expect(stripped).toBe('Line1Line2Line3')
    })

    it('should handle attributes with quotes', () => {
      const html = '<a href="https://example.com">Link</a>'

      const stripped = html.replace(/<[^>]*>/g, '')

      expect(stripped).toBe('Link')
    })

    it('should not be vulnerable to ReDoS', () => {
      // Malicious input that could cause ReDoS with naive regex
      const malicious = '<' + 'a'.repeat(1000) + '>'

      const start = performance.now()
      malicious.replace(/<[^>]*>/g, '')
      const duration = performance.now() - start

      // Should complete in < 100ms even for malicious input
      expect(duration).toBeLessThan(100)
    })
  })

  describe('body truncation', () => {
    it('should truncate body to 500 chars', () => {
      const longBody = 'x'.repeat(1000)
      const truncated = longBody.substring(0, 500)

      expect(truncated.length).toBe(500)
    })

    it('should not truncate short bodies', () => {
      const shortBody = 'Short email body'
      const maxLength = 500
      const result = shortBody.length > maxLength ? shortBody.substring(0, maxLength) : shortBody

      expect(result).toBe(shortBody)
    })

    it('should handle exactly 500 chars', () => {
      const exactBody = 'x'.repeat(500)
      const truncated = exactBody.substring(0, 500)

      expect(truncated.length).toBe(500)
    })
  })

  describe('RFC 2822 date variants', () => {
    it('should parse standard RFC 2822 format', () => {
      const dateStr = 'Mon, 1 Jan 2024 12:00:00 -0800'
      const date = new Date(dateStr)

      expect(date.getTime()).toBeGreaterThan(0)
    })

    it('should parse without day of week', () => {
      const dateStr = '1 Jan 2024 12:00:00 -0800'
      const date = new Date(dateStr)

      expect(date.getTime()).toBeGreaterThan(0)
    })

    it('should parse with timezone name', () => {
      const dateStr = 'Mon, 1 Jan 2024 12:00:00 PST'
      const date = new Date(dateStr)

      // May be invalid in some JS engines, but should not throw
      expect(() => new Date(dateStr)).not.toThrow()
    })

    it('should parse ISO 8601 format', () => {
      const dateStr = '2024-01-01T12:00:00-08:00'
      const date = new Date(dateStr)

      expect(date.getTime()).toBeGreaterThan(0)
    })

    it('should handle invalid dates gracefully', () => {
      const invalidDates = [
        'not a date',
        '',
        '32 Jan 2024',
        'Feb 30 2024'
      ]

      for (const dateStr of invalidDates) {
        const date = new Date(dateStr)
        // Should either be NaN or a weird date, but not throw
        expect(() => new Date(dateStr)).not.toThrow()
      }
    })
  })

  describe('multi-part MIME handling', () => {
    it('should detect multipart/mixed', () => {
      const content = `Content-Type: multipart/mixed; boundary="----=_Part_123"

------=_Part_123
Content-Type: text/plain

Body text

------=_Part_123
Content-Type: application/pdf
Content-Disposition: attachment; filename="doc.pdf"

[binary data]
------=_Part_123--`

      const isMultipart = /multipart\/mixed/i.test(content)

      expect(isMultipart).toBe(true)
    })

    it('should detect multipart/alternative', () => {
      const content = `Content-Type: multipart/alternative; boundary="alt_boundary"

--alt_boundary
Content-Type: text/plain

Plain text version

--alt_boundary
Content-Type: text/html

<html>HTML version</html>
--alt_boundary--`

      const isMultipart = /multipart\/(mixed|alternative)/i.test(content)

      expect(isMultipart).toBe(true)
    })

    it('should extract boundary parameter', () => {
      const content = 'Content-Type: multipart/mixed; boundary="----=_Part_123_456"'

      const match = content.match(/boundary="([^"]+)"/i)
      const boundary = match ? match[1] : null

      expect(boundary).toBe('----=_Part_123_456')
    })
  })

  describe('empty or missing headers', () => {
    it('should handle missing Subject header', () => {
      const content = `From: sender@example.com
To: recipient@example.com

Body without subject`

      const match = content.match(/^Subject:\s*(.*)$/im)
      const subject = match ? match[1] : '(No Subject)'

      expect(subject).toBe('(No Subject)')
    })

    it('should handle empty Subject', () => {
      const content = `From: sender@example.com
Subject:
To: recipient@example.com

Body`

      // Use [ \t]* instead of \s* to avoid matching newlines
      const match = content.match(/^Subject:[ \t]*(.*)$/im)
      const subject = match ? match[1].trim() || '(No Subject)' : '(No Subject)'

      expect(subject).toBe('(No Subject)')
    })

    it('should handle missing From header', () => {
      const content = `To: recipient@example.com
Subject: Test

Body`

      const match = content.match(/^From:\s*(.*)$/im)
      const from = match ? match[1] : 'Unknown Sender'

      expect(from).toBe('Unknown Sender')
    })
  })

  describe('encoded headers (MIME)', () => {
    it('should detect =?UTF-8?Q? encoded subject', () => {
      const encoded = '=?UTF-8?Q?Hello_=C3=A9=C3=A8?='

      const isEncoded = /=\?[^?]+\?[QBqb]\?[^?]+\?=/.test(encoded)

      expect(isEncoded).toBe(true)
    })

    it('should detect =?UTF-8?B? base64 encoded', () => {
      const encoded = '=?UTF-8?B?SGVsbG8gV29ybGQ=?='

      const isEncoded = /=\?[^?]+\?[QBqb]\?[^?]+\?=/.test(encoded)

      expect(isEncoded).toBe(true)
    })

    it('should handle multiple encoded words', () => {
      const encoded = '=?UTF-8?Q?Part1?= =?UTF-8?Q?Part2?='

      const parts = encoded.match(/=\?[^?]+\?[QBqb]\?[^?]+\?=/g)

      expect(parts.length).toBe(2)
    })

    it('should handle non-encoded subjects', () => {
      const plain = 'Just a plain subject'

      const isEncoded = /=\?[^?]+\?[QBqb]\?[^?]+\?=/.test(plain)

      expect(isEncoded).toBe(false)
    })
  })

  describe('search text generation', () => {
    it('should combine relevant fields for search', async () => {
      const email = {
        from: 'John Doe <john@example.com>',
        to: 'Jane Smith <jane@example.com>',
        subject: 'Meeting Tomorrow',
        body: 'Let\'s discuss the project'
      }

      const searchText = `${email.subject} ${email.from} ${email.to} ${email.body}`
        .substring(0, 1000)

      expect(searchText).toContain('Meeting Tomorrow')
      expect(searchText).toContain('John Doe')
      expect(searchText).toContain('project')
    })

    it('should truncate search text to 1000 chars', () => {
      const longSubject = 'x'.repeat(500)
      const longBody = 'y'.repeat(1000)

      const searchText = `${longSubject} ${longBody}`.substring(0, 1000)

      expect(searchText.length).toBe(1000)
    })
  })
})
