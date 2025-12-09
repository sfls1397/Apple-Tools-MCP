/**
 * Real Data Performance Tests
 *
 * Measures actual throughput with real embeddings and real data
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  checkDataSources,
  isProductionIndexReady,
  searchProductionIndex,
  embed,
  embedBatch,
  getProductionIndexStats,
  sampleEmails,
  sampleMessages,
  sampleCalendarEvents
} from '../helpers/real-data.js'
import fs from 'fs'

const sources = checkDataSources()

describe('Real Data Throughput', () => {
  describe('Embedding Throughput', () => {
    it('should measure single embedding performance', async () => {
      const texts = [
        'This is a test email about quarterly budget meeting with the finance team',
        'Meeting agenda: project updates, timeline review, resource allocation',
        'Please review the attached document before our discussion tomorrow',
        'Following up on our conversation about the new product launch',
        'Reminder: team standup meeting at 10am in the main conference room'
      ]

      const times = []
      for (const text of texts) {
        const start = performance.now()
        await embed(text)
        times.push(performance.now() - start)
      }

      const avgTime = times.reduce((a, b) => a + b, 0) / times.length
      const throughput = 1000 / avgTime // embeddings per second

      console.log(`Single embedding: ${avgTime.toFixed(0)}ms avg (${throughput.toFixed(1)}/sec)`)

      // Real embeddings should complete in reasonable time (< 2 seconds each)
      expect(avgTime).toBeLessThan(2000)
    }, 60000)

    it('should measure batch embedding performance', async () => {
      const batch = [
        'Email about project deadline extension request',
        'Calendar invite for weekly team sync meeting',
        'Message from John about dinner plans this weekend',
        'Invoice attachment needs your approval by Friday',
        'Travel itinerary for upcoming conference in San Francisco',
        'Bug report: login page not loading on mobile devices',
        'Customer feedback survey results are now available',
        'New hire onboarding checklist needs your review'
      ]

      const start = performance.now()
      const vectors = await embedBatch(batch)
      const duration = performance.now() - start

      const throughput = (batch.length / duration) * 1000 // items per second

      console.log(`Batch embedding (${batch.length} items): ${duration.toFixed(0)}ms (${throughput.toFixed(1)}/sec)`)

      expect(vectors).toHaveLength(batch.length)
      expect(duration).toBeLessThan(30000) // Should complete in 30 seconds
    }, 60000)
  })

  describe.skipIf(!sources.mail && !sources.messages && !sources.calendar || !sources.productionIndex)(
    'Search Throughput',
    () => {
      beforeAll(async () => {
        const ready = await isProductionIndexReady()
        if (!ready) {
          throw new Error('Production index not found. Run "npm run rebuild-index" first.')
        }
      }, 30000)

      it('should measure search query performance', async () => {
        const queries = [
          'meeting',
          'project deadline',
          'budget review',
          'team discussion',
          'quarterly report'
        ]

        const times = []
        for (const query of queries) {
          const start = performance.now()
          await searchProductionIndex(query, 'emails', 10)
          times.push(performance.now() - start)
        }

        const avgTime = times.reduce((a, b) => a + b, 0) / times.length
        const throughput = 1000 / avgTime

        console.log(`Search query: ${avgTime.toFixed(0)}ms avg (${throughput.toFixed(1)} queries/sec)`)

        // Search should be fast (< 5 seconds per query including embedding)
        expect(avgTime).toBeLessThan(5000)
      }, 60000)

      it('should measure repeated query performance (caching)', async () => {
        const query = 'important meeting discussion'

        // First query (cold)
        const start1 = performance.now()
        await searchProductionIndex(query, 'emails', 10)
        const cold = performance.now() - start1

        // Second query (warm - embedding cached)
        const start2 = performance.now()
        await searchProductionIndex(query, 'emails', 10)
        const warm = performance.now() - start2

        console.log(`Cold query: ${cold.toFixed(0)}ms, Warm query: ${warm.toFixed(0)}ms`)

        // Warm query should be faster or similar (not significantly slower)
        // Allow some variance due to system load - either relative (2x cold) or absolute (50ms)
        const isReasonable = warm < cold * 2 || warm < 50
        expect(isReasonable).toBe(true)
      }, 60000)

      it('should handle concurrent searches', async () => {
        const queries = [
          'project',
          'meeting',
          'deadline',
          'review',
          'update'
        ]

        const start = performance.now()
        const results = await Promise.all(
          queries.map(q => searchProductionIndex(q, 'emails', 5))
        )
        const duration = performance.now() - start

        console.log(`${queries.length} concurrent searches: ${duration.toFixed(0)}ms`)

        expect(results).toHaveLength(queries.length)
        // Concurrent should complete in reasonable time
        expect(duration).toBeLessThan(30000)
      }, 60000)
    }
  )
})

describe.skipIf(!sources.mail && !sources.messages && !sources.calendar)(
  'Index Build Performance',
  () => {
    it('should measure index build time', async () => {
      // Using production index for realistic performance measurements
      const ready = await isProductionIndexReady()

      if (!ready) {
        const start = performance.now()
        await buildProductionIndex()
        const duration = performance.now() - start
        console.log(`Production index built in ${(duration/1000).toFixed(1)}s`)
      }

      const stats = await getProductionIndexStats()
      const totalItems = stats.emails + stats.messages + stats.calendar

      const throughput = totalItems > 0 ? (totalItems / 1000) : 0 // items per second (estimate)

      console.log('Index build performance:')
      console.log(`  Emails: ${stats.emails}`)
      console.log(`  Messages: ${stats.messages}`)
      console.log(`  Calendar: ${stats.calendar}`)
      console.log(`  Total: ${totalItems} items`)

      expect(totalItems).toBeGreaterThan(0)
    }, 1200000) // 20 minutes for full build (sequential indexing)
  }
)

describe('Data Sampling Performance', () => {
  it.skipIf(!sources.mail)('should sample emails efficiently', async () => {
    const start = performance.now()
    const emails = await sampleEmails(100)
    const duration = performance.now() - start

    console.log(`Sampled ${emails.length} emails in ${duration.toFixed(0)}ms`)

    expect(duration).toBeLessThan(30000) // Should complete in 30 seconds
  }, 60000)

  it.skipIf(!sources.messages)('should sample messages efficiently', async () => {
    const start = performance.now()
    const messages = await sampleMessages(100)
    const duration = performance.now() - start

    console.log(`Sampled ${messages.length} messages in ${duration.toFixed(0)}ms`)

    expect(duration).toBeLessThan(10000) // SQLite query should be fast
  }, 30000)

  it.skipIf(!sources.calendar)('should sample calendar events efficiently', async () => {
    const start = performance.now()
    const events = await sampleCalendarEvents(100)
    const duration = performance.now() - start

    console.log(`Sampled ${events.length} events in ${duration.toFixed(0)}ms`)

    expect(duration).toBeLessThan(10000)
  }, 30000)
})
