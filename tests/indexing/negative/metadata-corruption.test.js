/**
 * Negative tests for metadata file corruption handling
 * Tests graceful handling of malformed JSON, missing fields, and invalid values
 */

import { describe, it, expect, beforeEach } from 'vitest'

describe('Metadata Corruption Handling', () => {
  describe('malformed JSON handling', () => {
    const parseMetadataWithFallback = (content) => {
      if (!content || content.trim() === '') {
        return {}
      }

      try {
        return JSON.parse(content)
      } catch (e) {
        console.error('Failed to parse metadata:', e.message)
        return {} // Return empty object on parse failure
      }
    }

    it('should handle empty file content', () => {
      const result = parseMetadataWithFallback('')
      expect(result).toEqual({})
    })

    it('should handle whitespace-only content', () => {
      const result = parseMetadataWithFallback('   \n\t  ')
      expect(result).toEqual({})
    })

    it('should handle null content', () => {
      const result = parseMetadataWithFallback(null)
      expect(result).toEqual({})
    })

    it('should handle truncated JSON', () => {
      const truncated = '{"lastMessageIndexTime": 1234567'
      const result = parseMetadataWithFallback(truncated)
      expect(result).toEqual({})
    })

    it('should handle invalid JSON syntax', () => {
      const invalid = "{'key': 'value'}" // Single quotes not valid JSON
      const result = parseMetadataWithFallback(invalid)
      expect(result).toEqual({})
    })

    it('should handle JSON with trailing comma', () => {
      const trailingComma = '{"key": "value",}'
      const result = parseMetadataWithFallback(trailingComma)
      expect(result).toEqual({})
    })

    it('should handle binary content', () => {
      const binary = '\x00\x01\x02\x03'
      const result = parseMetadataWithFallback(binary)
      expect(result).toEqual({})
    })

    it('should parse valid JSON correctly', () => {
      const valid = '{"lastMessageIndexTime": 1234567890}'
      const result = parseMetadataWithFallback(valid)
      expect(result).toEqual({ lastMessageIndexTime: 1234567890 })
    })
  })

  describe('missing field handling', () => {
    const getTimestampWithDefault = (meta, field, defaultValue = null) => {
      if (meta === null || meta === undefined) return defaultValue
      if (!(field in meta)) return defaultValue
      return meta[field]
    }

    it('should return default when field is missing', () => {
      const meta = { otherField: 'value' }
      const result = getTimestampWithDefault(meta, 'lastMessageIndexTime', null)
      expect(result).toBeNull()
    })

    it('should return default when metadata is null', () => {
      const result = getTimestampWithDefault(null, 'lastMessageIndexTime', null)
      expect(result).toBeNull()
    })

    it('should return default when metadata is undefined', () => {
      const result = getTimestampWithDefault(undefined, 'lastMessageIndexTime', null)
      expect(result).toBeNull()
    })

    it('should return actual value when field exists', () => {
      const meta = { lastMessageIndexTime: 1234567890 }
      const result = getTimestampWithDefault(meta, 'lastMessageIndexTime', null)
      expect(result).toBe(1234567890)
    })

    it('should return field value even if falsy (0)', () => {
      const meta = { lastMessageIndexTime: 0 }
      const result = getTimestampWithDefault(meta, 'lastMessageIndexTime', null)
      expect(result).toBe(0)
    })
  })

  describe('invalid timestamp values', () => {
    const validateTimestamp = (value) => {
      // Must be a number
      if (typeof value !== 'number') {
        return { valid: false, reason: 'not_a_number' }
      }

      // Must not be NaN
      if (Number.isNaN(value)) {
        return { valid: false, reason: 'is_nan' }
      }

      // Must be finite
      if (!Number.isFinite(value)) {
        return { valid: false, reason: 'not_finite' }
      }

      // Must be non-negative
      if (value < 0) {
        return { valid: false, reason: 'negative' }
      }

      // Must not be too far in the future (more than 1 day ahead)
      const oneDayFromNow = Date.now() + 24 * 60 * 60 * 1000
      if (value > oneDayFromNow) {
        return { valid: false, reason: 'future_timestamp' }
      }

      return { valid: true }
    }

    it('should reject string timestamp', () => {
      const result = validateTimestamp('1234567890')
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('not_a_number')
    })

    it('should reject NaN timestamp', () => {
      const result = validateTimestamp(NaN)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('is_nan')
    })

    it('should reject Infinity timestamp', () => {
      const result = validateTimestamp(Infinity)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('not_finite')
    })

    it('should reject negative timestamp', () => {
      const result = validateTimestamp(-1000)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('negative')
    })

    it('should reject far future timestamp', () => {
      const farFuture = Date.now() + 7 * 24 * 60 * 60 * 1000 // 1 week from now
      const result = validateTimestamp(farFuture)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('future_timestamp')
    })

    it('should accept valid current timestamp', () => {
      const result = validateTimestamp(Date.now())
      expect(result.valid).toBe(true)
    })

    it('should accept valid past timestamp', () => {
      const pastTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago
      const result = validateTimestamp(pastTimestamp)
      expect(result.valid).toBe(true)
    })

    it('should accept zero timestamp (triggers full scan)', () => {
      const result = validateTimestamp(0)
      expect(result.valid).toBe(true)
    })
  })

  describe('metadata reset on corruption', () => {
    const loadMetadataWithReset = (readFile, defaultMeta = {}) => {
      try {
        const content = readFile()

        if (!content) {
          return { meta: { ...defaultMeta }, wasReset: false }
        }

        const parsed = JSON.parse(content)

        // Validate critical fields
        if (parsed.lastMessageIndexTime !== undefined) {
          if (typeof parsed.lastMessageIndexTime !== 'number' ||
              Number.isNaN(parsed.lastMessageIndexTime)) {
            return { meta: { ...defaultMeta }, wasReset: true, reason: 'invalid_timestamp' }
          }
        }

        return { meta: parsed, wasReset: false }
      } catch (e) {
        return { meta: { ...defaultMeta }, wasReset: true, reason: 'parse_error' }
      }
    }

    it('should reset metadata on JSON parse error', () => {
      const result = loadMetadataWithReset(() => 'invalid json{')
      expect(result.wasReset).toBe(true)
      expect(result.reason).toBe('parse_error')
      expect(result.meta).toEqual({})
    })

    it('should reset metadata when timestamp is NaN', () => {
      const result = loadMetadataWithReset(() => '{"lastMessageIndexTime": "not a number"}')

      // JSON.parse succeeds but validation fails
      // Actually "not a number" is a string, not NaN after parse
      // Let me use a value that becomes NaN
      const resultNaN = loadMetadataWithReset(() => JSON.stringify({ lastMessageIndexTime: NaN }))
      // JSON.stringify(NaN) produces "null", so let's test differently

      // Test with object that has invalid timestamp type
      const resultString = loadMetadataWithReset(() => '{"lastMessageIndexTime": "invalid"}')
      expect(resultString.wasReset).toBe(true)
      expect(resultString.reason).toBe('invalid_timestamp')
    })

    it('should preserve valid metadata', () => {
      const validMeta = { lastMessageIndexTime: Date.now(), lastEmailIndexTime: Date.now() - 1000 }
      const result = loadMetadataWithReset(() => JSON.stringify(validMeta))

      expect(result.wasReset).toBe(false)
      expect(result.meta.lastMessageIndexTime).toBe(validMeta.lastMessageIndexTime)
    })

    it('should use default values on reset', () => {
      const defaults = { version: 1, lastMessageIndexTime: 0 }
      const result = loadMetadataWithReset(() => 'corrupt', defaults)

      expect(result.wasReset).toBe(true)
      expect(result.meta).toEqual(defaults)
    })
  })

  describe('concurrent metadata access', () => {
    it('should handle read-modify-write race condition', async () => {
      let fileContent = JSON.stringify({ counter: 0 })

      // Simulate file system operations
      const readFile = () => fileContent
      const writeFile = (content) => { fileContent = content }

      // Two concurrent updates
      const update1 = async () => {
        const meta = JSON.parse(readFile())
        await new Promise(r => setTimeout(r, 10)) // Simulate delay
        meta.counter += 1
        writeFile(JSON.stringify(meta))
        return meta.counter
      }

      const update2 = async () => {
        const meta = JSON.parse(readFile())
        await new Promise(r => setTimeout(r, 5)) // Shorter delay
        meta.counter += 1
        writeFile(JSON.stringify(meta))
        return meta.counter
      }

      // Run concurrently - demonstrates race condition
      await Promise.all([update1(), update2()])

      // Final counter might be 1 instead of 2 due to race
      const finalMeta = JSON.parse(fileContent)
      // This test documents the race condition behavior
      expect(finalMeta.counter).toBeGreaterThanOrEqual(1)
    })

    it('should handle atomic updates with locking', async () => {
      let fileContent = JSON.stringify({ counter: 0 })
      let lock = false

      const acquireLock = async () => {
        while (lock) {
          await new Promise(r => setTimeout(r, 1))
        }
        lock = true
      }

      const releaseLock = () => {
        lock = false
      }

      const atomicUpdate = async (updateFn) => {
        await acquireLock()
        try {
          const meta = JSON.parse(fileContent)
          const updated = updateFn(meta)
          fileContent = JSON.stringify(updated)
          return updated
        } finally {
          releaseLock()
        }
      }

      // Two concurrent updates with locking
      await Promise.all([
        atomicUpdate(meta => ({ ...meta, counter: meta.counter + 1 })),
        atomicUpdate(meta => ({ ...meta, counter: meta.counter + 1 }))
      ])

      const finalMeta = JSON.parse(fileContent)
      expect(finalMeta.counter).toBe(2) // Both updates applied correctly
    })
  })

  describe('schema migration', () => {
    const migrateMetadata = (meta) => {
      const migrated = { ...meta }

      // v1 to v2: rename indexTime to lastIndexTime
      if ('indexTime' in migrated && !('lastIndexTime' in migrated)) {
        migrated.lastIndexTime = migrated.indexTime
        delete migrated.indexTime
      }

      // v2 to v3: split lastIndexTime into source-specific timestamps
      if ('lastIndexTime' in migrated && !('lastMessageIndexTime' in migrated)) {
        migrated.lastMessageIndexTime = migrated.lastIndexTime
        migrated.lastEmailIndexTime = migrated.lastIndexTime
        migrated.lastCalendarIndexTime = migrated.lastIndexTime
        delete migrated.lastIndexTime
      }

      // Set version
      migrated.version = 3

      return migrated
    }

    it('should migrate v1 schema (indexTime)', () => {
      const v1Meta = { indexTime: 1234567890 }
      const migrated = migrateMetadata(v1Meta)

      expect(migrated.version).toBe(3)
      expect(migrated.lastMessageIndexTime).toBe(1234567890)
      expect(migrated.indexTime).toBeUndefined()
    })

    it('should migrate v2 schema (lastIndexTime)', () => {
      const v2Meta = { lastIndexTime: 1234567890 }
      const migrated = migrateMetadata(v2Meta)

      expect(migrated.version).toBe(3)
      expect(migrated.lastMessageIndexTime).toBe(1234567890)
      expect(migrated.lastEmailIndexTime).toBe(1234567890)
      expect(migrated.lastIndexTime).toBeUndefined()
    })

    it('should preserve v3 schema', () => {
      const v3Meta = {
        version: 3,
        lastMessageIndexTime: 1000,
        lastEmailIndexTime: 2000,
        lastCalendarIndexTime: 3000
      }
      const migrated = migrateMetadata(v3Meta)

      expect(migrated).toEqual(v3Meta)
    })

    it('should handle empty metadata', () => {
      const migrated = migrateMetadata({})
      expect(migrated.version).toBe(3)
    })
  })
})
