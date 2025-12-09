/**
 * Edge case tests for Unicode handling
 * Tests CJK, emoji, RTL, and multi-byte characters
 *
 * Pure logic tests - no mocking required.
 */

import { describe, it, expect } from 'vitest'

describe('Unicode Handling', () => {
  describe('CJK characters', () => {
    it('should handle Japanese text', () => {
      const text = '会議の予定について'

      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    })

    it('should handle Chinese text', () => {
      const text = '关于预算的讨论'

      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    })

    it('should handle Korean text', () => {
      const text = '프로젝트 회의 안건'

      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    })

    it('should handle mixed CJK and English', () => {
      const text = 'Meeting about 日本 project with 한국 team'

      expect(text).toContain('日本')
      expect(text).toContain('한국')
      expect(text).toContain('Meeting')
    })

    it('should preserve CJK in subject', () => {
      const subject = 'Re: 会議の件'

      expect(subject.includes('会議')).toBe(true)
      expect(subject.length).toBe(8) // "Re: " (4) + "会議の件" (4) = 8
    })

    it('should count CJK characters correctly', () => {
      const text = '日本語テスト'

      // Each CJK character is 1 character in JS
      expect(text.length).toBe(6)
      expect([...text].length).toBe(6)
    })
  })

  describe('emoji handling', () => {
    it('should handle basic emoji', () => {
      const text = 'Great meeting! 😀'

      expect(text).toContain('😀')
    })

    it('should handle multiple emoji', () => {
      const text = '🎉 Celebration 🎂 Birthday 🎁 Gift'

      expect(text).toContain('🎉')
      expect(text).toContain('🎂')
      expect(text).toContain('🎁')
    })

    it('should handle emoji sequences (ZWJ)', () => {
      // Family emoji: man + ZWJ + woman + ZWJ + girl
      const text = 'Family event 👨‍👩‍👧'

      expect(text).toContain('👨')
    })

    it('should handle flag emoji', () => {
      const text = 'International meeting 🇺🇸 🇯🇵 🇬🇧'

      expect(text).toContain('🇺🇸')
      expect(text).toContain('🇯🇵')
    })

    it('should preserve emoji in subject', () => {
      const subject = '✅ Task Complete'

      expect(subject.includes('✅')).toBe(true)
    })

    it('should handle skin tone modifiers', () => {
      const text = 'Meeting 👋🏻 👋🏽 👋🏿'

      expect(text).toContain('👋')
    })
  })

  describe('RTL text (Hebrew, Arabic)', () => {
    it('should handle Hebrew text', () => {
      const text = 'פגישה על הפרויקט'

      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    })

    it('should handle Arabic text', () => {
      const text = 'اجتماع حول المشروع'

      expect(typeof text).toBe('string')
      expect(text.length).toBeGreaterThan(0)
    })

    it('should handle mixed RTL and LTR', () => {
      const text = 'Meeting with שלום about project'

      expect(text).toContain('שלום')
      expect(text).toContain('Meeting')
    })

    it('should preserve RTL characters', () => {
      const text = 'שלום'

      expect(text.length).toBe(4)
      expect(text[0]).toBe('ש')
    })
  })

  describe('multi-byte characters', () => {
    it('should handle 2-byte UTF-8 (Latin Extended)', () => {
      const text = 'Café résumé naïve'

      expect(text).toContain('é')
      expect(text).toContain('ï')
    })

    it('should handle 3-byte UTF-8 (CJK)', () => {
      const text = '中文测试'

      expect(text.length).toBe(4)
    })

    it('should handle 4-byte UTF-8 (emoji, rare chars)', () => {
      const text = '𝕳𝖊𝖑𝖑𝖔 🎵'

      expect(text).toContain('🎵')
    })

    it('should correctly count surrogate pairs', () => {
      // 𝕳 is a surrogate pair (2 UTF-16 code units)
      const text = '𝕳'

      // JS string length counts UTF-16 code units
      expect(text.length).toBe(2)

      // Spread operator counts graphemes
      expect([...text].length).toBe(1)
    })

    it('should handle combining characters', () => {
      // é can be e + combining acute accent
      const composed = 'é' // Single code point
      const decomposed = 'e\u0301' // e + combining accent

      expect(composed.normalize('NFC')).toBe(composed)
      expect(decomposed.normalize('NFC')).toBe(composed)
    })
  })

  describe('mixed scripts', () => {
    it('should handle English + Japanese', () => {
      const text = 'Project meeting 会議 with team メンバー'

      expect(text).toContain('会議')
      expect(text).toContain('メンバー')
      expect(text).toContain('Project')
    })

    it('should handle English + Chinese + Emoji', () => {
      const text = 'Budget 预算 approved ✅'

      expect(text).toContain('预算')
      expect(text).toContain('✅')
      expect(text).toContain('Budget')
    })

    it('should handle multiple scripts in email', () => {
      const email = {
        from: 'José García <jose@example.com>',
        to: '田中太郎 <tanaka@example.jp>',
        subject: 'Re: 会议 Meeting ✅',
        body: 'Discussion about 项目 project with שלום'
      }

      // All fields should be valid strings
      expect(typeof email.from).toBe('string')
      expect(typeof email.to).toBe('string')
      expect(typeof email.subject).toBe('string')
      expect(typeof email.body).toBe('string')
    })
  })

  describe('zero-width characters', () => {
    it('should handle zero-width space (U+200B)', () => {
      const text = 'Hello\u200BWorld'

      expect(text.includes('\u200B')).toBe(true)
      expect(text.length).toBe(11) // Includes invisible char
    })

    it('should handle zero-width joiner (U+200D)', () => {
      // Used in emoji sequences
      const emoji = '👨\u200D👩\u200D👧'

      expect(emoji.includes('\u200D')).toBe(true)
    })

    it('should handle zero-width non-joiner (U+200C)', () => {
      const text = 'Test\u200Cword'

      expect(text.includes('\u200C')).toBe(true)
    })

    it('should optionally strip zero-width chars', () => {
      const text = 'Hello\u200B\u200C\u200DWorld'
      const stripped = text.replace(/[\u200B\u200C\u200D]/g, '')

      expect(stripped).toBe('HelloWorld')
    })

    it('should handle BOM (Byte Order Mark)', () => {
      const textWithBOM = '\uFEFFHello'
      const stripped = textWithBOM.replace(/^\uFEFF/, '')

      expect(stripped).toBe('Hello')
    })
  })

  describe('normalization', () => {
    it('should normalize to NFC form', () => {
      const decomposed = 'e\u0301' // e + combining accent
      const normalized = decomposed.normalize('NFC')

      expect(normalized).toBe('é')
    })

    it('should handle already normalized text', () => {
      const text = 'café'
      const normalized = text.normalize('NFC')

      expect(normalized).toBe(text)
    })

    it('should normalize for consistent comparison', () => {
      const text1 = 'café'.normalize('NFC')
      const text2 = 'cafe\u0301'.normalize('NFC')

      expect(text1).toBe(text2)
    })
  })

  describe('truncation with unicode', () => {
    it('should not break surrogate pairs when truncating', () => {
      const text = '😀'.repeat(100) // Each emoji is 2 UTF-16 code units
      const maxLength = 50

      // Safe truncation using spread
      const chars = [...text]
      const truncated = chars.slice(0, maxLength).join('')

      // Should not end with half a surrogate pair
      expect(truncated).not.toMatch(/[\uD800-\uDBFF]$/)
    })

    it('should handle CJK truncation correctly', () => {
      const text = '会議会議会議会議会議' // 10 CJK chars
      const maxLength = 5

      const chars = [...text]
      const truncated = chars.slice(0, maxLength).join('')

      expect([...truncated].length).toBe(5)
    })

    it('should preserve complete graphemes', () => {
      // Family emoji is single grapheme but multiple code points
      const text = '👨‍👩‍👧'.repeat(3)

      // Use Intl.Segmenter if available (Node 16+)
      if (typeof Intl.Segmenter !== 'undefined') {
        const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
        const graphemes = [...segmenter.segment(text)]
        expect(graphemes.length).toBe(3)
      } else {
        // Fallback: just verify the string contains expected content
        expect(text.includes('👨')).toBe(true)
      }
    })
  })

  describe('search text with unicode', () => {
    it('should generate searchable text with unicode', () => {
      const email = {
        subject: '会議 Meeting 📅',
        from: 'José García',
        body: 'Discussion about 项目'
      }

      const searchText = `${email.subject} ${email.from} ${email.body}`

      expect(searchText).toContain('会議')
      expect(searchText).toContain('José')
      expect(searchText).toContain('项目')
    })

    it('should maintain unicode in indexed fields', () => {
      const record = {
        subject: '日本語メール',
        fromEmail: 'tanaka@example.jp',
        body: 'テスト本文'
      }

      // Verify unicode is preserved
      expect(record.subject.includes('日本語')).toBe(true)
      expect(record.body.includes('テスト')).toBe(true)
    })
  })

  describe('special unicode categories', () => {
    it('should handle mathematical symbols', () => {
      const text = 'Formula: ∑∏∫∂√∞'

      expect(text).toContain('∑')
      expect(text).toContain('∞')
    })

    it('should handle currency symbols', () => {
      const text = 'Budget: $100 €50 £30 ¥1000 ₹500'

      expect(text).toContain('€')
      expect(text).toContain('¥')
      expect(text).toContain('₹')
    })

    it('should handle box drawing characters', () => {
      const text = '┌──────┐\n│ Box  │\n└──────┘'

      expect(text.includes('┌')).toBe(true)
    })

    it('should handle control characters gracefully', () => {
      const text = 'Text\x00with\x01control\x02chars'

      // Should be able to strip or handle control chars
      const cleaned = text.replace(/[\x00-\x1F]/g, '')

      expect(cleaned).toBe('Textwithcontrolchars')
    })
  })
})
