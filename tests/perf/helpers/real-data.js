/**
 * Real data loader for performance tests
 * Connects to actual LanceDB index and macOS data sources
 */

import fs from 'fs'
import path from 'path'
import { connect } from '@lancedb/lancedb'
import { pipeline } from '@xenova/transformers'

// Real paths
const DATA_DIR = path.join(process.env.HOME, '.apple-tools-mcp')
const DB_PATH = path.join(DATA_DIR, 'vector-index')

let db = null
let embedder = null
let tables = {}

/**
 * Check if real data index exists
 */
export function isRealDataAvailable() {
  return fs.existsSync(DB_PATH)
}

/**
 * Get the real embedder (Xenova/all-MiniLM-L6-v2)
 */
export async function getRealEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return embedder
}

/**
 * Generate embedding using real model
 */
export async function realEmbed(text) {
  const emb = await getRealEmbedder()
  const output = await emb(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

/**
 * Batch embed using real model
 */
export async function realEmbedBatch(texts) {
  if (texts.length === 0) return []
  if (texts.length === 1) return [await realEmbed(texts[0])]

  const emb = await getRealEmbedder()
  const result = await emb(texts, { pooling: 'mean', normalize: true })

  const EMBEDDING_DIM = 384
  const embeddings = []
  for (let i = 0; i < texts.length; i++) {
    const start = i * EMBEDDING_DIM
    const end = start + EMBEDDING_DIM
    embeddings.push(Array.from(result.data.slice(start, end)))
  }
  return embeddings
}

/**
 * Connect to real LanceDB
 */
export async function connectToRealDB() {
  if (!db && isRealDataAvailable()) {
    db = await connect(DB_PATH)
  }
  return db
}

/**
 * Get a table from real DB
 */
export async function getRealTable(tableName) {
  if (tables[tableName]) return tables[tableName]

  const database = await connectToRealDB()
  if (!database) return null

  try {
    const tableNames = await database.tableNames()
    if (!tableNames.includes(tableName)) return null

    tables[tableName] = await database.openTable(tableName)
    return tables[tableName]
  } catch (e) {
    console.error(`Error opening table ${tableName}:`, e.message)
    return null
  }
}

/**
 * Get real emails from the index
 */
export async function getRealEmails(limit = 1000) {
  const table = await getRealTable('emails')
  if (!table) return []

  try {
    const results = await table.query().limit(limit).toArray()
    return results.map(r => ({
      id: r.id,
      path: r.filePath,
      from: r.from,
      fromEmail: r.fromEmail,
      to: r.to,
      subject: r.subject,
      body: r.body,
      date: r.date,
      timestamp: r.dateTimestamp,
      hasAttachment: r.hasAttachment,
      mailbox: r.mailbox,
      isSent: r.isSent,
      isFlagged: r.isFlagged,
      vector: r.vector
    }))
  } catch (e) {
    console.error('Error loading real emails:', e.message)
    return []
  }
}

/**
 * Get real messages from the index
 */
export async function getRealMessages(limit = 500) {
  const table = await getRealTable('messages')
  if (!table) return []

  try {
    const results = await table.query().limit(limit).toArray()
    return results.map(r => ({
      id: r.id,
      ROWID: r.id,
      text: r.text,
      sender: r.sender,
      date: r.date,
      timestamp: r.dateTimestamp,
      chatId: r.chatId,
      chatIdentifier: r.chatIdentifier,
      chatName: r.chatName,
      participantCount: r.participantCount || 2,
      isGroup: r.isGroup,
      attachmentCount: r.attachmentCount || 0,
      vector: r.vector
    }))
  } catch (e) {
    console.error('Error loading real messages:', e.message)
    return []
  }
}

/**
 * Get real calendar events from the index
 */
export async function getRealCalendarEvents(limit = 200) {
  const table = await getRealTable('calendar')
  if (!table) return []

  try {
    const results = await table.query().limit(limit).toArray()
    return results.map(r => ({
      id: r.id,
      ROWID: r.id,
      title: r.title,
      summary: r.title,
      start: r.start,
      end: r.end,
      startTimestamp: r.startTimestamp,
      endTimestamp: r.endTimestamp,
      isAllDay: r.isAllDay,
      all_day: r.isAllDay ? 1 : 0,
      calendar: r.calendar,
      calendar_name: r.calendar,
      location: r.location,
      notes: r.notes,
      vector: r.vector
    }))
  } catch (e) {
    console.error('Error loading real calendar events:', e.message)
    return []
  }
}

/**
 * Perform real vector search
 */
export async function realVectorSearch(tableName, query, limit = 20) {
  const table = await getRealTable(tableName)
  if (!table) return []

  try {
    const embedding = await realEmbed(query)
    const results = await table.search(embedding).limit(limit).toArray()
    return results
  } catch (e) {
    console.error(`Error searching ${tableName}:`, e.message)
    return []
  }
}

/**
 * Get table statistics
 */
export async function getTableStats() {
  const stats = {}

  for (const tableName of ['emails', 'messages', 'calendar']) {
    const table = await getRealTable(tableName)
    if (table) {
      try {
        stats[tableName] = await table.countRows()
      } catch {
        stats[tableName] = 0
      }
    } else {
      stats[tableName] = 0
    }
  }

  return stats
}

/**
 * Create performance mocks that use real data
 */
export function createRealDataMocks() {
  return {
    embedder: {
      embedder: async (texts) => {
        const vectors = await realEmbedBatch(Array.isArray(texts) ? texts : [texts])
        return { data: new Float32Array(vectors.flat()) }
      },
      pipeline: async () => getRealEmbedder()
    },
    lancedb: {
      connect: connectToRealDB,
      tables
    },
    // Real data loaders
    getEmails: getRealEmails,
    getMessages: getRealMessages,
    getCalendarEvents: getRealCalendarEvents,
    search: realVectorSearch
  }
}

/**
 * Cleanup resources
 */
export async function cleanup() {
  db = null
  tables = {}
  embedder = null
}
