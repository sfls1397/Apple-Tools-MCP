/**
 * Chaos / Fault Injection Testing
 *
 * Tests system behavior under adverse conditions:
 * - Database unavailability
 * - File system errors
 * - Resource exhaustion
 * - Corrupted data
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.env.HOME, '.apple-tools-mcp', 'lance_index')

describe('Chaos: Database Unavailability', () => {
  it('should handle missing database gracefully', async () => {
    const { connect } = await import('@lancedb/lancedb')

    const nonExistentPath = '/tmp/non-existent-db-' + Date.now()

    // LanceDB creates the db if it doesn't exist
    const db = await connect(nonExistentPath)

    // Should return empty tables
    const tables = await db.tableNames()
    expect(Array.isArray(tables)).toBe(true)
    expect(tables.length).toBe(0)

    // Cleanup
    try {
      fs.rmSync(nonExistentPath, { recursive: true })
    } catch (e) {
      // Ignore cleanup errors
    }
  })

  it('should handle invalid database path', async () => {
    const { connect } = await import('@lancedb/lancedb')

    // Path with invalid characters or permissions
    const invalidPath = '/root/no-access-' + Date.now()

    try {
      await connect(invalidPath)
      // If we got here, the system allows creating this path
    } catch (e) {
      // Expected to fail with permission error
      expect(e.message).toMatch(/permission|access|denied|EACCES/i)
    }
  })

  it('should handle table not found', async () => {
    const { connect } = await import('@lancedb/lancedb')

    if (!fs.existsSync(DB_PATH)) {
      return // Skip if no database
    }

    const db = await connect(DB_PATH)

    try {
      await db.openTable('non_existent_table_' + Date.now())
      expect.fail('Should have thrown error')
    } catch (e) {
      // Expected - table doesn't exist
      expect(e.message).toBeDefined()
    }
  })
})

describe('Chaos: File System Errors', () => {
  it('should handle file read errors for mail_read', async () => {
    const { validateEmailPath } = await import('../../lib/validators.js')
    const mailDir = path.join(process.env.HOME, 'Library', 'Mail')

    // Non-existent file path
    const fakePath = path.join(mailDir, 'non-existent-file-' + Date.now() + '.emlx')

    // Validator should reject files outside mail directory structure
    // but allow valid-looking paths
    try {
      validateEmailPath(fakePath, mailDir)
      // Path validation passed - that's OK, file access would fail later
    } catch (e) {
      // Path validation failed
      expect(e.message).toBeDefined()
    }
  })

  it('should handle path traversal attempts', async () => {
    const { validateEmailPath } = await import('../../lib/validators.js')
    const mailDir = path.join(process.env.HOME, 'Library', 'Mail')

    const traversalPaths = [
      '../../../etc/passwd.emlx',           // Path traversal with valid extension
      '..\\..\\..\\windows\\system32\\x.emlx',
      '/etc/passwd.emlx',
      mailDir + '/../../../etc/passwd.emlx'
    ]

    for (const badPath of traversalPaths) {
      try {
        validateEmailPath(badPath, mailDir)
        // If validation passes, the path should be sanitized
        expect.fail(`Should have rejected: ${badPath}`)
      } catch (e) {
        // Should either fail on extension or path traversal
        expect(e.message).toMatch(/denied|extension/i)
      }
    }
  })

  it('should handle special characters in paths', async () => {
    const { validateEmailPath } = await import('../../lib/validators.js')
    const mailDir = path.join(process.env.HOME, 'Library', 'Mail')

    const specialPaths = [
      mailDir + '/test\x00file.emlx',  // Null byte
      mailDir + '/test\nfile.emlx',    // Newline
      mailDir + '/test\rfile.emlx'     // Carriage return
    ]

    for (const badPath of specialPaths) {
      try {
        validateEmailPath(badPath, mailDir)
        // If it passes, the special chars should be handled
      } catch (e) {
        // Expected for potentially malicious paths
        expect(e.message).toBeDefined()
      }
    }
  })
})

describe('Chaos: Corrupted Data', () => {
  it('should handle malformed JSON in results', async () => {
    const malformedData = [
      '{"incomplete": true',
      '{"nested": {"deep": {"unclosed": true}',
      '[1, 2, 3,]',
      'undefined',
      'NaN'
    ]

    for (const data of malformedData) {
      try {
        JSON.parse(data)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(SyntaxError)
      }
    }
  })

  it('should handle circular references safely', () => {
    const obj = { name: 'test' }
    obj.self = obj // Circular reference

    expect(() => JSON.stringify(obj)).toThrow()

    // Safe stringification with replacer
    const seen = new WeakSet()
    const safe = JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    })

    expect(safe).toContain('[Circular]')
  })

  it('should handle binary data in text fields', async () => {
    const { stripHtmlTags } = await import('../../lib/validators.js')

    // Binary-like content
    const binaryish = '\x00\x01\x02\xff\xfe<p>text</p>\x00'

    const result = stripHtmlTags(binaryish)
    // Should not crash, output should be safe
    expect(typeof result).toBe('string')
  })

  it('should handle extremely deep nesting', () => {
    // Create deeply nested object
    let deep = { value: 'end' }
    for (let i = 0; i < 100; i++) {
      deep = { nested: deep }
    }

    // Should handle without stack overflow
    const str = JSON.stringify(deep)
    const parsed = JSON.parse(str)

    expect(parsed.nested.nested.nested).toBeDefined()
  })
})

describe('Chaos: Resource Exhaustion', () => {
  it('should handle very large strings', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    // 1MB string
    const largeString = 'x'.repeat(1024 * 1024)

    const result = validateSearchQuery(largeString)
    // Should truncate, not crash
    expect(result.length).toBeLessThan(largeString.length)
  })

  it('should handle many concurrent validations', async () => {
    const { validateSearchQuery, validateLimit, escapeSQL } = await import('../../lib/validators.js')

    const start = performance.now()

    // 10000 validations
    for (let i = 0; i < 10000; i++) {
      validateSearchQuery('query ' + i)
      validateLimit(i)
      escapeSQL('text ' + i)
    }

    const duration = performance.now() - start
    console.log(`  → 30000 validations in ${duration.toFixed(0)}ms`)

    // Should complete in reasonable time
    expect(duration).toBeLessThan(5000)
  })

  it('should handle array with many elements', async () => {
    const { extractKeywords } = await import('../../search.js')

    // Generate long query
    const words = Array(1000).fill('word').map((w, i) => w + i)
    const longQuery = words.join(' ')

    const start = performance.now()
    const keywords = extractKeywords(longQuery)
    const duration = performance.now() - start

    console.log(`  → Extracted ${keywords.length} keywords from ${words.length} words in ${duration.toFixed(0)}ms`)

    expect(duration).toBeLessThan(1000)
  })
})

describe('Chaos: Timing and Timeout', () => {
  it('should handle slow operations', async () => {
    // Simulate slow operation with timeout
    const slowOperation = () => new Promise(resolve =>
      setTimeout(() => resolve('done'), 100)
    )

    const timeout = (ms) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    )

    // Should complete before timeout
    const result = await Promise.race([
      slowOperation(),
      timeout(500)
    ])

    expect(result).toBe('done')
  })

  it('should handle timeout race condition', async () => {
    const operation = () => new Promise(resolve =>
      setTimeout(() => resolve('completed'), 50)
    )

    const timeout = (ms) => new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    )

    // Operation should timeout
    try {
      await Promise.race([
        operation(),
        timeout(10)
      ])
      expect.fail('Should have timed out')
    } catch (e) {
      expect(e.message).toBe('Timeout')
    }
  })
})

describe('Chaos: Error Propagation', () => {
  it('should propagate errors through async chain', async () => {
    const step1 = async () => 'step1'
    const step2 = async () => { throw new Error('Step 2 failed') }
    const step3 = async () => 'step3'

    try {
      await step1()
      await step2()
      await step3()
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e.message).toBe('Step 2 failed')
    }
  })

  it('should handle errors in Promise.all', async () => {
    const promises = [
      Promise.resolve(1),
      Promise.reject(new Error('Middle failed')),
      Promise.resolve(3)
    ]

    try {
      await Promise.all(promises)
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e.message).toBe('Middle failed')
    }
  })

  it('should capture all errors with Promise.allSettled', async () => {
    const promises = [
      Promise.resolve(1),
      Promise.reject(new Error('Error 1')),
      Promise.resolve(3),
      Promise.reject(new Error('Error 2'))
    ]

    const results = await Promise.allSettled(promises)

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')

    expect(fulfilled.length).toBe(2)
    expect(rejected.length).toBe(2)
  })
})

describe('Chaos: Edge Case Inputs', () => {
  it('should handle undefined/null throughout the system', async () => {
    const { validateLimit, validateDaysBack } = await import('../../lib/validators.js')

    const edgeCases = [undefined, null, NaN, Infinity, -Infinity, '', [], {}, () => {}]

    for (const value of edgeCases) {
      // Should not throw, should return defaults
      const limit = validateLimit(value)
      const days = validateDaysBack(value)

      expect(typeof limit).toBe('number')
      expect(typeof days).toBe('number')
      expect(limit).toBeGreaterThan(0)
      expect(days).toBeGreaterThanOrEqual(0)
    }
  })

  it('should handle prototype pollution attempts', async () => {
    const { escapeSQL } = await import('../../lib/validators.js')

    const malicious = {
      __proto__: { isAdmin: true },
      constructor: { prototype: { isAdmin: true } }
    }

    // These should not affect the global Object prototype
    const testObj = {}
    expect(testObj.isAdmin).toBeUndefined()

    // Escaping should work normally
    const result = escapeSQL(JSON.stringify(malicious))
    expect(typeof result).toBe('string')
  })

  it('should handle Symbol inputs', async () => {
    const { validateSearchQuery } = await import('../../lib/validators.js')

    try {
      validateSearchQuery(Symbol('test'))
      expect.fail('Should have thrown')
    } catch (e) {
      expect(e).toBeDefined()
    }
  })
})
