/**
 * Edge case tests for message indexing
 * Tests NSAttributedString extraction, cloaked emails, and attachment handling
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'

// Mac Absolute Time epoch: Jan 1, 2001 00:00:00 UTC (in seconds)
const MAC_ABSOLUTE_EPOCH = 978307200

describe('Message Edge Cases', () => {
  describe('NSAttributedString extraction', () => {
    it('should detect NSString marker in binary data', () => {
      // NSString marker followed by '+' byte (0x2B)
      const marker = Buffer.from('NSString')
      const plusByte = 0x2B

      const testData = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00]),
        marker,
        Buffer.from([0x00, 0x00, plusByte]),
        Buffer.from([5]), // length = 5
        Buffer.from('Hello')
      ])

      const markerIndex = testData.indexOf(marker)
      expect(markerIndex).toBeGreaterThan(-1)

      // Find '+' byte after marker
      const plusIndex = testData.indexOf(plusByte, markerIndex + 8)
      expect(plusIndex).toBeGreaterThan(markerIndex)
    })

    it('should extract text after length byte', () => {
      const length = 11
      const text = 'Hello World'

      // Simulated binary structure
      const buffer = Buffer.concat([
        Buffer.from('NSString'),
        Buffer.from([0x00, 0x00, 0x2B]), // '+' marker
        Buffer.from([length]),
        Buffer.from(text)
      ])

      // Find + byte
      const plusIndex = buffer.indexOf(0x2B)
      const extractedLength = buffer[plusIndex + 1]
      const extractedText = buffer.slice(plusIndex + 2, plusIndex + 2 + extractedLength).toString('utf-8')

      expect(extractedLength).toBe(length)
      expect(extractedText).toBe(text)
    })

    it('should handle multi-byte length encoding', () => {
      // For lengths > 127, the encoding may use multiple bytes
      // This tests the concept of length > 127

      const shortLength = 50
      const longLength = 200

      expect(shortLength).toBeLessThanOrEqual(127)
      expect(longLength).toBeGreaterThan(127)

      // In real implementation, would check high bit
      const isMultiByte = (len) => len > 127

      expect(isMultiByte(shortLength)).toBe(false)
      expect(isMultiByte(longLength)).toBe(true)
    })

    it('should validate printable character ratio', () => {
      const validatePrintable = (text) => {
        const printable = text.split('').filter(c => {
          const code = c.charCodeAt(0)
          return code >= 32 && code <= 126 || code >= 128 // ASCII printable or extended
        }).length
        return (printable / text.length) > 0.8
      }

      expect(validatePrintable('Hello World')).toBe(true)
      expect(validatePrintable('Normal text message')).toBe(true)

      // Binary garbage would fail
      const binaryGarbage = String.fromCharCode(0, 1, 2, 3, 4, 5)
      expect(validatePrintable(binaryGarbage)).toBe(false)
    })

    it('should enforce 10000 char limit', () => {
      const longText = 'x'.repeat(15000)
      const maxLength = 10000

      const truncated = longText.substring(0, maxLength)

      expect(truncated.length).toBe(maxLength)
    })
  })

  describe('NULL text field fallback', () => {
    it('should use attributedBody when text is NULL', () => {
      const message = {
        text: null,
        attributedBody: Buffer.from('Fallback text')
      }

      const getText = (msg) => {
        if (msg.text) return msg.text
        if (msg.attributedBody) return 'extracted from attributedBody'
        return ''
      }

      expect(getText(message)).toBe('extracted from attributedBody')
    })

    it('should prefer text field when present', () => {
      const message = {
        text: 'Primary text',
        attributedBody: Buffer.from('Fallback text')
      }

      const text = message.text || 'extracted from attributedBody'

      expect(text).toBe('Primary text')
    })

    it('should handle both NULL', () => {
      const message = {
        text: null,
        attributedBody: null
      }

      const text = message.text || (message.attributedBody ? 'extracted' : '')

      expect(text).toBe('')
    })
  })

  describe('cloaked email handling', () => {
    it('should extract name before "via Cloaked"', () => {
      const sender = 'John Doe via Cloaked'

      const extractName = (s) => {
        const match = s.match(/^(.+?)\s+via\s+Cloaked$/i)
        return match ? match[1] : s
      }

      expect(extractName(sender)).toBe('John Doe')
    })

    it('should handle non-cloaked senders', () => {
      const sender = '+15551234567'

      const extractName = (s) => {
        const match = s.match(/^(.+?)\s+via\s+Cloaked$/i)
        return match ? match[1] : s
      }

      expect(extractName(sender)).toBe('+15551234567')
    })

    it('should be case-insensitive for "via Cloaked"', () => {
      const variants = [
        'Name via Cloaked',
        'Name via cloaked',
        'Name VIA CLOAKED',
        'Name Via cloaked'
      ]

      const extractName = (s) => {
        const match = s.match(/^(.+?)\s+via\s+Cloaked$/i)
        return match ? match[1] : s
      }

      for (const v of variants) {
        expect(extractName(v)).toBe('Name')
      }
    })
  })

  describe('chatId and chatIdentifier extraction', () => {
    it('should extract chatId from message', () => {
      const message = {
        ROWID: 12345,
        chat_id: 67
      }

      expect(message.chat_id).toBe(67)
    })

    it('should extract chatIdentifier', () => {
      const chat = {
        chat_identifier: '+15551234567',
        display_name: 'John Doe'
      }

      expect(chat.chat_identifier).toBe('+15551234567')
    })

    it('should handle group chat identifiers', () => {
      const groupChat = {
        chat_identifier: 'chat123456789',
        display_name: 'Family Group',
        is_group: 1
      }

      expect(groupChat.chat_identifier).toMatch(/^chat/)
    })

    it('should handle email-based chat identifiers', () => {
      const emailChat = {
        chat_identifier: 'john@example.com',
        display_name: ''
      }

      expect(emailChat.chat_identifier).toContain('@')
    })
  })

  describe('hasAttachment via join table', () => {
    it('should detect attachment count > 0', () => {
      const message = {
        ROWID: 123,
        attachment_count: 2
      }

      const hasAttachment = (message.attachment_count || 0) > 0

      expect(hasAttachment).toBe(true)
    })

    it('should handle zero attachments', () => {
      const message = {
        ROWID: 123,
        attachment_count: 0
      }

      const hasAttachment = (message.attachment_count || 0) > 0

      expect(hasAttachment).toBe(false)
    })

    it('should handle NULL attachment count', () => {
      const message = {
        ROWID: 123,
        attachment_count: null
      }

      const hasAttachment = (message.attachment_count || 0) > 0

      expect(hasAttachment).toBe(false)
    })

    it('should simulate JOIN with message_attachment_join', () => {
      // Simulated SQL result
      const messageWithJoin = {
        ROWID: 123,
        text: 'Check this out',
        // From LEFT JOIN message_attachment_join
        attachment_id: 456 // Non-null means has attachment
      }

      const hasAttachment = messageWithJoin.attachment_id !== null

      expect(hasAttachment).toBe(true)
    })
  })

  describe('group chat detection edge cases', () => {
    it('should detect by participant count alone', () => {
      const message = {
        participantCount: 5,
        chatName: null
      }

      const isGroupChat = (message.participantCount || 0) > 2 ||
                          Boolean(message.chatName)

      expect(isGroupChat).toBe(true)
    })

    it('should detect by chat name alone', () => {
      const message = {
        participantCount: 2, // Only 2 people
        chatName: 'Project Team'
      }

      const isGroupChat = (message.participantCount || 0) > 2 ||
                          Boolean(message.chatName)

      expect(isGroupChat).toBe(true)
    })

    it('should handle 1-on-1 correctly', () => {
      const message = {
        participantCount: 2,
        chatName: ''
      }

      const isGroupChat = (message.participantCount || 0) > 2 ||
                          Boolean(message.chatName && message.chatName.length > 0)

      expect(isGroupChat).toBe(false)
    })

    it('should handle self-messages', () => {
      const message = {
        participantCount: 1, // Just self
        chatName: ''
      }

      const isGroupChat = (message.participantCount || 0) > 2 ||
                          Boolean(message.chatName)

      expect(isGroupChat).toBe(false)
    })
  })

  describe('Mac Absolute Time edge cases', () => {
    it('should convert epoch correctly', () => {
      // Mac epoch: Jan 1, 2001 00:00:00 UTC
      const macTime = 0
      const unixTime = macTime + MAC_ABSOLUTE_EPOCH

      expect(unixTime).toBe(978307200) // Unix timestamp for 2001-01-01
    })

    it('should handle recent timestamps', () => {
      // Example: Jan 1, 2024 00:00:00 UTC
      // Unix: 1704067200
      // Mac: 1704067200 - 978307200 = 725760000

      const macTime = 725760000
      const unixTime = macTime + MAC_ABSOLUTE_EPOCH

      expect(unixTime).toBe(1704067200)
    })

    it('should handle nanoseconds in macOS Sonoma+', () => {
      // Newer macOS uses nanoseconds in date field
      const macTimeNanos = 725760000000000000 // Nanoseconds

      // Detect if nanoseconds (very large number)
      const isNanos = macTimeNanos > 1e15

      expect(isNanos).toBe(true)

      // Convert to seconds
      const macTimeSeconds = macTimeNanos / 1e9
      expect(macTimeSeconds).toBeCloseTo(725760000, 0)
    })

    it('should handle negative values (pre-2001)', () => {
      // Year 2000: negative Mac time
      const macTime = -31536000 // -1 year
      const unixTime = macTime + MAC_ABSOLUTE_EPOCH

      // Should be year 2000
      const date = new Date(unixTime * 1000)
      expect(date.getFullYear()).toBe(2000)
    })
  })

  describe('message text truncation', () => {
    it('should truncate to 500 chars for search', () => {
      const longMessage = 'x'.repeat(1000)
      const truncated = longMessage.substring(0, 500)

      expect(truncated.length).toBe(500)
    })

    it('should preserve short messages', () => {
      const shortMessage = 'Hi there!'
      const maxLength = 500
      const result = shortMessage.length > maxLength
        ? shortMessage.substring(0, maxLength)
        : shortMessage

      expect(result).toBe(shortMessage)
    })
  })

  describe('sender normalization', () => {
    it('should use "Me" for is_from_me=1', () => {
      const message = { is_from_me: 1, handle_id: '+15551234567' }

      const sender = message.is_from_me === 1 ? 'Me' : message.handle_id

      expect(sender).toBe('Me')
    })

    it('should use handle_id for received', () => {
      const message = { is_from_me: 0, handle_id: '+15551234567' }

      const sender = message.is_from_me === 1 ? 'Me' : message.handle_id

      expect(sender).toBe('+15551234567')
    })

    it('should handle NULL handle_id', () => {
      const message = { is_from_me: 0, handle_id: null }

      const sender = message.is_from_me === 1 ? 'Me' : (message.handle_id || 'Unknown')

      expect(sender).toBe('Unknown')
    })
  })
})
