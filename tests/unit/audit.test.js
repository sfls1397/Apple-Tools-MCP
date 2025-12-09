/**
 * Unit tests for audit module (lib/audit.js)
 * Tests discrepancy detection, counting, and report formatting
 *
 * These tests validate pure functions with inline test data.
 * No mocking required - these are algorithm tests.
 */

import { describe, it, expect } from 'vitest'

import {
  findMissing,
  findOrphaned,
  findDuplicates,
  formatAuditReport
} from '../../lib/audit.js'

describe('Audit Module - Discrepancy Detection', () => {
  describe('findMissing', () => {
    it('should find items in source but not in index', () => {
      const sourceIds = new Set(['a', 'b', 'c', 'd'])
      const indexedIds = new Set(['a', 'c'])

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(2)
      expect(missing).toContain('b')
      expect(missing).toContain('d')
    })

    it('should return empty array when all items are indexed', () => {
      const sourceIds = new Set(['a', 'b', 'c'])
      const indexedIds = new Set(['a', 'b', 'c', 'd'])

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(0)
    })

    it('should handle empty source set', () => {
      const sourceIds = new Set()
      const indexedIds = new Set(['a', 'b'])

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(0)
    })

    it('should handle empty index set', () => {
      const sourceIds = new Set(['a', 'b', 'c'])
      const indexedIds = new Set()

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(3)
      expect(missing).toEqual(['a', 'b', 'c'])
    })

    it('should preserve order from source iteration', () => {
      const sourceIds = new Set(['z', 'a', 'm'])
      const indexedIds = new Set(['a'])

      const missing = findMissing(sourceIds, indexedIds)

      // Set iteration order is insertion order
      expect(missing).toEqual(['z', 'm'])
    })
  })

  describe('findOrphaned', () => {
    it('should find items in index but not in source', async () => {
      const indexedIds = new Set(['a', 'b', 'c'])
      const sourceValidator = (id) => id === 'a' || id === 'c'

      const orphaned = await findOrphaned(indexedIds, sourceValidator)

      expect(orphaned).toHaveLength(1)
      expect(orphaned).toContain('b')
    })

    it('should return empty array when all items exist in source', async () => {
      const indexedIds = new Set(['a', 'b'])
      const sourceValidator = () => true

      const orphaned = await findOrphaned(indexedIds, sourceValidator)

      expect(orphaned).toHaveLength(0)
    })

    it('should handle async validators', async () => {
      const indexedIds = new Set(['file1', 'file2', 'file3'])
      const sourceValidator = async (id) => {
        await new Promise(resolve => setTimeout(resolve, 1))
        return id !== 'file2' // file2 doesn't exist
      }

      const orphaned = await findOrphaned(indexedIds, sourceValidator)

      expect(orphaned).toHaveLength(1)
      expect(orphaned).toContain('file2')
    })

    it('should handle empty index set', async () => {
      const indexedIds = new Set()
      const sourceValidator = () => true

      const orphaned = await findOrphaned(indexedIds, sourceValidator)

      expect(orphaned).toHaveLength(0)
    })
  })

  describe('findDuplicates', () => {
    it('should find items indexed multiple times', () => {
      const indexedItems = [
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second' },
        { id: 'a', text: 'duplicate' },
        { id: 'c', text: 'third' },
        { id: 'a', text: 'another duplicate' }
      ]

      const duplicates = findDuplicates(indexedItems, 'id')

      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]).toEqual({ id: 'a', count: 3 })
    })

    it('should detect multiple different duplicates', () => {
      const indexedItems = [
        { id: 'a', text: '1' },
        { id: 'b', text: '2' },
        { id: 'a', text: '3' },
        { id: 'c', text: '4' },
        { id: 'b', text: '5' },
        { id: 'd', text: '6' }
      ]

      const duplicates = findDuplicates(indexedItems, 'id')

      expect(duplicates).toHaveLength(2)
      expect(duplicates).toContainEqual({ id: 'a', count: 2 })
      expect(duplicates).toContainEqual({ id: 'b', count: 2 })
    })

    it('should return empty array when no duplicates exist', () => {
      const indexedItems = [
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second' },
        { id: 'c', text: 'third' }
      ]

      const duplicates = findDuplicates(indexedItems, 'id')

      expect(duplicates).toHaveLength(0)
    })

    it('should handle empty items array', () => {
      const indexedItems = []

      const duplicates = findDuplicates(indexedItems, 'id')

      expect(duplicates).toHaveLength(0)
    })

    it('should work with different key fields', () => {
      const indexedItems = [
        { filePath: '/a', subject: 'Test' },
        { filePath: '/b', subject: 'Test' },
        { filePath: '/a', subject: 'Duplicate' }
      ]

      const duplicates = findDuplicates(indexedItems, 'filePath')

      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]).toEqual({ id: '/a', count: 2 })
    })

    it('should convert keys to strings for consistency', () => {
      const indexedItems = [
        { id: 123, text: 'first' },
        { id: '123', text: 'second' },
        { id: 123, text: 'third' }
      ]

      const duplicates = findDuplicates(indexedItems, 'id')

      // All treated as string "123"
      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]).toEqual({ id: '123', count: 3 })
    })
  })

  describe('formatAuditReport', () => {
    it('should format report with perfect coverage', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: {
            source: 100,
            indexed: 100,
            coverage: 1.0
          },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('INDEX AUDIT REPORT')
      expect(report).toContain('EMAILS')
      expect(report).toContain('✓ Source: 100 emails')
      expect(report).toContain('✓ Indexed: 100 emails')
      expect(report).toContain('100.0%')
      expect(report).toContain('(Perfect!)')
      expect(report).toContain('No issues found')
      expect(report).toContain('SUMMARY REPORT')
      expect(report).toContain('Health Status: HEALTHY')
      expect(report).toContain('END OF AUDIT REPORT')
    })

    it('should format report with missing items', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: {
            source: 100,
            indexed: 95,
            coverage: 0.95
          },
          discrepancies: {
            missing: [
              {
                filePath: '/path/to/email1.emlx',
                subject: 'Test Email 1',
                from: 'test@example.com',
                date: '2025-01-01',
                reason: 'Not indexed'
              },
              {
                filePath: '/path/to/email2.emlx',
                subject: 'Test Email 2',
                from: 'test2@example.com',
                date: '2025-01-02',
                reason: 'Not indexed'
              }
            ],
            orphaned: [],
            duplicates: [],
            missingCount: 5,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('✗ Coverage: 95.0%')
      expect(report).toContain('(5 missing, 0 orphaned, 0 duplicates)')
      expect(report).toContain('MISSING ITEMS (2 truly missing)')
      expect(report).toContain('/path/to/email1.emlx')
      expect(report).toContain('Subject: Test Email 1')
      expect(report).toContain('From: test@example.com')
      expect(report).toContain('rebuild_index')
    })

    it('should format report with duplicates', () => {
      const results = {
        messages: {
          dataType: 'messages',
          counts: {
            source: 100,
            indexed: 102,
            coverage: 1.02
          },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [
              {
                id: '12345',
                count: 3,
                text: 'Duplicate message',
                sender: 'John Doe'
              }
            ],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 1
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('DUPLICATE ITEMS (1 total)')
      expect(report).toContain('Message ID 12345 indexed 3 times')
      expect(report).toContain('Duplicates indicate index corruption')
    })

    it('should format report for multiple data sources', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: { source: 100, indexed: 100, coverage: 1.0 },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 0
          }
        },
        messages: {
          dataType: 'messages',
          counts: { source: 200, indexed: 198, coverage: 0.99 },
          discrepancies: {
            missing: [{ id: '123', text: 'Missing', sender: 'Me', date: '2025-01-01', reason: 'Not indexed' }],
            orphaned: [],
            duplicates: [],
            missingCount: 2,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('EMAILS')
      expect(report).toContain('MESSAGES')
      expect(report).toContain('100.0%')
      expect(report).toContain('99.0%')
      expect(report).toContain('rebuild_index with sources: ["messages"]')
    })

    it('should handle orphaned items', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: { source: 100, indexed: 105, coverage: 1.05 },
          discrepancies: {
            missing: [],
            orphaned: [
              {
                filePath: '/deleted/email.emlx',
                subject: 'Old Email',
                reason: 'File no longer exists (deleted from Mail.app)'
              }
            ],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 5,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('ORPHANED ITEMS (5 total)')
      expect(report).toContain('/deleted/email.emlx')
      expect(report).toContain('File no longer exists')
      expect(report).toContain('Orphaned entries will be removed during rebuild')
    })

    it('should format numbers with thousands separator', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: { source: 12450, indexed: 12450, coverage: 1.0 },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('12,450')
    })

    it('should include timestamp in report', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: { source: 100, indexed: 100, coverage: 1.0 },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('Generated:')
      expect(report).toMatch(/Generated: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
    })

    it('should include summary report section', () => {
      const results = {
        emails: {
          dataType: 'emails',
          counts: { source: 1000, indexed: 995, coverage: 0.995 },
          discrepancies: {
            missing: [{ filePath: '/test.emlx', subject: 'Test', from: 'me', date: '2025-01-01', reason: 'Not indexed' }],
            orphaned: [],
            duplicates: [],
            missingCount: 5,
            orphanedCount: 0,
            duplicateCount: 0
          }
        },
        messages: {
          dataType: 'messages',
          counts: { source: 2000, indexed: 2000, coverage: 1.0 },
          discrepancies: {
            missing: [],
            orphaned: [],
            duplicates: [],
            missingCount: 0,
            orphanedCount: 0,
            duplicateCount: 0
          }
        }
      }

      const report = formatAuditReport(results)

      expect(report).toContain('SUMMARY REPORT')
      expect(report).toContain('Data Sources Audited: 2')
      expect(report).toContain('Total Files: 3,000')
      expect(report).toContain('Total Indexed: 2,995')
      expect(report).toContain('Unique Item Coverage: 99.8%')
      expect(report).toContain('Health Status: MINOR ISSUES')
      expect(report).toContain('Issue Breakdown:')
      expect(report).toContain('Truly Missing: 1')
      expect(report).toContain('Per-Source Status:')
      expect(report).toContain('✗ emails: 99.5% coverage (5 issues)')
      expect(report).toContain('✓ messages: 100.0% coverage (0 issues)')
      expect(report).toContain('ALL DISCREPANCIES (Detailed List)')
      expect(report).toContain('From emails:')
      expect(report).toContain('/test.emlx')
      expect(report).toContain('Subject: Test')
      expect(report).toContain('END OF AUDIT REPORT')
    })
  })

  describe('Edge Cases and Boundaries', () => {
    it('findMissing should handle large sets efficiently', () => {
      const sourceIds = new Set()
      const indexedIds = new Set()

      // Create 100k items
      for (let i = 0; i < 100000; i++) {
        sourceIds.add(`item-${i}`)
      }
      // Index only 99k
      for (let i = 0; i < 99000; i++) {
        indexedIds.add(`item-${i}`)
      }

      const start = Date.now()
      const missing = findMissing(sourceIds, indexedIds)
      const duration = Date.now() - start

      expect(missing).toHaveLength(1000)
      expect(duration).toBeLessThan(1000) // Should complete in under 1 second
    })

    it('findDuplicates should handle many duplicates', () => {
      const indexedItems = []

      // Create items where each ID appears 5 times
      for (let i = 0; i < 100; i++) {
        for (let j = 0; j < 5; j++) {
          indexedItems.push({ id: `item-${i}`, value: `value-${j}` })
        }
      }

      const duplicates = findDuplicates(indexedItems, 'id')

      expect(duplicates).toHaveLength(100)
      expect(duplicates.every(d => d.count === 5)).toBe(true)
    })

    it('should handle unicode and special characters in IDs', () => {
      const sourceIds = new Set(['文件.emlx', 'αβγ.emlx', '!@#$.emlx'])
      const indexedIds = new Set(['文件.emlx', '!@#$.emlx'])

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(1)
      expect(missing).toContain('αβγ.emlx')
    })

    it('should handle very long file paths', () => {
      const longPath = '/Users/test/' + 'a'.repeat(1000) + '.emlx'
      const sourceIds = new Set([longPath])
      const indexedIds = new Set()

      const missing = findMissing(sourceIds, indexedIds)

      expect(missing).toHaveLength(1)
      expect(missing[0]).toBe(longPath)
    })
  })
})
