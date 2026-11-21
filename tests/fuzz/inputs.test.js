
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'

describe('Fuzz: Query Validation', () => {
  it('should handle any string input without crashing', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          const result = validateSearchQuery(input)
          return typeof result === 'string' || result === undefined
        } catch (e) {
          return e instanceof Error
        }
      }),
      { numRuns: 500 }
    )
  })

  it('should handle unicode strings', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.unicodeString(), (input) => {
        try {
          const result = validateSearchQuery(input)
          return typeof result === 'string' || result === undefined
        } catch (e) {
          return e instanceof Error
        }
      }),
      { numRuns: 200 }
    )
  })

  it('should handle emoji strings', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const emojiStrings = [
      '🔍 search query',
      'meeting 📅 with 👤 John',
      '💰💰💰 budget',
      '🎉🎊🎁',
      'test 😀😃😄😁 query',
      '🏠🏡🏢 home',
      '📧 email about 💼 work'
    ]

    for (const input of emojiStrings) {
      const result = validateSearchQuery(input)
      expect(typeof result).toBe('string')
    }
  })

  it('should handle very long strings by truncating', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.string({ minLength: 1000, maxLength: 5000 }), (input) => {
        const result = validateSearchQuery(input)
        return result.length <= 1000
      }),
      { numRuns: 50 }
    )
  })

  it('should handle strings with null bytes', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    const inputs = [
      'test\x00query',
      '\x00\x00\x00',
      'before\x00after',
      'null\x00in\x00middle'
    ]

    for (const input of inputs) {
      try {
        const result = validateSearchQuery(input)
        expect(typeof result).toBe('string')
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
      }
    }
  })
})

describe('Fuzz: Numeric Parameter Validation', () => {
  it('should handle any number for limit', async () => {
    const { validateLimit } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.integer(), (input) => {
        const result = validateLimit(input)
        return typeof result === 'number' && result >= 1 && result <= 1000
      }),
      { numRuns: 500 }
    )
  })

  it('should handle floating point numbers', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.double(), (input) => {
        const limitResult = validateLimit(input)
        const daysResult = validateDaysBack(input)
        return typeof limitResult === 'number' && typeof daysResult === 'number'
      }),
      { numRuns: 200 }
    )
  })

  it('should handle edge case numbers', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    const edgeCases = [
      0, -0, -1, -Infinity, Infinity, NaN,
      Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
      Number.MAX_VALUE, Number.MIN_VALUE,
      1e10, 1e-10
    ]

    for (const input of edgeCases) {
      const limitResult = validateLimit(input)
      const daysResult = validateDaysBack(input)

      expect(typeof limitResult).toBe('number')
      expect(typeof daysResult).toBe('number')
      expect(limitResult).toBeGreaterThanOrEqual(1)
      expect(daysResult).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('Fuzz: Path Validation', () => {
  it('should reject all path traversal attempts', async () => {
    const { validateEmailPath } = await import('../../lib/validators.js')
    const mailDir = '/Users/test/Library/Mail'

    const traversalAttempts = [
      '../../../etc/passwd',
      '..\\..\\..\\etc\\passwd',
      '....//....//etc/passwd',
      '%2e%2e%2f%2e%2e%2fetc/passwd',
      '..%252f..%252f..%252fetc/passwd',
      '/etc/passwd',
      'file:///etc/passwd',
      '\\\\server\\share',
      '/Users/test/Library/Mail/../../../etc/passwd',
      '/Users/test/Library/Mail/./../../etc/passwd'
    ]

    for (const attempt of traversalAttempts) {
      expect(() => {
        validateEmailPath(attempt, mailDir)
      }).toThrow()
    }
  })

  it('should handle random path-like strings', async () => {
    const { validateEmailPath } = await import('../../lib/validators.js')
    const mailDir = '/Users/test/Library/Mail'

    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          validateEmailPath(input, mailDir)
          return true
        } catch (e) {
          return e instanceof Error
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('Fuzz: SQL Escaping', () => {
  it('should safely escape any string', async () => {
    const { escapeSQL } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = escapeSQL(input)
        const singleQuotes = (input.match(/'/g) || []).length
        const escapedQuotes = (result.match(/''/g) || []).length
        return escapedQuotes >= singleQuotes
      }),
      { numRuns: 500 }
    )
  })

  it('should handle SQL injection attempts', async () => {
    const { escapeSQL } = await import('../../lib/validators.js')

    const injections = [
      "'; DROP TABLE users; --",
      "' OR '1'='1",
      "1'; DELETE FROM emails WHERE '1'='1",
      "' UNION SELECT * FROM passwords --",
      "'; EXEC xp_cmdshell('dir'); --",
      "1' AND 1=1 --",
      "admin'--",
      "' OR 1=1#",
      "') OR ('1'='1"
    ]

    for (const injection of injections) {
      const result = escapeSQL(injection)
      expect(result).not.toMatch(/^'.*[^']'[^']/)
    }
  })
})

describe('Fuzz: HTML Stripping', () => {
  it('should safely strip any HTML-like content', async () => {
    const { stripHtmlTags } = await import('../../lib/validators.js')

    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = stripHtmlTags(input)
        return !/<[a-zA-Z]/.test(result)
      }),
      { numRuns: 500 }
    )
  })

  it('should handle malformed HTML', async () => {
    const { stripHtmlTags } = await import('../../lib/validators.js')

    const malformedHtml = [
      '<div><span>unclosed',
      '<<<nested<<<tags>>>',
      '<script>alert("xss")</script',
      '<img src="x" onerror="alert(1)">',
      '<style>body{display:none}</style>',
      '<!--comment-->text',
      '<![CDATA[data]]>',
      '<?xml version="1.0"?>',
      '<div style="background:url(javascript:alert(1))">',
      '<a href="javascript:void(0)">link</a>'
    ]

    for (const html of malformedHtml) {
      const result = stripHtmlTags(html)
      expect(typeof result).toBe('string')
      expect(result.toLowerCase()).not.toContain('<script')
    }
  })

  it('should not hang on pathological inputs (ReDoS protection)', async () => {
    const { stripHtmlTags } = await import('../../lib/validators.js')

    const pathological = [
      '<' + 'a'.repeat(10000) + '>',
      '<div ' + 'x='.repeat(1000) + '>',
      '>' + '<'.repeat(5000) + '>',
      '<' + '!'.repeat(10000)
    ]

    for (const input of pathological) {
      const start = performance.now()
      stripHtmlTags(input)
      const duration = performance.now() - start

      expect(duration).toBeLessThan(100)
    }
  })
})

describe('Fuzz: Date Parsing', () => {
  it('should handle random date-like strings', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    const dateStrings = [
      '2024-13-45',
      '99/99/9999',
      'yesterday',
      'not a date',
      '2024-01-15T10:30:00Z',
      '15/01/2024',
      'January 50, 2024',
      'Feb 30, 2024',
      '2024-02-29',
      '2023-02-29'
    ]

    for (const input of dateStrings) {
      try {
        const result = parseNaturalDate(input)
        expect(result === null || typeof result === 'number').toBe(true)
      } catch (e) {
        expect(e).toBeInstanceOf(Error)
      }
    }
  })

  it('should handle any string without crashing', async () => {
    const { parseNaturalDate } = await import('../../search.js')

    fc.assert(
      fc.property(fc.string(), (input) => {
        try {
          const result = parseNaturalDate(input)
          return result === null || typeof result === 'number'
        } catch (e) {
          return e instanceof Error
        }
      }),
      { numRuns: 200 }
    )
  })
})
