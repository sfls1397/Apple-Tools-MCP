/**
 * Index Audit Module for apple-tools-mcp
 *
 * Provides comprehensive auditing of the vector index against source data
 * with 0% tolerance. Identifies missing items, orphaned entries, and duplicates.
 *
 * Core Features:
 * - 100% source data validation (no filtering by date)
 * - Detailed verbose reporting with file paths and metadata
 * - Performance optimized for 100k+ items
 * - Report-only (no auto-fix)
 */

import fs from "fs";
import path from "path";
import { safeSqlite3Json, safeFind } from "./shell.js";
import * as lancedb from "@lancedb/lancedb";
import { LANCE_CONNECT_OPTIONS, openMissingIndexTables } from "./lancedbTables.js";

// ============================================================================
// CONSTANTS AND PATHS
// ============================================================================

const HOME = process.env.HOME;
const INDEX_DIR = process.env.APPLE_TOOLS_INDEX_DIR ||
  path.join(HOME, ".apple-tools-mcp", "vector-index");
const MAIL_DIR = path.join(HOME, "Library", "Mail");
const MESSAGES_DB = path.join(HOME, "Library", "Messages", "chat.db");
const CALENDAR_DB = path.join(HOME, "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");

// Mac Absolute Time epoch: Jan 1, 2001 00:00:00 UTC
const MAC_ABSOLUTE_EPOCH = 978307200;

// Email indexing time window (matches indexer.js behavior)
const DAYS_BACK = process.env.APPLE_TOOLS_INDEX_DAYS_BACK ?
  parseInt(process.env.APPLE_TOOLS_INDEX_DAYS_BACK, 10) : null;

// Exclude these folders from email indexing (matches indexer behavior)
const EXCLUDED_FOLDERS = ["Junk.mbox", "Saved Junk.mbox", "Trash.mbox", "Deleted Messages.mbox"];

function listEmailFiles() {
  const options = { name: "*.emlx", type: "f" };
  if (DAYS_BACK) {
    options.mtime = `-${DAYS_BACK}`;
  }
  return safeFind(MAIL_DIR, options).filter(
    p => !EXCLUDED_FOLDERS.some(folder => p.includes(`/${folder}/`))
  );
}

let db = null;
let tables = {};

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

async function initDB() {
  if (!db) {
    try {
      db = await lancedb.connect(INDEX_DIR, LANCE_CONNECT_OPTIONS);
    } catch (e) {
      console.error("Error initializing database:", e.message);
      return { db: null, tables: {} };
    }
  }

  try {
    const result = await openMissingIndexTables({
      db,
      tables,
      indexDir: INDEX_DIR,
      reconnect: async () => {
        try {
          db?.close?.();
        } catch {}
        db = await lancedb.connect(INDEX_DIR, LANCE_CONNECT_OPTIONS);
        return db;
      }
    });
    db = result.db;
    return { db, tables };
  } catch (e) {
    console.error("Error initializing database:", e.message);
    return { db: null, tables: {} };
  }
}

// ============================================================================
// SOURCE COUNTING FUNCTIONS
// ============================================================================

/**
 * Count all .emlx files (excluding Junk/Trash)
 * Respects APPLE_TOOLS_INDEX_DAYS_BACK environment variable
 * @returns {number} Total count of email files
 */
export function countRawEmails() {
  if (!fs.existsSync(MAIL_DIR)) return 0;

  try {
    return listEmailFiles().length;
  } catch (e) {
    console.error("Error counting emails:", e.message);
    return 0;
  }
}

/**
 * Count all messages with text or attributedBody
 * @returns {number} Total count of indexable messages
 */
export function countRawMessages() {
  if (!fs.existsSync(MESSAGES_DB)) return 0;

  try {
    const query = `SELECT COUNT(*) as count FROM message
                   WHERE (text IS NOT NULL AND text != '')
                      OR attributedBody IS NOT NULL`;
    const results = safeSqlite3Json(MESSAGES_DB, query);
    return results[0]?.count || 0;
  } catch (e) {
    console.error("Error counting messages:", e.message);
    return 0;
  }
}

/**
 * Count calendar events in the configured time window
 * (90 days back, 365 days forward)
 * @returns {number} Total count of calendar events
 */
export function countRawCalendarEvents() {
  if (!fs.existsSync(CALENDAR_DB)) return 0;

  try {
    const now = Date.now();
    // Match indexer's 10-year window for comprehensive calendar indexing
    const pastDate = (now / 1000) - MAC_ABSOLUTE_EPOCH - (10 * 365 * 24 * 60 * 60);
    const futureDate = (now / 1000) - MAC_ABSOLUTE_EPOCH + (10 * 365 * 24 * 60 * 60);

    // Count only calendar items that have occurrences (real scheduled events)
    // Don't count database junk like far-future placeholders or deleted events
    const query = `
      SELECT COUNT(DISTINCT ci.ROWID) as count
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      WHERE oc.day IS NOT NULL
        AND oc.day >= ${pastDate}
        AND oc.day <= ${futureDate}
        AND ci.summary IS NOT NULL
    `;
    const results = safeSqlite3Json(CALENDAR_DB, query);
    return results[0]?.count || 0;
  } catch (e) {
    console.error("Error counting calendar events:", e.message);
    return 0;
  }
}

// ============================================================================
// ID EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Get all email file paths (excluding Junk/Trash)
 * Respects APPLE_TOOLS_INDEX_DAYS_BACK environment variable
 * @returns {Set<string>} Set of absolute file paths
 */
export function getRawEmailIds() {
  if (!fs.existsSync(MAIL_DIR)) return new Set();

  try {
    return new Set(listEmailFiles());
  } catch (e) {
    console.error("Error getting email IDs:", e.message);
    return new Set();
  }
}

/**
 * Get all message ROWIDs with text or attributedBody
 * @returns {Set<string>} Set of message IDs (as strings)
 */
export function getRawMessageIds() {
  if (!fs.existsSync(MESSAGES_DB)) return new Set();

  try {
    const query = `SELECT ROWID as id FROM message
                   WHERE (text IS NOT NULL AND text != '')
                      OR attributedBody IS NOT NULL`;
    const results = safeSqlite3Json(MESSAGES_DB, query);
    return new Set(results.map(r => String(r.id)));
  } catch (e) {
    console.error("Error getting message IDs:", e.message);
    return new Set();
  }
}

/**
 * Get all calendar event IDs (just dbId, no timestamp)
 * Uses CalendarItem table with GROUP BY to match indexer's behavior
 * @returns {Set<string>} Set of event IDs
 */
export function getRawCalendarIds() {
  if (!fs.existsSync(CALENDAR_DB)) return new Set();

  try {
    const now = Date.now();
    // Match indexer's 10-year window for comprehensive calendar indexing
    const pastDate = (now / 1000) - MAC_ABSOLUTE_EPOCH - (10 * 365 * 24 * 60 * 60);
    const futureDate = (now / 1000) - MAC_ABSOLUTE_EPOCH + (10 * 365 * 24 * 60 * 60);

    const query = `
      SELECT DISTINCT ci.ROWID as dbId
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      WHERE oc.day IS NOT NULL
        AND oc.day >= ${pastDate}
        AND oc.day <= ${futureDate}
        AND ci.summary IS NOT NULL
      GROUP BY ci.ROWID
    `;

    const results = safeSqlite3Json(CALENDAR_DB, query);
    // Return just the dbId (no timestamp) to match indexer's new format
    return new Set(results.map(r => String(r.dbId)));
  } catch (e) {
    console.error("Error getting calendar IDs:", e.message);
    return new Set();
  }
}

/**
 * Get all indexed IDs from a LanceDB table
 * @param {string} tableName - Name of the table
 * @param {string} idField - Field name containing the ID
 * @returns {Promise<Set>} Set of indexed IDs
 */
export async function getIndexedIds(tableName, idField) {
  await initDB();

  if (!tables[tableName]) return new Set();

  try {
    // Fetch only the ID field for performance
    const results = await tables[tableName].query().select([idField]).limit(1000000).toArray();
    return new Set(results.map(r => String(r[idField])));
  } catch (e) {
    console.error(`Error getting indexed IDs from ${tableName}:`, e.message);
    return new Set();
  }
}

/**
 * Get all indexed items with metadata for detailed reporting
 * @param {string} tableName - Name of the table
 * @param {Array<string>} fields - Fields to retrieve
 * @returns {Promise<Array>} Array of indexed items
 */
async function getIndexedItems(tableName, fields) {
  await initDB();

  if (!tables[tableName]) return [];

  try {
    const results = await tables[tableName].query().select(fields).limit(1000000).toArray();
    return results;
  } catch (e) {
    console.error(`Error getting indexed items from ${tableName}:`, e.message);
    return [];
  }
}

// ============================================================================
// DISCREPANCY DETECTION
// ============================================================================

/**
 * Find items in source but not in index
 * @param {Set} sourceIds - IDs from source data
 * @param {Set} indexedIds - IDs from index
 * @returns {Array<string>} Array of missing IDs
 */
export function findMissing(sourceIds, indexedIds) {
  const missing = [];
  for (const id of sourceIds) {
    if (!indexedIds.has(id)) {
      missing.push(id);
    }
  }
  return missing;
}

/**
 * Find items in index but deleted from source (orphaned)
 * @param {Set} indexedIds - IDs from index
 * @param {Function} sourceValidator - Function to check if source exists
 * @returns {Promise<Array<string>>} Array of orphaned IDs
 */
export async function findOrphaned(indexedIds, sourceValidator) {
  const orphaned = [];
  for (const id of indexedIds) {
    if (!await sourceValidator(id)) {
      orphaned.push(id);
    }
  }
  return orphaned;
}

/**
 * Find duplicate entries in index (same ID indexed multiple times)
 * @param {Array} indexedItems - All items from index
 * @param {string} keyField - Field to check for duplicates
 * @returns {Array<{id: string, count: number}>} Duplicates with counts
 */
export function findDuplicates(indexedItems, keyField) {
  const counts = new Map();

  for (const item of indexedItems) {
    const key = String(item[keyField]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const duplicates = [];
  for (const [id, count] of counts.entries()) {
    if (count > 1) {
      duplicates.push({ id, count });
    }
  }

  return duplicates;
}

// ============================================================================
// METADATA EXTRACTION
// ============================================================================

/**
 * Get email metadata for detailed reporting
 * @param {string} filePath - Path to .emlx file
 * @returns {object} Email metadata
 */
function getEmailMetadata(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { subject: "Unknown", from: "Unknown", date: "Unknown", messageId: null, exists: false };
    }

    const rawContent = fs.readFileSync(filePath, "utf-8");

    // Handle Apple Mail envelope format: first line is byte count
    // Strip the preamble to get the actual RFC822 email content
    let content = rawContent;
    const lines = rawContent.split("\n");
    if (lines[0] && /^\d+\s*$/.test(lines[0])) {
      content = lines.slice(1).join("\n");
    }

    // Use regex-based extraction (same approach as indexer.js)
    // This handles folded headers, case-insensitivity, and optional whitespace
    const subjectMatch = content.match(/^Subject:\s*(.+)$/im);
    const fromMatch = content.match(/^From:\s*(.+)$/im);
    const dateMatch = content.match(/^Date:\s*(.+)$/im);
    const messageIdMatch = content.match(/^Message-ID:\s*(.+)$/im);

    return {
      subject: subjectMatch?.[1]?.trim() || "Unknown",
      from: fromMatch?.[1]?.trim() || "Unknown",
      date: dateMatch?.[1]?.trim() || "Unknown",
      messageId: messageIdMatch?.[1]?.trim() || null,
      exists: true
    };
  } catch (e) {
    return { subject: "Error", from: "Error", date: "Error", messageId: null, exists: false };
  }
}

/**
 * Get message metadata for detailed reporting
 * @param {string} messageId - Message ROWID
 * @returns {object} Message metadata
 */
function getMessageMetadata(messageId) {
  try {
    const query = `
      SELECT
        m.text,
        datetime(m.date/1000000000 + ${MAC_ABSOLUTE_EPOCH}, 'unixepoch', 'localtime') as date,
        CASE WHEN m.is_from_me = 1 THEN 'Me' ELSE coalesce(h.id, 'Unknown') END as sender
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE m.ROWID = ${messageId}
    `;

    const results = safeSqlite3Json(MESSAGES_DB, query);
    if (results.length > 0) {
      const msg = results[0];
      return {
        text: (msg.text || "").substring(0, 100),
        date: msg.date,
        sender: msg.sender
      };
    }
  } catch (e) {
    // Silent error
  }

  return { text: "Unknown", date: "Unknown", sender: "Unknown" };
}

/**
 * Get calendar event metadata for detailed reporting
 * @param {string} dbId - Database ID (just the ROWID, no timestamp)
 * @returns {object} Calendar event metadata
 */
function getCalendarMetadata(dbId) {
  try {
    const query = `
      SELECT
        summary as title,
        datetime(start_date + ${MAC_ABSOLUTE_EPOCH}, 'unixepoch', 'localtime') as start
      FROM CalendarItem
      WHERE ROWID = ${dbId}
    `;

    const results = safeSqlite3Json(CALENDAR_DB, query);
    if (results.length > 0) {
      return {
        title: results[0].title,
        start: results[0].start
      };
    }
  } catch (e) {
    // Silent error
  }

  return { title: "Unknown", start: "Unknown" };
}

// ============================================================================
// MAIN AUDIT FUNCTIONS
// ============================================================================

/**
 * Audit emails
 * @param {object} options - Audit options
 * @returns {Promise<object>} Audit results
 */
export async function auditEmails(options = {}) {
  const { maxItems = 100 } = options;

  console.error("Auditing emails...");

  // Phase 1: COUNT
  const sourceCount = countRawEmails();
  const sourceIds = getRawEmailIds();
  const indexedIds = await getIndexedIds("emails", "filePath");
  const indexedCount = indexedIds.size;

  // Phase 2: IDENTIFY
  const missing = findMissing(sourceIds, indexedIds);
  const orphaned = await findOrphaned(indexedIds, (id) => fs.existsSync(id));

  // Get all indexed items for duplicate detection and messageId mapping
  const indexedItems = await getIndexedItems("emails", ["filePath", "subject", "messageId"]);
  const duplicates = findDuplicates(indexedItems, "filePath");

  // Create messageId -> indexed items map for deduplication detection
  const indexedMessageIds = new Map();
  for (const item of indexedItems) {
    if (item.messageId) {
      if (!indexedMessageIds.has(item.messageId)) {
        indexedMessageIds.set(item.messageId, []);
      }
      indexedMessageIds.get(item.messageId).push(item);
    }
  }

  // Phase 3: PREPARE DETAILED ITEMS - Categorize missing items
  const missingDetailed = [];
  let deduplicatedCount = 0;

  for (const filePath of missing.slice(0, maxItems > 0 ? maxItems : missing.length)) {
    const metadata = getEmailMetadata(filePath);

    // Check if this missing file is a duplicate by messageId
    let reason = "Not indexed";
    let isDuplicate = false;

    if (metadata.messageId && indexedMessageIds.has(metadata.messageId)) {
      // This file has the same messageId as an indexed email
      const indexedDuplicates = indexedMessageIds.get(metadata.messageId);
      if (indexedDuplicates.length > 0) {
        reason = `Deduplicated (duplicate messageId - same as: ${indexedDuplicates[0].subject || "Unknown"})`;
        isDuplicate = true;
        deduplicatedCount++;
      }
    }

    missingDetailed.push({
      filePath,
      ...metadata,
      reason,
      isDuplicate
    });
  }

  // Count total deduplicates (for items not shown in detail)
  let totalDeduplicates = 0;
  for (const filePath of missing) {
    const metadata = getEmailMetadata(filePath);
    if (metadata.messageId && indexedMessageIds.has(metadata.messageId)) {
      totalDeduplicates++;
    }
  }
  const trulyMissingCount = missing.length - totalDeduplicates;

  const orphanedDetailed = orphaned.slice(0, maxItems > 0 ? maxItems : orphaned.length).map(filePath => {
    const indexedItem = indexedItems.find(item => item.filePath === filePath);
    return {
      filePath,
      subject: indexedItem?.subject || "Unknown",
      reason: "File no longer exists (deleted from Mail.app)"
    };
  });

  const duplicatesDetailed = duplicates.slice(0, maxItems > 0 ? maxItems : duplicates.length).map(dup => {
    const items = indexedItems.filter(item => item.filePath === dup.id);
    return {
      filePath: dup.id,
      count: dup.count,
      subject: items[0]?.subject || "Unknown"
    };
  });

  return {
    dataType: "emails",
    counts: {
      source: sourceCount,
      indexed: indexedCount,
      unique: indexedCount,
      coverage: sourceCount > 0 ? indexedCount / sourceCount : 0,
      notes: {
        totalSourceFiles: sourceCount,
        indexedUniqueEmails: indexedCount,
        deduplicatedFiles: totalDeduplicates,
        trulyMissingCount: trulyMissingCount,
        explanation: `${indexedCount} unique emails indexed from ${sourceCount} source files (${totalDeduplicates} duplicate messageIds correctly deduplicated, ${trulyMissingCount} truly missing)`
      }
    },
    discrepancies: {
      missing: missingDetailed,
      orphaned: orphanedDetailed,
      duplicates: duplicatesDetailed,
      missingCount: trulyMissingCount,
      deduplicatedCount: totalDeduplicates,
      orphanedCount: orphaned.length,
      duplicateCount: duplicates.length
    }
  };
}

/**
 * Audit messages
 * @param {object} options - Audit options
 * @returns {Promise<object>} Audit results
 */
export async function auditMessages(options = {}) {
  const { maxItems = 100 } = options;

  console.error("Auditing messages...");

  // Phase 1: COUNT
  const sourceCount = countRawMessages();
  const sourceIds = getRawMessageIds();
  const indexedIds = await getIndexedIds("messages", "id");
  const indexedCount = indexedIds.size;

  // Phase 2: IDENTIFY
  const missing = findMissing(sourceIds, indexedIds);

  // Messages don't have orphaned entries (database persists)
  const orphaned = [];

  // Get all indexed items for duplicate detection
  const indexedItems = await getIndexedItems("messages", ["id", "text", "sender"]);
  const duplicates = findDuplicates(indexedItems, "id");

  // Phase 3: PREPARE DETAILED ITEMS
  const missingDetailed = missing.slice(0, maxItems > 0 ? maxItems : missing.length).map(id => ({
    id,
    ...getMessageMetadata(id),
    reason: "Not indexed"
  }));

  const duplicatesDetailed = duplicates.slice(0, maxItems > 0 ? maxItems : duplicates.length).map(dup => {
    const items = indexedItems.filter(item => String(item.id) === dup.id);
    return {
      id: dup.id,
      count: dup.count,
      text: items[0]?.text?.substring(0, 100) || "Unknown",
      sender: items[0]?.sender || "Unknown"
    };
  });

  return {
    dataType: "messages",
    counts: {
      source: sourceCount,
      indexed: indexedCount,
      coverage: sourceCount > 0 ? indexedCount / sourceCount : 0
    },
    discrepancies: {
      missing: missingDetailed,
      orphaned: [],
      duplicates: duplicatesDetailed,
      missingCount: missing.length,
      orphanedCount: 0,
      duplicateCount: duplicates.length
    }
  };
}

/**
 * Audit calendar events
 * @param {object} options - Audit options
 * @returns {Promise<object>} Audit results
 */
export async function auditCalendar(options = {}) {
  const { maxItems = 100 } = options;

  console.error("Auditing calendar...");

  // Phase 1: COUNT
  const sourceCount = countRawCalendarEvents();
  const sourceIds = getRawCalendarIds();
  const indexedIds = await getIndexedIds("calendar", "id");
  const indexedCount = indexedIds.size;

  // Phase 2: IDENTIFY
  const missing = findMissing(sourceIds, indexedIds);
  const orphaned = findMissing(indexedIds, sourceIds); // Reverse check for stale entries

  // Get all indexed items for duplicate detection
  const indexedItems = await getIndexedItems("calendar", ["id", "title"]);
  const duplicates = findDuplicates(indexedItems, "id");

  // Phase 3: PREPARE DETAILED ITEMS
  const missingDetailed = missing.slice(0, maxItems > 0 ? maxItems : missing.length).map(id => ({
    id,
    ...getCalendarMetadata(id),
    reason: "Not indexed"
  }));

  const orphanedDetailed = orphaned.slice(0, maxItems > 0 ? maxItems : orphaned.length).map(id => {
    const indexedItem = indexedItems.find(item => item.id === id);
    return {
      id,
      title: indexedItem?.title || "Unknown",
      reason: "Event no longer exists in calendar"
    };
  });

  const duplicatesDetailed = duplicates.slice(0, maxItems > 0 ? maxItems : duplicates.length).map(dup => {
    const items = indexedItems.filter(item => item.id === dup.id);
    return {
      id: dup.id,
      count: dup.count,
      title: items[0]?.title || "Unknown"
    };
  });

  return {
    dataType: "calendar",
    counts: {
      source: sourceCount,
      indexed: indexedCount,
      coverage: sourceCount > 0 ? indexedCount / sourceCount : 0
    },
    discrepancies: {
      missing: missingDetailed,
      orphaned: orphanedDetailed,
      duplicates: duplicatesDetailed,
      missingCount: missing.length,
      orphanedCount: orphaned.length,
      duplicateCount: duplicates.length
    }
  };
}

/**
 * Audit all data sources
 * @param {object} options - Audit options
 * @returns {Promise<object>} Combined audit results
 */
export async function auditAll(options = {}) {
  const { sources = ["emails", "messages", "calendar"], maxItems = 100 } = options;

  const results = {};

  // Run audits in parallel for performance
  const promises = [];
  if (sources.includes("emails")) {
    promises.push(auditEmails({ maxItems }).then(r => ({ type: "emails", result: r })));
  }
  if (sources.includes("messages")) {
    promises.push(auditMessages({ maxItems }).then(r => ({ type: "messages", result: r })));
  }
  if (sources.includes("calendar")) {
    promises.push(auditCalendar({ maxItems }).then(r => ({ type: "calendar", result: r })));
  }

  const allResults = await Promise.all(promises);
  for (const { type, result } of allResults) {
    results[type] = result;
  }

  return results;
}

// ============================================================================
// REPORT FORMATTING
// ============================================================================

/**
 * Format audit results as verbose text report
 * @param {object} results - Audit results from auditAll()
 * @returns {string} Formatted report
 */
export function formatAuditReport(results) {
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);

  let report = "=== INDEX AUDIT REPORT ===\n";
  report += `Generated: ${timestamp}\n\n`;

  for (const [dataType, result] of Object.entries(results)) {
    const { counts, discrepancies } = result;
    const { source, indexed, coverage, notes } = counts;
    const { missing, orphaned, duplicates, missingCount, orphanedCount, duplicateCount, deduplicatedCount } = discrepancies;

    const isPerfect = missingCount === 0 && orphanedCount === 0 && duplicateCount === 0;
    const statusIcon = isPerfect ? "✓" : "✗";

    report += "━".repeat(60) + "\n";
    report += `${dataType.toUpperCase()}\n`;
    report += "━".repeat(60) + "\n\n";

    // For emails, show adjusted coverage that accounts for deduplication
    if (dataType === "emails" && notes && notes.deduplicatedFiles) {
      const uniqueExpected = source - notes.deduplicatedFiles;
      const uniqueCoverage = uniqueExpected > 0 ? Math.min(indexed / uniqueExpected, 1.0) : 1.0;
      const trulyMissingCount = Math.max(0, uniqueExpected - indexed);

      report += `${statusIcon} Files on disk: ${source.toLocaleString()}\n`;
      report += `   └─ Unique emails: ${uniqueExpected.toLocaleString()}\n`;
      report += `   └─ Duplicate files (same email, multiple folders): ${notes.deduplicatedFiles.toLocaleString()}\n`;
      report += `${statusIcon} Indexed: ${indexed.toLocaleString()} unique emails\n`;
      report += `${statusIcon} Unique Email Coverage: ${(uniqueCoverage * 100).toFixed(1)}%`;

      if (trulyMissingCount === 0 && orphanedCount === 0 && duplicateCount === 0) {
        report += " (Perfect!)";
      } else if (trulyMissingCount > 0 || orphanedCount > 0 || duplicateCount > 0) {
        const issues = [];
        if (trulyMissingCount > 0) issues.push(`${trulyMissingCount} missing`);
        if (orphanedCount > 0) issues.push(`${orphanedCount} orphaned`);
        if (duplicateCount > 0) issues.push(`${duplicateCount} duplicates`);
        report += ` (${issues.join(", ")})`;
      }
      report += "\n";
    } else {
      report += `${statusIcon} Source: ${source.toLocaleString()} ${dataType}\n`;
      report += `${statusIcon} Indexed: ${indexed.toLocaleString()} ${dataType}\n`;
      report += `${statusIcon} Coverage: ${(coverage * 100).toFixed(1)}%`;

      if (!isPerfect) {
        report += ` (${missingCount} missing, ${orphanedCount} orphaned, ${duplicateCount} duplicates)`;
      } else {
        report += " (Perfect!)";
      }
      report += "\n";
    }
    report += "\n";

    // Missing items
    if (missingCount > 0 || (dataType === "emails" && deduplicatedCount > 0)) {
      // Separate truly missing from deduplicated items
      const trulyMissing = missing.filter(item => !item.isDuplicate);
      const deduplicated = missing.filter(item => item.isDuplicate);

      if (trulyMissing.length > 0) {
        report += "─".repeat(60) + "\n";
        report += `MISSING ITEMS (${trulyMissing.length} truly missing)\n`;
        report += "─".repeat(60) + "\n\n";

        trulyMissing.forEach((item, index) => {
          report += `${index + 1}. `;
          if (dataType === "emails") {
            report += `${item.filePath}\n`;
            report += `   Subject: ${item.subject}\n`;
            report += `   From: ${item.from}\n`;
            report += `   Date: ${item.date}\n`;
          } else if (dataType === "messages") {
            report += `Message ID: ${item.id}\n`;
            report += `   Text: ${item.text}\n`;
            report += `   Sender: ${item.sender}\n`;
            report += `   Date: ${item.date}\n`;
          } else if (dataType === "calendar") {
            report += `Event ID: ${item.id}\n`;
            report += `   Title: ${item.title}\n`;
            report += `   Start: ${item.start}\n`;
          }
          report += `   Reason: ${item.reason}\n\n`;
        });
      }

      // Deduplicated items are not listed individually - count is shown in summary
    }

    // Orphaned items
    if (orphanedCount > 0) {
      report += "─".repeat(60) + "\n";
      report += `ORPHANED ITEMS (${orphanedCount} total)\n`;
      report += "─".repeat(60) + "\n\n";

      orphaned.forEach((item, index) => {
        report += `${index + 1}. `;
        if (dataType === "emails") {
          report += `${item.filePath}\n`;
          report += `   Subject: ${item.subject}\n`;
        } else if (dataType === "calendar") {
          report += `Event ID: ${item.id}\n`;
          report += `   Title: ${item.title}\n`;
        }
        report += `   Reason: ${item.reason}\n\n`;
      });
    }

    // Duplicates
    if (duplicateCount > 0) {
      report += "─".repeat(60) + "\n";
      report += `DUPLICATE ITEMS (${duplicateCount} total)\n`;
      report += "─".repeat(60) + "\n\n";

      duplicates.forEach((item, index) => {
        report += `${index + 1}. `;
        if (dataType === "emails") {
          report += `FilePath indexed ${item.count} times:\n`;
          report += `   ${item.filePath}\n`;
          report += `   Subject: ${item.subject}\n\n`;
        } else if (dataType === "messages") {
          report += `Message ID ${item.id} indexed ${item.count} times:\n`;
          report += `   Text: ${item.text}\n`;
          report += `   Sender: ${item.sender}\n\n`;
        } else if (dataType === "calendar") {
          report += `Event ID ${item.id} indexed ${item.count} times:\n`;
          report += `   Title: ${item.title}\n\n`;
        }
      });
    }
  }

  // Remediation suggestions
  report += "━".repeat(60) + "\n";
  report += "REMEDIATION SUGGESTIONS\n";
  report += "━".repeat(60) + "\n\n";

  const sourcesWithIssues = [];
  let totalDiscrepancies = 0;

  for (const [dataType, result] of Object.entries(results)) {
    const { discrepancies } = result;
    const count = discrepancies.missingCount + discrepancies.orphanedCount + discrepancies.duplicateCount;
    if (count > 0) {
      sourcesWithIssues.push(dataType);
      totalDiscrepancies += count;
    }
  }

  if (sourcesWithIssues.length > 0) {
    report += `1. Run rebuild_index with sources: ${JSON.stringify(sourcesWithIssues)}\n`;
    report += `2. Total items affected: ${totalDiscrepancies}\n`;
    report += `3. Estimated rebuild time: 3-10 minutes\n`;
    report += `4. Orphaned entries will be removed during rebuild\n`;
    report += `5. Duplicates indicate index corruption - rebuild recommended\n`;
  } else {
    report += "✓ No issues found! Index is in perfect sync with source data.\n";
  }

  // Summary Report
  report += "\n" + "━".repeat(60) + "\n";
  report += "SUMMARY REPORT\n";
  report += "━".repeat(60) + "\n\n";

  let totalSource = 0;
  let totalIndexed = 0;
  let totalMissing = 0;
  let totalOrphaned = 0;
  let totalDuplicates = 0;
  let totalDeduplicates = 0;

  for (const [dataType, result] of Object.entries(results)) {
    totalSource += result.counts.source;
    totalIndexed += result.counts.indexed;
    totalMissing += result.discrepancies.missingCount;
    totalOrphaned += result.discrepancies.orphanedCount;
    totalDuplicates += result.discrepancies.duplicateCount;
    totalDeduplicates += result.discrepancies.deduplicatedCount || 0;
  }

  // Calculate adjusted coverage (accounting for deduplication)
  const uniqueSource = totalSource - totalDeduplicates;
  const adjustedCoverage = uniqueSource > 0 ? Math.min(totalIndexed / uniqueSource, 1.0) : 1.0;
  const rawCoverage = totalSource > 0 ? (totalIndexed / totalSource) : 0;
  const totalIssues = totalMissing + totalOrphaned + totalDuplicates;
  const healthStatus = totalIssues === 0 ? "HEALTHY ✓" : totalIssues <= 10 ? "MINOR ISSUES ⚠" : "NEEDS ATTENTION ✗";

  report += `Data Sources Audited: ${Object.keys(results).length}\n`;
  report += `Total Files: ${totalSource.toLocaleString()}\n`;
  if (totalDeduplicates > 0) {
    report += `  └─ Unique items: ${uniqueSource.toLocaleString()}\n`;
    report += `  └─ Duplicate files: ${totalDeduplicates.toLocaleString()} (same email in multiple folders)\n`;
  }
  report += `Total Indexed: ${totalIndexed.toLocaleString()}\n`;
  report += `Unique Item Coverage: ${(adjustedCoverage * 100).toFixed(1)}%\n`;
  report += `Health Status: ${healthStatus}\n\n`;

  // Calculate truly missing (excluding deduplicated)
  let trulyMissingCount = 0;
  for (const result of Object.values(results)) {
    const trulyMissing = result.discrepancies.missing.filter(item => !item.isDuplicate);
    trulyMissingCount += trulyMissing.length;
  }
  const realIssues = trulyMissingCount + totalOrphaned + totalDuplicates;

  if (realIssues > 0 || totalDeduplicates > 0) {
    report += "Issue Breakdown:\n";
    if (trulyMissingCount > 0) {
      report += `  Truly Missing: ${trulyMissingCount.toLocaleString()} (${((trulyMissingCount/uniqueSource)*100).toFixed(2)}% of unique items)\n`;
    }
    if (totalDeduplicates > 0) {
      report += `  Deduplicated Files: ${totalDeduplicates.toLocaleString()} (same email in multiple folders - NORMAL)\n`;
    }
    if (totalOrphaned > 0) {
      report += `  Orphaned Items: ${totalOrphaned.toLocaleString()} (${((totalOrphaned/totalIndexed)*100).toFixed(2)}% of index)\n`;
    }
    if (totalDuplicates > 0) {
      report += `  Duplicate Items: ${totalDuplicates.toLocaleString()}\n`;
    }
    if (realIssues > 0) {
      report += `  Total Issues: ${realIssues.toLocaleString()}\n\n`;
    } else if (totalDeduplicates > 0) {
      report += `  (No issues - deduplication is expected behavior)\n\n`;
    }

    // Per-source breakdown
    report += "Per-Source Status:\n";
    for (const [dataType, result] of Object.entries(results)) {
      const { counts, discrepancies } = result;
      const sourceIssues = discrepancies.missingCount + discrepancies.orphanedCount + discrepancies.duplicateCount;
      const status = sourceIssues === 0 ? "✓" : "✗";

      // For emails, show adjusted coverage
      let coverage;
      if (dataType === "emails" && counts.notes && counts.notes.deduplicatedFiles) {
        const uniqueExpected = counts.source - counts.notes.deduplicatedFiles;
        coverage = uniqueExpected > 0 ? Math.min((counts.indexed / uniqueExpected) * 100, 100).toFixed(1) : "100.0";
      } else {
        coverage = (counts.coverage * 100).toFixed(1);
      }
      report += `  ${status} ${dataType}: ${coverage}% coverage (${sourceIssues} issues)\n`;
    }

    // Detailed discrepancy list
    report += "\n" + "─".repeat(60) + "\n";
    report += "ALL DISCREPANCIES (Detailed List)\n";
    report += "─".repeat(60) + "\n\n";

    // Collect all discrepancies from all sources
    let itemNumber = 1;

    // Missing items (excluding deduplicated emails which are shown separately)
    // Calculate truly missing count (excluding deduplicated emails)
    let trulyMissingTotal = 0;
    for (const [dataType, result] of Object.entries(results)) {
      const trulyMissing = result.discrepancies.missing.filter(item => !item.isDuplicate);
      trulyMissingTotal += trulyMissing.length;
    }

    if (trulyMissingTotal > 0) {
      report += `MISSING ITEMS (${trulyMissingTotal} truly missing):\n\n`;
      for (const [dataType, result] of Object.entries(results)) {
        const trulyMissing = result.discrepancies.missing.filter(item => !item.isDuplicate);
        if (trulyMissing.length > 0) {
          report += `  From ${dataType}:\n`;
          trulyMissing.forEach((item) => {
            report += `  ${itemNumber}. `;
            if (dataType === "emails") {
              report += `${item.filePath}\n`;
              report += `     Subject: ${item.subject}\n`;
              report += `     From: ${item.from}\n`;
              report += `     Date: ${item.date}\n`;
            } else if (dataType === "messages") {
              report += `Message ID: ${item.id}\n`;
              report += `     Text: ${item.text}\n`;
              report += `     Sender: ${item.sender}\n`;
              report += `     Date: ${item.date}\n`;
            } else if (dataType === "calendar") {
              report += `Event ID: ${item.id}\n`;
              report += `     Title: ${item.title}\n`;
              report += `     Start: ${item.start}\n`;
            }
            report += `     Reason: ${item.reason}\n\n`;
            itemNumber++;
          });
        }
      }
    }

    // Orphaned items
    if (totalOrphaned > 0) {
      report += `ORPHANED ITEMS (${totalOrphaned} total):\n\n`;
      itemNumber = 1;
      for (const [dataType, result] of Object.entries(results)) {
        if (result.discrepancies.orphaned.length > 0) {
          report += `  From ${dataType}:\n`;
          result.discrepancies.orphaned.forEach((item) => {
            report += `  ${itemNumber}. `;
            if (dataType === "emails") {
              report += `${item.filePath}\n`;
              report += `     Subject: ${item.subject}\n`;
            } else if (dataType === "messages") {
              report += `Message ID: ${item.id}\n`;
              report += `     Text: ${item.text}\n`;
            } else if (dataType === "calendar") {
              report += `Event ID: ${item.id}\n`;
              report += `     Title: ${item.title}\n`;
            }
            report += `     Reason: ${item.reason}\n\n`;
            itemNumber++;
          });
        }
      }
    }

    // Duplicate items
    if (totalDuplicates > 0) {
      report += `DUPLICATE ITEMS (${totalDuplicates} total):\n\n`;
      itemNumber = 1;
      for (const [dataType, result] of Object.entries(results)) {
        if (result.discrepancies.duplicates.length > 0) {
          report += `  From ${dataType}:\n`;
          result.discrepancies.duplicates.forEach((item) => {
            report += `  ${itemNumber}. `;
            if (dataType === "emails") {
              report += `FilePath indexed ${item.count} times:\n`;
              report += `     ${item.filePath}\n`;
              report += `     Subject: ${item.subject}\n\n`;
            } else if (dataType === "messages") {
              report += `Message ID ${item.id} indexed ${item.count} times:\n`;
              report += `     Text: ${item.text}\n`;
              report += `     Sender: ${item.sender}\n\n`;
            } else if (dataType === "calendar") {
              report += `Event ID ${item.id} indexed ${item.count} times:\n`;
              report += `     Title: ${item.title}\n\n`;
            }
            itemNumber++;
          });
        }
      }
    }
  } else {
    report += "✓ Perfect index health - all source data is correctly indexed\n";
    report += "✓ No missing items\n";
    report += "✓ No orphaned entries\n";
    report += "✓ No duplicate entries\n";
  }

  report += "\n" + "=".repeat(60) + "\n";
  report += "END OF AUDIT REPORT\n";
  report += "=".repeat(60) + "\n";

  return report;
}
