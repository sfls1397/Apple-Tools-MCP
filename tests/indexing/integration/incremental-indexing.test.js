
import { describe, it, expect, beforeEach, vi } from 'vitest'

const MAC_ABSOLUTE_EPOCH = 978307200

describe('Incremental Indexing', () => {
  describe('timestamp-based message filtering', () => {
    const filterMessagesBySinceTimestamp = (messages, sinceTimestamp) => {
      if (!sinceTimestamp) return messages

      const macAbsoluteNs = (sinceTimestamp / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000

      return messages.filter(m => {
        const msgMacAbsoluteNs = (m.dateTimestamp - MAC_ABSOLUTE_EPOCH) * 1000000000
        return msgMacAbsoluteNs >= macAbsoluteNs
      })
    }

    it('should return all messages when sinceTimestamp is null', () => {
      const messages = [
        { id: 1, dateTimestamp: MAC_ABSOLUTE_EPOCH + 1000 },
        { id: 2, dateTimestamp: MAC_ABSOLUTE_EPOCH + 2000 },
        { id: 3, dateTimestamp: MAC_ABSOLUTE_EPOCH + 3000 }
      ]

      const result = filterMessagesBySinceTimestamp(messages, null)
      expect(result).toHaveLength(3)
    })

    it('should filter messages older than sinceTimestamp', () => {
      const messages = [
        { id: 1, dateTimestamp: MAC_ABSOLUTE_EPOCH + 1000 },
        { id: 2, dateTimestamp: MAC_ABSOLUTE_EPOCH + 2000 },
        { id: 3, dateTimestamp: MAC_ABSOLUTE_EPOCH + 3000 }
      ]

      const sinceTimestamp = (MAC_ABSOLUTE_EPOCH + 2500) * 1000

      const result = filterMessagesBySinceTimestamp(messages, sinceTimestamp)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(3)
    })

    it('should include messages exactly at sinceTimestamp', () => {
      const messages = [
        { id: 1, dateTimestamp: MAC_ABSOLUTE_EPOCH + 2000 }
      ]

      const sinceTimestamp = (MAC_ABSOLUTE_EPOCH + 2000) * 1000

      const result = filterMessagesBySinceTimestamp(messages, sinceTimestamp)
      expect(result).toHaveLength(1)
    })

    it('should handle empty message list', () => {
      const result = filterMessagesBySinceTimestamp([], Date.now())
      expect(result).toHaveLength(0)
    })
  })

  describe('metadata timestamp management', () => {
    let mockMeta = {}

    const loadIndexMeta = () => ({ ...mockMeta })

    const saveIndexMeta = (meta) => {
      mockMeta = { ...meta }
    }

    beforeEach(() => {
      mockMeta = {}
    })

    it('should save lastMessageIndexTime after indexing', () => {
      const indexStartTime = Date.now()

      const meta = loadIndexMeta()
      saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime })

      const savedMeta = loadIndexMeta()
      expect(savedMeta.lastMessageIndexTime).toBe(indexStartTime)
    })

    it('should preserve other metadata fields when saving', () => {
      mockMeta = { lastEmailIndexTime: 1234567890, otherField: 'value' }

      const meta = loadIndexMeta()
      const indexStartTime = Date.now()
      saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime })

      const savedMeta = loadIndexMeta()
      expect(savedMeta.lastEmailIndexTime).toBe(1234567890)
      expect(savedMeta.otherField).toBe('value')
      expect(savedMeta.lastMessageIndexTime).toBe(indexStartTime)
    })

    it('should return empty object when no metadata exists', () => {
      mockMeta = {}
      const meta = loadIndexMeta()
      expect(meta).toEqual({})
    })
  })

  describe('1-hour buffer logic', () => {
    const ONE_HOUR_MS = 60 * 60 * 1000

    const calculateEffectiveTimestamp = (lastIndexTime, forceFullScan) => {
      if (forceFullScan) return null
      if (!lastIndexTime) return null
      return lastIndexTime - ONE_HOUR_MS
    }

    it('should return null for forceFullScan', () => {
      const result = calculateEffectiveTimestamp(Date.now(), true)
      expect(result).toBeNull()
    })

    it('should return null when no previous timestamp', () => {
      const result = calculateEffectiveTimestamp(null, false)
      expect(result).toBeNull()
    })

    it('should subtract 1 hour from previous timestamp', () => {
      const lastIndexTime = Date.now()
      const result = calculateEffectiveTimestamp(lastIndexTime, false)

      expect(result).toBe(lastIndexTime - ONE_HOUR_MS)
    })

    it('should handle timestamps at epoch', () => {
      const lastIndexTime = ONE_HOUR_MS
      const result = calculateEffectiveTimestamp(lastIndexTime, false)

      expect(result).toBe(0)
    })
  })

  describe('full scan vs incremental scan detection', () => {
    const determinesScanType = (meta, forceFullScan) => {
      const ONE_HOUR_MS = 60 * 60 * 1000
      const lastMessageIndexTime = forceFullScan ? null :
        (meta.lastMessageIndexTime ? meta.lastMessageIndexTime - ONE_HOUR_MS : null)

      return lastMessageIndexTime ? 'incremental' : 'full'
    }

    it('should do full scan on first run (no metadata)', () => {
      const scanType = determinesScanType({}, false)
      expect(scanType).toBe('full')
    })

    it('should do full scan when forceFullScan is true', () => {
      const meta = { lastMessageIndexTime: Date.now() }
      const scanType = determinesScanType(meta, true)
      expect(scanType).toBe('full')
    })

    it('should do incremental scan when metadata exists', () => {
      const meta = { lastMessageIndexTime: Date.now() }
      const scanType = determinesScanType(meta, false)
      expect(scanType).toBe('incremental')
    })

    it('should do full scan when lastMessageIndexTime is 0', () => {
      const meta = { lastMessageIndexTime: 0 }
      const scanType = determinesScanType(meta, false)
      expect(scanType).toBe('full')
    })
  })

  describe('Mac Absolute Time conversion', () => {
    it('should correctly convert Unix ms to Mac Absolute nanoseconds', () => {
      const unixMs = MAC_ABSOLUTE_EPOCH * 1000
      const macAbsoluteNs = (unixMs / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000

      expect(macAbsoluteNs).toBe(0)
    })

    it('should handle current time correctly', () => {
      const now = Date.now()
      const macAbsoluteNs = (now / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000

      expect(macAbsoluteNs).toBeGreaterThan(0)
    })

    it('should handle timestamps before Mac epoch', () => {
      const year2000 = new Date('2000-01-01T00:00:00Z').getTime()
      const macAbsoluteNs = (year2000 / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000

      expect(macAbsoluteNs).toBeLessThan(0)
    })

    it('should produce consistent round-trip conversion', () => {
      const originalUnixMs = Date.now()

      const macAbsoluteNs = (originalUnixMs / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000

      const convertedUnixMs = (macAbsoluteNs / 1000000000 + MAC_ABSOLUTE_EPOCH) * 1000

      expect(Math.abs(convertedUnixMs - originalUnixMs)).toBeLessThan(1)
    })
  })

  describe('indexing workflow integration', () => {
    const simulateIndexMessages = async (options) => {
      const {
        existingMessages,
        indexedIds,
        forceFullScan,
        lastMessageIndexTime
      } = options

      const ONE_HOUR_MS = 60 * 60 * 1000
      const indexStartTime = Date.now()

      const effectiveTimestamp = forceFullScan ? null :
        (lastMessageIndexTime ? lastMessageIndexTime - ONE_HOUR_MS : null)

      let messages = existingMessages
      if (effectiveTimestamp) {
        messages = existingMessages.filter(m =>
          m.dateTimestamp * 1000 >= effectiveTimestamp
        )
      }

      const toIndex = messages.filter(m => !indexedIds.has(String(m.id)))

      return {
        scanType: effectiveTimestamp ? 'incremental' : 'full',
        messagesFound: messages.length,
        messagesToIndex: toIndex.length,
        newLastMessageIndexTime: indexStartTime
      }
    }

    it('should perform full scan and index all messages on first run', async () => {
      const result = await simulateIndexMessages({
        existingMessages: [
          { id: 1, dateTimestamp: Date.now() / 1000 - 86400 },
          { id: 2, dateTimestamp: Date.now() / 1000 - 3600 },
          { id: 3, dateTimestamp: Date.now() / 1000 }
        ],
        indexedIds: new Set(),
        forceFullScan: false,
        lastMessageIndexTime: null
      })

      expect(result.scanType).toBe('full')
      expect(result.messagesFound).toBe(3)
      expect(result.messagesToIndex).toBe(3)
    })

    it('should perform incremental scan on subsequent runs', async () => {
      const now = Date.now()
      const twoHoursAgo = now - 2 * 60 * 60 * 1000

      const result = await simulateIndexMessages({
        existingMessages: [
          { id: 1, dateTimestamp: (now - 3 * 60 * 60 * 1000) / 1000 },
          { id: 2, dateTimestamp: (now - 30 * 60 * 1000) / 1000 },
          { id: 3, dateTimestamp: now / 1000 }
        ],
        indexedIds: new Set(['1']),
        forceFullScan: false,
        lastMessageIndexTime: twoHoursAgo
      })

      expect(result.scanType).toBe('incremental')
      expect(result.messagesFound).toBe(3)
      expect(result.messagesToIndex).toBe(2)
    })

    it('should force full scan when requested', async () => {
      const now = Date.now()

      const result = await simulateIndexMessages({
        existingMessages: [
          { id: 1, dateTimestamp: (now - 7 * 24 * 60 * 60 * 1000) / 1000 },
          { id: 2, dateTimestamp: now / 1000 }
        ],
        indexedIds: new Set(['1']),
        forceFullScan: true,
        lastMessageIndexTime: now - 60 * 60 * 1000
      })

      expect(result.scanType).toBe('full')
      expect(result.messagesFound).toBe(2)
    })

    it('should skip already indexed messages', async () => {
      const result = await simulateIndexMessages({
        existingMessages: [
          { id: 1, dateTimestamp: Date.now() / 1000 },
          { id: 2, dateTimestamp: Date.now() / 1000 },
          { id: 3, dateTimestamp: Date.now() / 1000 }
        ],
        indexedIds: new Set(['1', '2', '3']),
        forceFullScan: false,
        lastMessageIndexTime: null
      })

      expect(result.messagesToIndex).toBe(0)
    })
  })
})
