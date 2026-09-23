/**
 * Real Data Helper Module for Indexing Tests
 *
 * NEW ARCHITECTURE: Real Data Only, No Rebuilding
 *
 * This module provides utilities for:
 * - Checking availability of real data sources (Mail, Messages, Calendar)
 * - Accessing the system index at ~/.apple-tools-mcp/vector-index/
 * - Real embedding pipeline access (Xenova/all-MiniLM-L6-v2 only)
 *
 * IMPORTANT: Tests assume the system index already exists.
 * Build it separately with: npm run build-index
 * Tests NEVER rebuild the index - they only validate it.
 */

import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)

const HOME = process.env.HOME

// Data directories
const DATA_DIR = path.join(HOME, '.apple-tools-mcp')
const PRODUCTION_INDEX_DIR = path.join(DATA_DIR, 'vector-index')

// Real data source paths on macOS
export const MAIL_DIR = path.join(HOME, 'Library/Mail')
export const MESSAGES_DB = path.join(HOME, 'Library/Messages/chat.db')
export const CALENDAR_DB = path.join(HOME, 'Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb')
export const CONTACTS_DB = path.join(HOME, 'Library/Application Support/AddressBook/AddressBook-v22.abcddb')

// Export paths for tests
export { PRODUCTION_INDEX_DIR, DATA_DIR }

/**
 * Check if real data sources exist on this system
 * Tests can use this to skip if data isn't available
 */
export function checkDataSources() {
  return {
    mail: fs.existsSync(MAIL_DIR),
    messages: fs.existsSync(MESSAGES_DB),
    calendar: fs.existsSync(CALENDAR_DB),
    contacts: fs.existsSync(CONTACTS_DB),
    productionIndex: fs.existsSync(PRODUCTION_INDEX_DIR),
    embedder: embedderAvailable()
  }
}

/**
 * True when the Transformers.js sharp native can load.
 * This package is darwin-only; Linux CI / Cloud Agent checkouts typically have
 * a darwin sharp binary and fail with sharp-linux-x64.node missing. Real
 * embedding idx tests must skip instead of failing the suite.
 */
let cachedEmbedderAvailable
export function embedderAvailable() {
  if (cachedEmbedderAvailable !== undefined) return cachedEmbedderAvailable
  if (process.platform !== 'darwin') {
    cachedEmbedderAvailable = false
    return false
  }
  try {
    const transformersRequire = createRequire(require.resolve('@huggingface/transformers'))
    transformersRequire('sharp')
    cachedEmbedderAvailable = true
  } catch {
    cachedEmbedderAvailable = false
  }
  return cachedEmbedderAvailable
}

/**
 * Get real embedding pipeline (Xenova/all-MiniLM-L6-v2)
 * Pipeline is cached for reuse across tests
 */
let embeddingPipeline = null
export async function getEmbedder() {
  if (!embeddingPipeline) {
    const { pipeline } = await import('@huggingface/transformers')
    embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return embeddingPipeline
}

/**
 * Generate real embedding for text
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array>} 384-dim embedding vector
 */
export async function embed(text) {
  const embedder = await getEmbedder()
  const output = await embedder(text, { pooling: 'mean', normalize: true })
  return output.data
}

/**
 * Generate embeddings for multiple texts
 * @param {string[]} texts - Array of texts
 * @returns {Promise<Float32Array[]>} Array of 384-dim vectors
 */
export async function embedBatch(texts) {
  const embedder = await getEmbedder()
  const results = []

  for (const text of texts) {
    const output = await embedder(text, { pooling: 'mean', normalize: true })
    results.push(output.data)
  }

  return results
}

/**
 * Sample real emails from Mail directory
 * @param {number} limit - Max emails to return
 * @param {number} daysBack - Only include emails from last N days (default: 30)
 * @returns {Promise<string[]>} Array of .emlx file paths
 */
export async function sampleEmails(limit = 50, daysBack = 30) {
  if (!fs.existsSync(MAIL_DIR)) {
    return []
  }

  try {
    // Calculate cutoff date (N days ago)
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysBack)
    const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000)

    // Use mdfind to find emails modified in the last N days
    const output = execSync(
      `mdfind -onlyin "${MAIL_DIR}" "kMDItemContentType == 'com.apple.mail.emlx' && kMDItemFSContentChangeDate >= \\$time.iso(${cutoffDate.toISOString()})" | head -${limit}`,
      { encoding: 'utf-8', timeout: 30000 }
    )
    return output.trim().split('\n').filter(Boolean)
  } catch (e) {
    console.warn('Failed to sample emails:', e.message)
    return []
  }
}

/**
 * Sample real messages from Messages database
 * @param {number} limit - Max messages to return
 * @param {number} daysBack - Only include messages from last N days (default: 30)
 * @returns {Promise<Object[]>} Array of message objects
 */
export async function sampleMessages(limit = 50, daysBack = 30) {
  if (!fs.existsSync(MESSAGES_DB)) {
    return []
  }

  try {
    // Messages uses Cocoa Core Data timestamp (seconds since 2001-01-01)
    const cocoaEpoch = new Date('2001-01-01T00:00:00Z').getTime()
    const now = Date.now()
    const cutoffDate = now - (daysBack * 24 * 60 * 60 * 1000)
    const cutoffTimestamp = (cutoffDate - cocoaEpoch) / 1000

    const query = `
      SELECT
        m.ROWID as id,
        m.text,
        m.date,
        m.is_from_me,
        h.id as sender
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.text IS NOT NULL AND m.text != ''
        AND m.date >= ${cutoffTimestamp}
      ORDER BY m.date DESC
      LIMIT ${limit}
    `

    const output = execSync(
      `sqlite3 -json "${MESSAGES_DB}" "${query}"`,
      { encoding: 'utf-8', timeout: 30000 }
    )

    return JSON.parse(output || '[]')
  } catch (e) {
    console.warn('Failed to sample messages:', e.message)
    return []
  }
}

/**
 * Sample real calendar events
 * @param {number} limit - Max events to return
 * @param {number} daysBack - Only include events from last N days (default: 30)
 * @returns {Promise<Object[]>} Array of event objects
 */
export async function sampleCalendarEvents(limit = 50, daysBack = 30) {
  if (!fs.existsSync(CALENDAR_DB)) {
    return []
  }

  try {
    // Calendar uses Cocoa Core Data timestamp (seconds since 2001-01-01)
    const cocoaEpoch = new Date('2001-01-01T00:00:00Z').getTime()
    const now = Date.now()
    const cutoffDate = now - (daysBack * 24 * 60 * 60 * 1000)
    const cutoffTimestamp = (cutoffDate - cocoaEpoch) / 1000

    const query = `
      SELECT
        ci.ROWID as id,
        ci.summary as title,
        ci.start_date,
        ci.end_date,
        c.title as calendar_name
      FROM CalendarItem ci
      JOIN Calendar c ON ci.calendar_id = c.ROWID
      WHERE ci.summary IS NOT NULL
        AND ci.start_date >= ${cutoffTimestamp}
      ORDER BY ci.start_date DESC
      LIMIT ${limit}
    `

    const output = execSync(
      `sqlite3 -json "${CALENDAR_DB}" "${query}"`,
      { encoding: 'utf-8', timeout: 30000 }
    )

    return JSON.parse(output || '[]')
  } catch (e) {
    console.warn('Failed to sample calendar events:', e.message)
    return []
  }
}

/**
 * NOTE: buildProductionIndex() has been removed.
 * The system index at ~/.apple-tools-mcp/vector-index/ is built and maintained
 * by the main application, not by tests. Tests assume it exists and only validate it.
 *
 * To rebuild the system index, users run: npm run build-index
 * Tests should NEVER rebuild the index.
 */

/**
 * Get production index table counts
 * @returns {Promise<Object>} Counts for each table
 */
export async function getProductionIndexStats() {
  const lancedb = await import('@lancedb/lancedb')

  if (!fs.existsSync(PRODUCTION_INDEX_DIR)) {
    return { emails: 0, messages: 0, calendar: 0 }
  }

  try {
    const db = await lancedb.connect(PRODUCTION_INDEX_DIR)
    const tables = await db.tableNames()

    const stats = {
      emails: 0,
      messages: 0,
      calendar: 0
    }

    for (const tableName of tables) {
      if (stats.hasOwnProperty(tableName)) {
        const table = await db.openTable(tableName)
        stats[tableName] = await table.countRows()
      }
    }

    return stats
  } catch (e) {
    console.warn('Failed to get production index stats:', e.message)
    return { emails: 0, messages: 0, calendar: 0, error: e.message }
  }
}

/**
 * Check if production index is ready (has all tables with data)
 * @returns {Promise<boolean>}
 */
export async function isProductionIndexReady() {
  const stats = await getProductionIndexStats()
  return stats.emails > 0 || stats.messages > 0 || stats.calendar > 0
}

/**
 * Search production index
 * @param {string} query - Search query
 * @param {string} table - Table to search (emails, messages, calendar)
 * @param {number} limit - Max results
 * @returns {Promise<Object[]>} Search results
 */
export async function searchProductionIndex(query, table = 'emails', limit = 10) {
  const lancedb = await import('@lancedb/lancedb')
  const db = await lancedb.connect(PRODUCTION_INDEX_DIR)

  const tables = await db.tableNames()
  if (!tables.includes(table)) {
    throw new Error(`Table ${table} not found in production index`)
  }

  const tbl = await db.openTable(table)
  const queryVector = await embed(query)

  const results = await tbl.search(Array.from(queryVector))
    .limit(limit)
    .toArray()

  return results
}
