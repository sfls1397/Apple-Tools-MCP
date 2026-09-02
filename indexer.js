import fs from "fs";
import path from "path";
import * as lancedb from "@lancedb/lancedb";
import { pipeline } from "@xenova/transformers";
import {
  validateEmailPath,
  validateMailboxName,
  escapeAppleScript,
  validateLimit,
  validateLanceDBId,
  escapeSQL,
  stripHtmlTags
} from "./lib/validators.js";
import { safeSqlite3Json, safeOsascript, safeFind } from "./lib/shell.js";

// Re-export contact functions for use by other modules
export {
  loadContacts,
  resolveEmail,
  resolvePhone,
  resolveByName,
  lookupContact,
  searchContacts,
  getContactIdentifiers,
  formatContact,
  getContactStats
} from "./contacts.js";

// Support env var overrides for testing with separate index
export const INDEX_DIR = process.env.APPLE_TOOLS_INDEX_DIR ||
  path.join(process.env.HOME, ".apple-tools-mcp", "vector-index");
const META_FILE = process.env.APPLE_TOOLS_META_FILE ||
  path.join(process.env.HOME, ".apple-tools-mcp", "index-meta.json");
// Optional date filter for email indexing. Default is unlimited (index all emails).
// Set APPLE_TOOLS_INDEX_DAYS_BACK=30 to cap the window (tests do this).
// Set APPLE_TOOLS_INDEX_DAYS_BACK=0 to explicitly disable filtering.
const DAYS_BACK = process.env.APPLE_TOOLS_INDEX_DAYS_BACK !== undefined
  ? parseInt(process.env.APPLE_TOOLS_INDEX_DAYS_BACK, 10) || null  // 0 means null (no filter)
  : null;  // Default: no date filter
const MAIL_DIR = path.join(process.env.HOME, "Library", "Mail");

// Load/save index metadata (timestamps, etc.)
function loadIndexMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      return JSON.parse(fs.readFileSync(META_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveIndexMeta(meta) {
  const dir = path.dirname(META_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}
const MESSAGES_DB = path.join(process.env.HOME, "Library", "Messages", "chat.db");
const CALENDAR_DB = path.join(process.env.HOME, "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");
const BATCH_SIZE = 64; // Optimized for batch embedding throughput (increased for faster indexing)
const BATCH_DELAY_MS = 0; // No delay needed - benchmarks showed no thermal throttling

// Mac Absolute Time epoch: Jan 1, 2001 00:00:00 UTC
const MAC_ABSOLUTE_EPOCH = 978307200;
export const CALENDAR_TMP_PREFIX = "apple-tools-cal-";

let embeddingPipeline = null;
let db = null;
let tables = {};

async function getEmbedder() {
  if (!embeddingPipeline) {
    console.error("Loading embedding model (first time may take a minute)...");
    embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    console.error("Embedding model loaded.");
  }
  return embeddingPipeline;
}

export async function embed(text) {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(result.data);
}

// True batch embedding - single forward pass for multiple texts
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2 dimension

// Timeout wrapper for promises
function withTimeout(promise, timeoutMs, operation = "Operation") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise
  ]);
}

export async function embedBatch(texts) {
  if (texts.length === 0) return [];

  const embedder = await getEmbedder();

  // Add timeout protection: 30 seconds per batch
  // This prevents the process from hanging if embedding gets stuck
  const EMBEDDING_TIMEOUT_MS = 30000;

  try {
    // Process all texts in a single forward pass
    const result = await withTimeout(
      embedder(texts, { pooling: "mean", normalize: true }),
      EMBEDDING_TIMEOUT_MS,
      "Batch embedding"
    );

    // Result.data is a flat Float32Array of shape [batch_size * embedding_dim]
    const embeddings = [];
    for (let i = 0; i < texts.length; i++) {
      const start = i * EMBEDDING_DIM;
      const end = start + EMBEDDING_DIM;
      embeddings.push(Array.from(result.data.slice(start, end)));
    }
    return embeddings;
  } catch (error) {
    if (error.message.includes("timed out")) {
      console.error(`⚠️  Embedding batch timed out (${texts.length} texts). Retrying with smaller batches...`);
      // Fall back to processing one at a time with timeouts
      const embeddings = [];
      for (const text of texts) {
        try {
          const emb = await withTimeout(embed(text), 10000, "Single embedding");
          embeddings.push(emb);
        } catch (e) {
          console.error(`Failed to embed text: ${e.message}`);
          // Return zero vector as fallback
          embeddings.push(new Array(EMBEDDING_DIM).fill(0));
        }
      }
      return embeddings;
    }
    throw error;
  }
}

// ============ UTILITY FUNCTIONS ============

// Extract email address from "Name <email>" format
function extractEmail(str) {
  if (!str) return "";
  const match = str.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  // If no angle brackets, check if it looks like an email
  if (str.includes("@")) return str.trim().toLowerCase();
  return ""; // Return empty string if no email found
}

// Extract all email addresses from a string (handles multiple recipients)
function extractEmails(str) {
  if (!str) return [];
  const emails = [];
  // Split by comma and process each
  for (const part of str.split(",")) {
    const email = extractEmail(part.trim());
    if (email && email.includes("@")) {
      emails.push(email);
    }
  }
  return emails;
}

// Parse date string to timestamp
function parseDateTime(dateStr) {
  if (!dateStr) return 0;
  try {
    // Try direct parsing
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getTime();

    // Handle AppleScript format: "Friday, January 10, 2025 at 9:00:00 AM"
    const appleMatch = dateStr.match(/(\w+), (\w+ \d+, \d+) at (\d+:\d+:\d+ [AP]M)/i);
    if (appleMatch) {
      d = new Date(`${appleMatch[2]} ${appleMatch[3]}`);
      if (!isNaN(d.getTime())) return d.getTime();
    }

    return 0;
  } catch {
    return 0;
  }
}

// ============ EMAIL INDEXING ============

// Extract mailbox name from file path (e.g., "INBOX.mbox" -> "INBOX")
function extractMailbox(filePath) {
  const match = filePath.match(/([^/]+)\.mbox/);
  return match ? match[1] : "Unknown";
}

// Mailbox priority for deduplication - lower number = higher priority
// When the same email exists in multiple folders (IMAP behavior), we prefer
// to index the copy from higher-priority folders so mailbox searches work correctly
const MAILBOX_PRIORITY = {
  // Highest priority - user's primary mailboxes
  "INBOX": 1,
  "Sent": 2,
  "Sent Messages": 2,
  "Sent Mail": 2,
  "Drafts": 3,
  "Flagged": 4,

  // Medium priority - organizational folders
  "Archive": 5,
  "Archives": 5,

  // Low priority - catch-all folders
  "All Mail": 90,
  "[Gmail]": 90,

  // Lowest priority - folders users rarely search intentionally
  "Junk": 95,
  "Spam": 95,
  "Junk E-mail": 95,
  "Trash": 99,
  "Deleted Messages": 99,
  "Deleted Items": 99,
  "Bin": 99
};

// Get priority for a mailbox (lower = higher priority)
// Unknown/custom folders get priority 50 (between Archive and All Mail)
function getMailboxPriority(filePath) {
  const mailbox = extractMailbox(filePath);
  return MAILBOX_PRIORITY[mailbox] ?? 50;
}

function parseEmlx(filePath) {
  try {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const isPartial = filePath.endsWith(".partial.emlx");

    // Handle Apple Mail envelope format: first line is byte count, followed by newline
    // Strip the preamble to get the actual RFC822 email content
    let content = rawContent;
    const lines = rawContent.split("\n");
    if (lines[0] && /^\d+\s*$/.test(lines[0])) {
      // First line is a number (byte count) with optional whitespace, skip it
      content = lines.slice(1).join("\n");
    }

    // Extract headers
    const fromMatch = content.match(/^From:\s*(.+)$/m);
    const subjectMatch = content.match(/^Subject:\s*(.+)$/m);
    const dateMatch = content.match(/^Date:\s*(.+)$/m);
    const toMatch = content.match(/^To:\s*(.+)$/m);
    const ccMatch = content.match(/^Cc:\s*(.+)$/m);
    const messageIdMatch = content.match(/^Message-ID:\s*(.+)$/im);
    const flaggedMatch = content.match(/^X-Flagged:\s*(.+)$/im) || content.match(/flags.*flagged/i);

    // Check for attachments
    const hasAttachment = /Content-Disposition:\s*attachment/i.test(content) ||
                          /multipart\/mixed/i.test(content) ||
                          /filename=/i.test(content);

    // Extract body
    const headerEnd = content.search(/\r?\n\r?\n/);
    let body = "";
    if (headerEnd > 0) {
      body = content.substring(headerEnd + 2, Math.min(headerEnd + 2000, content.length));
      // Use safe HTML stripping to prevent ReDoS
      body = stripHtmlTags(body);
    }

    const fromRaw = fromMatch?.[1]?.trim() || "";
    const toRaw = toMatch?.[1]?.trim() || "";
    const ccRaw = ccMatch?.[1]?.trim() || "";
    const subject = subjectMatch?.[1]?.trim() || "";
    const date = dateMatch?.[1]?.trim() || "";

    // Extract normalized email addresses
    const fromEmail = extractEmail(fromRaw);
    const toEmails = extractEmails(toRaw);
    const ccEmails = extractEmails(ccRaw);
    const allRecipients = [...toEmails, ...ccEmails];

    // Parse date to timestamp
    const dateTimestamp = parseDateTime(date);

    // Determine mailbox and if sent
    const mailbox = extractMailbox(filePath);
    const isSent = mailbox.toLowerCase().includes("sent");
    const isFlagged = !!flaggedMatch;

    const searchText = `From: ${fromRaw}\nTo: ${toRaw}\nSubject: ${subject}\n${body}`.substring(0, 1000);
    const messageId = messageIdMatch?.[1]?.trim() || "";

    // For partial emails, allow indexing even with minimal data
    // Partial emails may lack complete headers but should still be indexed
    const hasMinimalContent = subject.length > 0 || fromRaw.length > 0 || searchText.length > 10;

    if (!hasMinimalContent && isPartial) {
      console.error(`[PARTIAL] Skipping ${filePath}: insufficient content (subject: ${subject.length}, from: ${fromRaw.length}, searchText: ${searchText.length})`);
      return null;
    }

    return {
      from: fromRaw,
      fromEmail,
      to: toRaw,
      toEmails: allRecipients.join(","),
      subject,
      date,
      dateTimestamp,
      hasAttachment,
      mailbox,
      isSent,
      isFlagged,
      messageId,
      body: body.substring(0, 500),
      searchText,
      filePath
    };
  } catch (e) {
    const fileName = filePath.split("/").pop();
    const isPartial = filePath.endsWith(".partial.emlx");
    console.error(`[PARSE_ERROR] ${isPartial ? "PARTIAL" : "COMPLETE"} ${fileName}: ${e.message}`);
    return null;
  }
}

// Full scan - used for first run and rebuild_index
// Includes both .emlx and .partial.emlx files (partial = not fully downloaded via IMAP)
async function findAllEmlxFiles() {
  try {
    // "*.emlx" also matches "*.partial.emlx"
    return safeFind(MAIL_DIR, { name: "*.emlx", type: "f" });
  } catch (e) {
    console.error("Error finding emlx files:", e.message);
    return [];
  }
}

// Fast incremental scan - uses find with -mtime filter (more reliable than mdfind/Spotlight)
async function findNewEmlxFiles(sinceTimestamp) {
  if (!sinceTimestamp) {
    // First run - fall back to full scan
    console.error("No previous index timestamp, doing full scan...");
    return findAllEmlxFiles();
  }

  try {
    // Convert timestamp to days ago for -mtime filter
    // -mtime -N means modified in the last N days
    const daysAgo = Math.ceil((Date.now() - sinceTimestamp) / (24 * 60 * 60 * 1000));

    // Use find with -mtime instead of mdfind for reliability
    // find is more reliable than Spotlight which can have stale/incomplete indexes
    const files = safeFind(MAIL_DIR, { name: "*.emlx", type: "f", mtime: `-${daysAgo}` });
    console.error(`find found ${files.length} new/modified emails in last ${daysAgo} days`);
    return files;
  } catch (e) {
    console.error("find failed, falling back to full scan:", e.message);
    return findAllEmlxFiles();
  }
}

// ============ MESSAGES INDEXING ============

/**
 * Extract text from NSAttributedString BLOB (attributedBody field)
 * macOS stores message text in attributedBody as NSKeyedArchiver format
 * The text is embedded as UTF-8 after the NSString class marker
 */
/**
 * Validate extracted text to ensure it's not garbage
 */
function validateExtractedText(text) {
  if (!text || typeof text !== 'string') return false;
  text = text.trim();
  if (text.length < 1 || text.length > 10000) return false;

  // Must be mostly printable characters
  const printableRatio = (text.match(/[\x20-\x7E\u00A0-\uFFFF]/g) || []).length / text.length;
  return printableRatio >= 0.8;
}

/**
 * Strategy 1: Current NSString+'+' pattern (backward compatibility)
 */
function extractStrategy1_CurrentPattern(buf) {
  const nsStringMarker = Buffer.from('NSString');
  let markerIndex = buf.indexOf(nsStringMarker);
  if (markerIndex === -1) return null;

  const searchStart = markerIndex + nsStringMarker.length;
  const plusIndex = buf.indexOf(0x2B, searchStart); // '+' character
  if (plusIndex === -1 || plusIndex >= buf.length - 2) return null;

  const lengthByte = buf[plusIndex + 1];
  const textStart = plusIndex + 2;
  if (lengthByte === 0 || textStart >= buf.length) return null;

  let textLength = lengthByte;
  let actualTextStart = textStart;

  if (lengthByte & 0x80) {
    actualTextStart = textStart;
    textLength = Math.min(500, buf.length - actualTextStart);
  }

  const textEnd = Math.min(actualTextStart + textLength, buf.length);
  let text = buf.slice(actualTextStart, textEnd).toString('utf-8');

  const cleanEnd = text.search(/[\x00-\x08\x0B\x0C\x0E-\x1F]|(\x84\x84)/);
  if (cleanEnd > 0) {
    text = text.substring(0, cleanEnd);
  }

  return text.trim();
}

/**
 * Strategy 2: Direct UTF-8 scanning - find longest printable sequence
 */
function extractStrategy2_DirectUTF8Scan(buf) {
  const fullText = buf.toString('utf-8');
  // Find sequences of printable characters at least 20 chars long
  const regex = /[\x20-\x7E\u00A0-\uFFFF]{20,}/g;
  const matches = fullText.match(regex);

  if (!matches || matches.length === 0) return null;

  // Return longest match
  return matches.reduce((a, b) => a.length > b.length ? a : b).trim();
}

/**
 * Strategy 3: NSKeyedArchiver $objects parser - handles modern macOS format
 */
function extractStrategy3_NSKeyedArchiver(buf) {
  const objectsMarker = Buffer.from('$objects');
  const objectsIndex = buf.indexOf(objectsMarker);
  if (objectsIndex === -1) return null;

  const searchStart = objectsIndex + objectsMarker.length;
  const nsStringMarker = Buffer.from('NSString');
  const extractedTexts = [];

  let currentPos = searchStart;
  while (currentPos < buf.length - 100) {
    const nsIdx = buf.indexOf(nsStringMarker, currentPos);
    if (nsIdx === -1) break;

    // Try to extract text after this NSString marker
    const textStart = nsIdx + nsStringMarker.length + 10; // Skip class definition
    const potentialText = buf.slice(textStart, Math.min(textStart + 500, buf.length))
                             .toString('utf-8');

    const cleanEnd = potentialText.search(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    if (cleanEnd > 5) {
      const extracted = potentialText.substring(0, cleanEnd).trim();
      if (extracted.length > 10) {
        extractedTexts.push(extracted);
      }
    }

    currentPos = nsIdx + 20;
  }

  if (extractedTexts.length === 0) return null;
  // Return longest extracted text
  return extractedTexts.reduce((a, b) => a.length > b.length ? a : b);
}

/**
 * Strategy 4: Regex-based pattern matching for common message structures
 */
function extractStrategy4_RegexBased(buf) {
  const text = buf.toString('utf-8', 0, Math.min(buf.length, 2000));

  // Common patterns in messages
  const patterns = [
    /(?:wrote|said):\s*\n?\s*(.{20,})/i,  // Reply pattern
    /"(.{20,})"/,                          // Quoted text
    /\n\s*([A-Z].{20,})\s*\n/,            // Paragraph pattern
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const extracted = match[1].trim();
      // Clean up control characters
      const cleanEnd = extracted.search(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
      if (cleanEnd > 20) {
        return extracted.substring(0, cleanEnd).trim();
      } else if (cleanEnd === -1 && extracted.length > 20) {
        return extracted;
      }
    }
  }

  return null;
}

/**
 * Multi-strategy attributedBody text extraction
 * Tries multiple approaches to extract text from binary NSAttributedString format
 */
function extractTextFromAttributedBody(buffer) {
  if (!buffer || buffer.length === 0) return null;

  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    // Try multiple strategies in order
    const strategies = [
      extractStrategy1_CurrentPattern,    // Keep for backward compatibility
      extractStrategy2_DirectUTF8Scan,    // Fast, works on most formats
      extractStrategy3_NSKeyedArchiver,   // Modern macOS NSAttributedString
      extractStrategy4_RegexBased         // Pattern-based extraction
    ];

    for (const strategy of strategies) {
      try {
        const text = strategy(buf);
        if (text && validateExtractedText(text)) {
          return text;
        }
      } catch (e) {
        // Try next strategy
        continue;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

function getMessages(sinceTimestamp = null) {
  try {
    // Enhanced query to get chat info, group chat detection, and attachments
    // Include attributedBody for messages where text is NULL (newer macOS format)
    // sinceTimestamp is Unix ms - convert to Mac Absolute Time nanoseconds
    let dateFilter = '';

    // NOTE: Index ALL messages without any date filtering
    // Only emails use the DAYS_BACK filter - messages and calendar are comprehensive

    if (sinceTimestamp) {
      const macAbsoluteNs = (sinceTimestamp / 1000 - MAC_ABSOLUTE_EPOCH) * 1000000000;
      dateFilter = `AND m.date >= ${macAbsoluteNs}`;
    }

    const query = `
      SELECT
        m.ROWID as id,
        datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as date,
        m.date/1000000000 + 978307200 as dateTimestamp,
        CASE WHEN m.is_from_me = 1 THEN 'Me' ELSE coalesce(h.id, 'Unknown') END as sender,
        m.text,
        CASE WHEN m.text IS NULL OR m.text = '' THEN hex(m.attributedBody) ELSE NULL END as attributedBodyHex,
        c.ROWID as chatId,
        c.chat_identifier as chatIdentifier,
        c.display_name as chatName,
        (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID) as participantCount,
        (SELECT COUNT(*) FROM message_attachment_join WHERE message_id = m.ROWID) as attachmentCount
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
      LEFT JOIN chat c ON cmj.chat_id = c.ROWID
      WHERE ((m.text IS NOT NULL AND m.text <> '') OR m.attributedBody IS NOT NULL)
        ${dateFilter}
      ORDER BY m.date DESC
    `;
    const results = safeSqlite3Json(MESSAGES_DB, query, { timeout: 60000 });

    // Post-process: extract text from attributedBody where text is NULL
    let extractedCount = 0;
    for (const msg of results) {
      if ((!msg.text || msg.text === '') && msg.attributedBodyHex) {
        try {
          const buffer = Buffer.from(msg.attributedBodyHex, 'hex');
          const extracted = extractTextFromAttributedBody(buffer);
          if (extracted) {
            msg.text = extracted;
            extractedCount++;
          }
        } catch (e) {
          // Skip this message if extraction fails
        }
      }
      // Clean up - don't keep the hex blob in memory
      delete msg.attributedBodyHex;
    }

    if (extractedCount > 0) {
      console.error(`Extracted text from attributedBody for ${extractedCount} messages`);
    }

    // Filter out messages that still have no text
    return results.filter(msg => msg.text && msg.text.trim() !== '');
  } catch (e) {
    console.error("Error reading messages:", e.message);
    return [];
  }
}

// ============ CALENDAR INDEXING ============

// Convert Mac Absolute Time to Unix timestamp (ms)
function macAbsoluteToUnixMs(macTime) {
  if (!macTime) return 0;
  return (macTime + MAC_ABSOLUTE_EPOCH) * 1000;
}

// Convert Unix timestamp (ms) to Mac Absolute Time
function unixMsToMacAbsolute(unixMs) {
  return (unixMs / 1000) - MAC_ABSOLUTE_EPOCH;
}

// Format date from Mac Absolute Time
function formatMacAbsoluteDate(macTime) {
  if (!macTime) return "";
  const date = new Date(macAbsoluteToUnixMs(macTime));
  return date.toLocaleString();
}

// Map participant status codes to human-readable strings
function getParticipantStatus(status) {
  const statusMap = {
    0: "unknown",
    1: "accepted",
    2: "declined",
    3: "tentative",
    4: "pending",
    7: "needs-action"
  };
  return statusMap[status] || "unknown";
}

function getCalendarEvents() {
  try {
    // NOTE: We index ALL calendar events, not filtered by date
    // Calendar events don't have a "file modification time" like emails do,
    // so we can't use the mdfind + DAYS_BACK approach.
    // Calendar indexing is always comprehensive - filtering by date would lose historical context.
    const now = Date.now();
    const pastDate = unixMsToMacAbsolute(now - 10 * 365 * 24 * 60 * 60 * 1000); // 10 years back
    const futureDate = unixMsToMacAbsolute(now + 10 * 365 * 24 * 60 * 60 * 1000); // 10 years ahead

    // Query OccurrenceCache for recurring events and their calculated occurrences
    // This includes both recurring and non-recurring events
    // GROUP BY to avoid duplicate entries for recurring events
    const query = `
      SELECT
        ci.ROWID as id,
        ci.summary,
        MIN(COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date)) as start_date,
        MAX(COALESCE(oc.occurrence_end_date, ci.end_date)) as end_date,
        ci.all_day,
        ci.description,
        c.title as calendar_name,
        l.title as location,
        COUNT(DISTINCT oc.day) as occurrenceCount
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      LEFT JOIN Location l ON ci.location_id = l.ROWID
      WHERE oc.day IS NOT NULL
        AND oc.day >= ${pastDate}
        AND oc.day <= ${futureDate}
      GROUP BY ci.ROWID
      ORDER BY MIN(oc.day) ASC
    `;

    const rows = safeSqlite3Json(CALENDAR_DB, query, { timeout: 30000 });

    // Get attendees for events that have them (separate query for efficiency)
    const attendeesQuery = `
      SELECT
        p.owner_id,
        COALESCE(i.display_name, p.email, 'Unknown') as name,
        p.status
      FROM Participant p
      LEFT JOIN Identity i ON p.identity_id = i.ROWID
      WHERE p.entity_type = 0
    `;

    let attendeesMap = new Map();
    try {
      const attendeesRows = safeSqlite3Json(CALENDAR_DB, attendeesQuery, { timeout: 10000 });

      // Group attendees by owner_id (event id)
      for (const att of attendeesRows) {
        if (!attendeesMap.has(att.owner_id)) {
          attendeesMap.set(att.owner_id, []);
        }
        attendeesMap.get(att.owner_id).push({
          name: att.name,
          status: getParticipantStatus(att.status)
        });
      }
    } catch (e) {
      console.error("Warning: Could not fetch attendees:", e.message);
    }

    const events = [];
    for (const row of rows) {
      if (!row.summary) continue;

      const startTimestamp = macAbsoluteToUnixMs(row.start_date);
      const attendees = attendeesMap.get(row.id) || [];

      events.push({
        dbId: row.id,  // Stable database ID for deduplication
        title: row.summary,
        start: formatMacAbsoluteDate(row.start_date),
        end: formatMacAbsoluteDate(row.end_date),
        calendar: row.calendar_name || "Unknown",
        location: row.location || "",
        notes: row.description || "",
        isAllDay: row.all_day === 1,
        startTimestamp,
        attendees: JSON.stringify(attendees),
        attendeeCount: attendees.length
      });
    }

    console.error(`Calendar: Retrieved ${events.length} events via SQLite (~${Math.round((Date.now() - now))}ms)`);
    return events;
  } catch (e) {
    console.error("Error reading calendar:", e.message);
    return [];
  }
}

// ============ DATABASE FUNCTIONS ============

export async function initDB() {
  if (db) return { db, tables };

  fs.mkdirSync(INDEX_DIR, { recursive: true });
  db = await lancedb.connect(INDEX_DIR);

  const tableNames = await db.tableNames();
  if (tableNames.includes("emails")) {
    tables.emails = await db.openTable("emails");
  }
  if (tableNames.includes("messages")) {
    tables.messages = await db.openTable("messages");
  }
  if (tableNames.includes("calendar")) {
    tables.calendar = await db.openTable("calendar");
  }

  return { db, tables };
}

export async function clearEmailsTable() {
  await initDB();
  if (tables.emails) {
    await db.dropTable("emails");
    tables.emails = null;
    console.error("Emails table dropped. Re-run indexing to rebuild.");
    return { cleared: true };
  }
  return { cleared: false, message: "No emails table exists" };
}

export async function clearMessagesTable() {
  await initDB();
  if (tables.messages) {
    await db.dropTable("messages");
    tables.messages = null;
    console.error("Messages table dropped. Re-run indexing to rebuild.");
    return { cleared: true };
  }
  return { cleared: false, message: "No messages table exists" };
}

export async function clearCalendarTable() {
  await initDB();
  if (tables.calendar) {
    await db.dropTable("calendar");
    tables.calendar = null;
    console.error("Calendar table dropped. Re-run indexing to rebuild.");
    return { cleared: true };
  }
  return { cleared: false, message: "No calendar table exists" };
}

export async function rebuildIndex(sources = ["emails", "messages", "calendar"], progressCallback = null) {
  const results = {
    cleared: {},
    indexed: {},
    errors: []
  };

  // Clear requested sources
  for (const source of sources) {
    try {
      if (source === "emails") {
        const clearResult = await clearEmailsTable();
        results.cleared.emails = clearResult.cleared;
      } else if (source === "messages") {
        const clearResult = await clearMessagesTable();
        results.cleared.messages = clearResult.cleared;
      } else if (source === "calendar") {
        const clearResult = await clearCalendarTable();
        results.cleared.calendar = clearResult.cleared;
      }
    } catch (e) {
      results.errors.push({ source, phase: "clear", error: e.message });
    }
  }

  // Reset module-level cache after dropping tables
  // This ensures that initDB() will re-initialize and pick up the newly created tables
  db = null;
  tables = {};

  // Re-index requested sources
  for (const source of sources) {
    try {
      if (source === "emails") {
        if (progressCallback) progressCallback("Indexing emails...");
        // Force full scan for rebuild (forceFullScan = true)
        const indexResult = await indexEmails(progressCallback, true);
        results.indexed.emails = indexResult;
      } else if (source === "messages") {
        if (progressCallback) progressCallback("Indexing messages...");
        // Force full scan for rebuild (forceFullScan = true)
        const indexResult = await indexMessages(true);
        results.indexed.messages = indexResult;
      } else if (source === "calendar") {
        if (progressCallback) progressCallback("Indexing calendar...");
        const indexResult = await indexCalendar();
        results.indexed.calendar = indexResult;
      }
    } catch (e) {
      results.errors.push({ source, phase: "index", error: e.message });
    }
  }

  return results;
}

async function getIndexedIds(tableName, idField) {
  await initDB();
  if (!tables[tableName]) return new Set();

  try {
    const results = await tables[tableName].query().select([idField]).toArray();
    return new Set(results.map(r => r[idField]));
  } catch (e) {
    // THROW instead of returning empty Set to prevent duplicate entries
    console.error(`Error getting indexed IDs from ${tableName}: ${e.message}`);
    throw new Error(`Failed to get indexed IDs from ${tableName}: ${e.message}`);
  }
}

/**
 * Get indexed IDs with retry logic to prevent race conditions
 * @param {string} tableName - Table name
 * @param {string} idField - ID field name
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<Set>} Set of indexed IDs
 */
async function getIndexedIdsWithRetry(tableName, idField, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await getIndexedIds(tableName, idField);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
        console.error(`Retry ${attempt}/${maxRetries} after ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}

// ============ INDEX ALL CONTENT ============

export async function indexEmails(progressCallback = null, forceFullScan = false) {
  await initDB();

  // Load last index timestamp for incremental scanning
  const meta = loadIndexMeta();
  // Use a 1-day buffer to catch any edge cases (files modified during previous scan, etc.)
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  // Determine the timestamp for mdfind filtering
  let lastEmailIndexTime;
  if (DAYS_BACK) {
    // DAYS_BACK is set - use it for mdfind filter (e.g., for testing or rebuild with constraints)
    lastEmailIndexTime = Date.now() - (DAYS_BACK * 24 * 60 * 60 * 1000);
    console.error(`\n=== EMAIL INDEXING (DAYS_BACK=${DAYS_BACK}) ===`);
    console.error(`Will search for emails modified since: ${new Date(lastEmailIndexTime).toISOString()}`);
  } else if (forceFullScan) {
    // Force full scan only when no DAYS_BACK constraint
    lastEmailIndexTime = null;
    console.error("\n=== EMAIL INDEXING (FULL SCAN) ===");
    console.error("Force full scan requested - finding all emails");
  } else if (meta.lastEmailIndexTime) {
    lastEmailIndexTime = meta.lastEmailIndexTime - ONE_DAY_MS;
    console.error(`\n=== EMAIL INDEXING (INCREMENTAL) ===`);
    console.error(`Searching for emails modified since: ${new Date(lastEmailIndexTime).toISOString()}`);
  } else {
    lastEmailIndexTime = null;
    console.error("\n=== EMAIL INDEXING (FIRST RUN - FULL SCAN) ===");
  }

  // Save the current time BEFORE we start - any emails arriving during indexing
  // will be picked up on the next incremental scan
  const indexStartTime = Date.now();

  // Use fast incremental scan if we have a previous timestamp
  const startTime = Date.now();
  console.error(`Calling findNewEmlxFiles with timestamp: ${lastEmailIndexTime ? new Date(lastEmailIndexTime).toISOString() : 'null (full scan)'}`);
  const newFiles = await findNewEmlxFiles(lastEmailIndexTime);
  console.error(`Found ${newFiles.length} new/modified email files (${Date.now() - startTime}ms)`);

  const indexedPaths = await getIndexedIdsWithRetry("emails", "filePath");
  const indexedMessageIds = await getIndexedIdsWithRetry("emails", "messageId");
  console.error(`Already indexed: ${indexedPaths.size} emails`);

  // Filter out already-indexed files
  let toIndex = newFiles.filter(f => !indexedPaths.has(f));
  console.error(`Need to index: ${toIndex.length} emails`);

  // Sort by mailbox priority so higher-priority folders are indexed first
  // This ensures INBOX copies are kept over Junk/Trash copies during deduplication
  toIndex.sort((a, b) => getMailboxPriority(a) - getMailboxPriority(b));

  if (toIndex.length === 0) {
    // Save timestamp for next incremental scan
    saveIndexMeta({ ...meta, lastEmailIndexTime: indexStartTime });
    return { indexed: indexedPaths.size, added: 0 };
  }

  let processed = 0;
  let skippedCount = { parseNull: 0, shortSearchText: 0, duplicateMessageId: 0 };

  // Progress tracking
  const totalBatches = Math.ceil(toIndex.length / BATCH_SIZE);
  const startProcessTime = Date.now();
  console.error(`\nProcessing ${toIndex.length} emails in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);

    // Parse all emails in batch first
    const parsedEmails = [];
    const searchTexts = [];

    for (const filePath of batch) {
      const parsed = parseEmlx(filePath);
      if (!parsed) {
        skippedCount.parseNull++;
        const fileName = filePath.split("/").pop();
        console.error(`[SKIPPED] Parse failed: ${fileName}`);
        continue;
      }
      if (parsed.searchText.length <= 20) {
        skippedCount.shortSearchText++;
        const fileName = filePath.split("/").pop();
        console.error(`[SKIPPED] Short searchText (${parsed.searchText.length} chars): ${fileName} - Subject: "${parsed.subject}"`);
        continue;
      }
      // Skip duplicate messageIds - same email in multiple folders (IMAP behavior)
      if (parsed.messageId && indexedMessageIds.has(parsed.messageId)) {
        skippedCount.duplicateMessageId++;
        continue; // Skip this duplicate
      }
      // NOTE: Don't filter by email header date - mdfind already filters by file modification time
      // The DAYS_BACK filter is applied at the mdfind level (finding recently modified files),
      // not at the email content level (email header dates can be old for recently modified messages)
      parsedEmails.push({ filePath, parsed });
      searchTexts.push(parsed.searchText);
    }

    // Generate all embeddings in a single batch call
    let vectors = [];
    if (searchTexts.length > 0) {
      try {
        vectors = await embedBatch(searchTexts);
      } catch (e) {
        console.error("Batch embedding error:", e.message);
        continue;
      }
    }

    // Build records with vectors
    const records = parsedEmails.map((item, idx) => ({
      filePath: item.filePath,
      from: item.parsed.from,
      fromEmail: item.parsed.fromEmail,
      to: item.parsed.to,
      toEmails: item.parsed.toEmails,
      subject: item.parsed.subject,
      date: item.parsed.date,
      dateTimestamp: item.parsed.dateTimestamp,
      hasAttachment: item.parsed.hasAttachment,
      mailbox: item.parsed.mailbox,
      isSent: item.parsed.isSent,
      isFlagged: item.parsed.isFlagged,
      messageId: item.parsed.messageId,
      body: item.parsed.body,
      vector: vectors[idx]
    })).filter(r => r.vector);  // Only records with vectors

    if (records.length > 0) {
      // Defensive duplicate check: remove any duplicates within the batch itself
      const uniqueRecords = [];
      const seenPaths = new Set();
      for (const record of records) {
        if (!seenPaths.has(record.filePath)) {
          seenPaths.add(record.filePath);
          uniqueRecords.push(record);
        }
      }

      if (uniqueRecords.length !== records.length) {
        const duplicatePaths = records
          .map(r => r.filePath)
          .filter((path, idx, arr) => arr.indexOf(path) !== idx);
        console.error(`WARNING: Removed ${records.length - uniqueRecords.length} duplicate(s) from batch. Paths: ${duplicatePaths.slice(0, 5).join(', ')}`);
        console.error(`This suggests findNewEmlxFiles() is returning duplicate paths. Investigate mdfind query.`);
      }

      if (uniqueRecords.length > 0) {
        if (!tables.emails) {
          tables.emails = await db.createTable("emails", uniqueRecords, { mode: "overwrite" });
        } else {
          // Double-check: verify these IDs truly aren't in the index
          const currentIndexed = await getIndexedIdsWithRetry("emails", "filePath");
          const trulyNew = uniqueRecords.filter(r => !currentIndexed.has(r.filePath));

          if (trulyNew.length < uniqueRecords.length) {
            console.error(`WARNING: ${uniqueRecords.length - trulyNew.length} records were already indexed. Filtering them out.`);
          }

          if (trulyNew.length > 0) {
            const beforeCount = await tables.emails.countRows();
            await tables.emails.add(trulyNew);
            const afterCount = await tables.emails.countRows();
            const actualAdded = afterCount - beforeCount;

            if (actualAdded !== trulyNew.length) {
              console.error(`WARNING: Expected to add ${trulyNew.length} records but index grew by ${actualAdded}. Possible duplicate issue.`);
            }

            // FIX: Update the messageId tracking Set with newly added records
            // This ensures subsequent batches can detect messageIds from previous batches
            for (const record of trulyNew) {
              if (record.messageId) {
                indexedMessageIds.add(record.messageId);
              }
            }
          }
        }
      }
    }

    processed += batch.length;

    // Calculate and display progress with time estimates
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    const elapsedMs = Date.now() - startProcessTime;
    const avgTimePerBatch = elapsedMs / currentBatch;
    const remainingBatches = totalBatches - currentBatch;
    const estimatedRemainingMs = avgTimePerBatch * remainingBatches;
    const estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 60000);

    console.error(`Batch ${currentBatch}/${totalBatches} complete | Processed: ${processed}/${toIndex.length} emails | Est. remaining: ${estimatedRemainingMin}m`);

    // Report progress after each batch
    if (progressCallback) {
      progressCallback(`emails-batch-${processed}/${toIndex.length}`);
    }

    // Throttle to prevent thermal crashes
    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Save timestamp for next incremental scan
  saveIndexMeta({ ...meta, lastEmailIndexTime: indexStartTime });

  // Log skip summary with timing
  const totalProcessingTime = Date.now() - startProcessTime;
  const totalSkipped = skippedCount.parseNull + skippedCount.shortSearchText + skippedCount.duplicateMessageId;
  console.error(`\nEmail indexing summary:`);
  console.error(`  Files to index: ${toIndex.length}`);
  console.error(`  Successfully indexed: ${processed}`);
  console.error(`  Skipped - parse errors: ${skippedCount.parseNull}`);
  console.error(`  Skipped - short searchText: ${skippedCount.shortSearchText}`);
  console.error(`  Skipped - duplicate messageId: ${skippedCount.duplicateMessageId}`);
  console.error(`  Total skipped: ${totalSkipped}`);
  console.error(`  Discrepancy: ${toIndex.length - processed - totalSkipped}`);
  console.error(`  Total time: ${Math.round(totalProcessingTime / 1000)}s (${Math.round(totalProcessingTime / 60000)}m)\n`);

  // Return actual indexed count from database, not stale cache
  const finalIndexedPaths = await getIndexedIdsWithRetry("emails", "filePath");
  return { indexed: finalIndexedPaths.size, added: processed };
}

export async function indexMessages(forceFullScan = false) {
  await initDB();

  // Load last index timestamp for incremental scanning
  const meta = loadIndexMeta();
  // Use a 1-hour buffer to catch any edge cases
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const lastMessageIndexTime = forceFullScan ? null :
    (meta.lastMessageIndexTime ? meta.lastMessageIndexTime - ONE_HOUR_MS : null);

  // Save the current time BEFORE we start
  const indexStartTime = Date.now();

  // Use incremental scan if we have a previous timestamp
  const messages = getMessages(lastMessageIndexTime);
  console.error(`Found ${messages.length} messages${lastMessageIndexTime ? ' (incremental)' : ' (full scan)'}`);

  const indexed = await getIndexedIdsWithRetry("messages", "id");
  console.error(`Already indexed: ${indexed.size} messages`);

  const toIndex = messages.filter(m => !indexed.has(String(m.id)));
  console.error(`Need to index: ${toIndex.length} messages`);

  if (toIndex.length === 0) {
    // Save timestamp for next incremental scan
    saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime });
    return { indexed: indexed.size, added: 0 };
  }

  let processed = 0;

  // Progress tracking
  const totalBatches = Math.ceil(toIndex.length / BATCH_SIZE);
  const startProcessTime = Date.now();
  console.error(`\nProcessing ${toIndex.length} messages in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);

    // Prepare all messages and search texts
    const preparedMsgs = [];
    const searchTexts = [];

    for (const msg of batch) {
      const searchText = `From: ${msg.sender}\nMessage: ${msg.text}`.substring(0, 500);
      if (searchText.length > 10) {
        preparedMsgs.push(msg);
        searchTexts.push(searchText);
      }
    }

    // Generate all embeddings in a single batch call
    let vectors = [];
    if (searchTexts.length > 0) {
      try {
        vectors = await embedBatch(searchTexts);
      } catch (e) {
        console.error("Batch embedding error:", e.message);
        continue;
      }
    }

    // Build records with vectors
    const records = preparedMsgs.map((msg, idx) => {
      // Explicitly cast to boolean to avoid LanceDB schema inference issues
      const isGroupChat = Boolean((parseInt(msg.participantCount) || 0) > 2 || (msg.chatName && msg.chatName.length > 0));
      const hasAttachment = Boolean((parseInt(msg.attachmentCount) || 0) > 0);
      return {
        id: String(msg.id),
        date: msg.date,
        dateTimestamp: msg.dateTimestamp || 0,
        sender: msg.sender,
        text: msg.text?.substring(0, 500) || "",
        chatId: String(msg.chatId || ""),
        chatIdentifier: msg.chatIdentifier || "",
        chatName: msg.chatName || "",
        isGroupChat,
        hasAttachment,
        vector: vectors[idx]
      };
    }).filter(r => r.vector);  // Only records with vectors

    if (records.length > 0) {
      // Defensive duplicate check: remove any duplicates within the batch itself
      const uniqueRecords = [];
      const seenIds = new Set();
      for (const record of records) {
        if (!seenIds.has(record.id)) {
          seenIds.add(record.id);
          uniqueRecords.push(record);
        }
      }

      if (uniqueRecords.length !== records.length) {
        const duplicateIds = records
          .map(r => r.id)
          .filter((id, idx, arr) => arr.indexOf(id) !== idx);
        console.error(`WARNING: Removed ${records.length - uniqueRecords.length} duplicate(s) from batch. IDs: ${duplicateIds.join(', ')}`);
        console.error(`This suggests getMessages() is returning duplicate rows. Investigate SQL query.`);
      }

      if (uniqueRecords.length > 0) {
        if (!tables.messages) {
          tables.messages = await db.createTable("messages", uniqueRecords, { mode: "overwrite" });
        } else {
          // Double-check: verify these IDs truly aren't in the index
          const currentIndexed = await getIndexedIdsWithRetry("messages", "id");
          const trulyNew = uniqueRecords.filter(r => !currentIndexed.has(r.id));

          if (trulyNew.length < uniqueRecords.length) {
            console.error(`WARNING: ${uniqueRecords.length - trulyNew.length} records were already indexed. Filtering them out.`);
          }

          if (trulyNew.length > 0) {
            const beforeCount = await tables.messages.countRows();
            await tables.messages.add(trulyNew);
            const afterCount = await tables.messages.countRows();
            const actualAdded = afterCount - beforeCount;

            if (actualAdded !== trulyNew.length) {
              console.error(`WARNING: Expected to add ${trulyNew.length} records but index grew by ${actualAdded}. Possible duplicate issue.`);
            }
          }
        }
      }
    }

    processed += batch.length;

    // Calculate and display progress with time estimates
    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    const elapsedMs = Date.now() - startProcessTime;
    const avgTimePerBatch = elapsedMs / currentBatch;
    const remainingBatches = totalBatches - currentBatch;
    const estimatedRemainingMs = avgTimePerBatch * remainingBatches;
    const estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 60000);

    console.error(`Batch ${currentBatch}/${totalBatches} complete | Processed: ${processed}/${toIndex.length} messages | Est. remaining: ${estimatedRemainingMin}m`);

    // Throttle to prevent thermal crashes
    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  // Save timestamp for next incremental scan
  saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime });

  return { indexed: indexed.size, added: processed };
}

export async function indexCalendar() {
  await initDB();

  const events = getCalendarEvents();
  console.error(`Found ${events.length} calendar events`);

  // Get already indexed event IDs for incremental indexing
  const indexed = await getIndexedIdsWithRetry("calendar", "id");
  console.error(`Already indexed: ${indexed.size} calendar events`);

  // Build set of current event IDs for stale detection
  // Use dbId only - must match the ID format used when storing events (line 1139)
  const currentIds = new Set(events.map(evt => `${evt.dbId}`));

  // Find and remove stale entries (indexed but no longer in calendar)
  const staleIds = [...indexed].filter(id => !currentIds.has(id));
  if (staleIds.length > 0 && tables.calendar) {
    console.error(`Removing ${staleIds.length} stale calendar entries...`);

    // Validate all IDs first
    const validIds = [];
    for (const staleId of staleIds) {
      const validatedId = validateLanceDBId(staleId);
      if (!validatedId) {
        console.error(`Skipping invalid stale ID: ${staleId.substring(0, 50)}...`);
        continue;
      }
      validIds.push(escapeSQL(validatedId));
    }

    // Batch delete in chunks of 100 to avoid query size limits
    const BATCH_DELETE_SIZE = 100;
    for (let i = 0; i < validIds.length; i += BATCH_DELETE_SIZE) {
      const batch = validIds.slice(i, i + BATCH_DELETE_SIZE);
      if (batch.length > 0) {
        try {
          // Use OR conditions for batch delete (LanceDB compatible)
          const conditions = batch.map(id => `id = '${id}'`).join(' OR ');
          await tables.calendar.delete(conditions);
        } catch (e) {
          console.error(`Failed to delete batch: ${e.message}`);
        }
      }
    }
  }

  // Prepare only NEW events and search texts
  const validEvents = [];
  const searchTexts = [];

  for (const evt of events) {
    const eventId = `${evt.dbId}`;  // Remove timestamp from ID to avoid duplicates
    // Skip if already indexed
    if (indexed.has(eventId)) continue;

    const searchText = `Event: ${evt.title}\nCalendar: ${evt.calendar}\nLocation: ${evt.location}\nNotes: ${evt.notes}`.substring(0, 500);
    if (searchText.length > 10) {
      validEvents.push({ ...evt, id: eventId });
      searchTexts.push(searchText);
    }
  }

  if (validEvents.length === 0) {
    console.error("No new calendar events to index");
    return { indexed: indexed.size, added: 0, removed: staleIds.length };
  }

  console.error(`Indexing ${validEvents.length} new calendar events...`);

  // Generate embeddings in batches
  const allVectors = [];
  for (let i = 0; i < searchTexts.length; i += BATCH_SIZE) {
    const batchTexts = searchTexts.slice(i, i + BATCH_SIZE);
    try {
      const batchVectors = await embedBatch(batchTexts);
      allVectors.push(...batchVectors);
    } catch (e) {
      console.error("Batch embedding error:", e.message);
    }
    console.error(`Embedded ${Math.min(i + BATCH_SIZE, searchTexts.length)}/${validEvents.length} new calendar events...`);
  }

  // Build records with vectors
  const records = validEvents.map((evt, idx) => ({
    id: evt.id,
    title: evt.title,
    start: evt.start,
    end: evt.end,
    startTimestamp: evt.startTimestamp,
    calendar: evt.calendar,
    location: evt.location,
    notes: evt.notes?.substring(0, 200) || "",
    isAllDay: evt.isAllDay,
    attendees: evt.attendees || "[]",
    attendeeCount: evt.attendeeCount || 0,
    vector: allVectors[idx]
  })).filter(r => r.vector); // Only include records with valid vectors

  if (records.length > 0) {
    // Defensive duplicate check: remove any duplicates within the batch itself
    const uniqueRecords = [];
    const seenIds = new Set();
    for (const record of records) {
      if (!seenIds.has(record.id)) {
        seenIds.add(record.id);
        uniqueRecords.push(record);
      }
    }

    if (uniqueRecords.length !== records.length) {
      console.error(`Removed ${records.length - uniqueRecords.length} duplicate(s) from batch`);
    }

    if (uniqueRecords.length > 0) {
      if (tables.calendar) {
        // Add to existing table
        await tables.calendar.add(uniqueRecords);
      } else {
        // Create new table
        tables.calendar = await db.createTable("calendar", uniqueRecords);
      }
      console.error(`Indexed ${uniqueRecords.length} new calendar events`);
    }
  }

  return { indexed: indexed.size, added: records.length, removed: staleIds.length };
}

export async function indexAll(progressCallback = null) {
  console.error("Starting full index...");

  if (progressCallback) progressCallback('emails-start');
  const emailResult = await indexEmails(progressCallback);
  if (progressCallback) progressCallback('emails-complete');

  if (progressCallback) progressCallback('messages-start');
  const messageResult = await indexMessages();
  if (progressCallback) progressCallback('messages-complete');

  if (progressCallback) progressCallback('calendar-start');
  const calendarResult = await indexCalendar();
  if (progressCallback) progressCallback('calendar-complete');

  console.error("Full index complete.");
  return { emails: emailResult, messages: messageResult, calendar: calendarResult };
}

export async function isIndexReady(type = "emails") {
  await initDB();
  return tables[type] !== null && tables[type] !== undefined;
}

// ============ DIRECT QUERIES (for recent items) ============

export async function getRecentEmails(limit = 10, daysBack = 7) {
  await initDB();
  if (!tables.emails) return [];

  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);

  try {
    // Fetch all and filter in JavaScript (LanceDB where clause with quoted columns is unreliable)
    const results = await tables.emails.query()
      .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "mailbox", "isSent", "isFlagged", "messageId", "body"])
      .toArray();

    // Filter by date, sort by timestamp descending, and limit
    return results
      .filter(r => r.dateTimestamp >= cutoff)
      .sort((a, b) => b.dateTimestamp - a.dateTimestamp)
      .slice(0, limit);
  } catch (e) {
    // Fallback with minimal columns for older indexes
    console.error("Using fallback query:", e.message);
    try {
      const results = await tables.emails.query()
        .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "body"])
        .toArray();
      return results
        .filter(r => r.dateTimestamp >= cutoff)
        .sort((a, b) => b.dateTimestamp - a.dateTimestamp)
        .slice(0, limit);
    } catch (e2) {
      console.error("Error getting recent emails:", e2.message);
      return [];
    }
  }
}

export async function getEmailsByDateRange(startTs, endTs) {
  await initDB();
  if (!tables.emails) return [];

  try {
    // LanceDB where clause with quoted column names doesn't work reliably
    // So we fetch all and filter in JavaScript
    const results = await tables.emails.query()
      .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "mailbox", "isSent", "isFlagged", "messageId", "body"])
      .toArray();

    // Filter by date range and sort by timestamp descending
    return results
      .filter(r => r.dateTimestamp >= startTs && r.dateTimestamp < endTs)
      .sort((a, b) => b.dateTimestamp - a.dateTimestamp);
  } catch (e) {
    // Fallback with minimal columns for older indexes
    console.error("Using fallback query for date range:", e.message);
    try {
      const results = await tables.emails.query()
        .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "body"])
        .toArray();
      return results
        .filter(r => r.dateTimestamp >= startTs && r.dateTimestamp < endTs)
        .sort((a, b) => b.dateTimestamp - a.dateTimestamp);
    } catch (e2) {
      console.error("Error getting emails by date range:", e2.message);
      return [];
    }
  }
}

export async function getRecentMessages(limit = 10, daysBack = 1) {
  await initDB();
  if (!tables.messages) return { messages: [], hasMore: false };

  try {
    const cutoff = Date.now() / 1000 - (daysBack * 24 * 60 * 60); // Messages use Unix timestamp
    const results = await tables.messages.query()
      .select(["id", "date", "dateTimestamp", "sender", "text", "chatId", "isGroupChat"])
      .toArray();

    const filtered = results
      .filter(r => r.dateTimestamp >= cutoff)
      .sort((a, b) => b.dateTimestamp - a.dateTimestamp);

    const hasMore = filtered.length > limit;
    const messages = filtered.slice(0, limit);
    return { messages, hasMore };
  } catch (e) {
    console.error("Error getting recent messages:", e.message);
    return { messages: [], hasMore: false };
  }
}

export async function getConversation(contact, limit = 50) {
  await initDB();
  if (!tables.messages) return [];

  try {
    const contactLower = contact.toLowerCase();
    const results = await tables.messages.query()
      .select(["id", "date", "dateTimestamp", "sender", "text", "chatId", "chatIdentifier"])
      .toArray();

    // Find messages where sender or chatIdentifier contains the contact
    const filtered = results.filter(r => {
      const sender = (r.sender || "").toLowerCase();
      const chatId = (r.chatIdentifier || "").toLowerCase();
      return sender.includes(contactLower) || chatId.includes(contactLower);
    });

    // Sort chronologically (oldest first for conversation view)
    return filtered
      .sort((a, b) => a.dateTimestamp - b.dateTimestamp)
      .slice(-limit); // Take last N messages
  } catch (e) {
    console.error("Error getting conversation:", e.message);
    return [];
  }
}

export async function getCalendarByDate(startTimestamp, endTimestamp) {
  await initDB();
  if (!tables.calendar) return [];

  try {
    const results = await tables.calendar.query()
      .select(["id", "title", "start", "end", "startTimestamp", "calendar", "location", "notes", "isAllDay"])
      .toArray();

    console.error(`[Calendar Query] Searching between ${new Date(startTimestamp).toISOString()} and ${new Date(endTimestamp).toISOString()}`);
    console.error(`[Calendar Query] Total events in index: ${results.length}`);

    const filtered = results.filter(r => r.startTimestamp >= startTimestamp && r.startTimestamp < endTimestamp);

    console.error(`[Calendar Query] Matched events: ${filtered.length}`);
    if (filtered.length === 0 && results.length > 0) {
      // Show events near the boundary for debugging
      const nearby = results.filter(r =>
        r.startTimestamp >= startTimestamp - 86400000 &&
        r.startTimestamp <= endTimestamp + 86400000
      );
      console.error(`[Calendar Query] Events within ±1 day: ${nearby.length}`);
      nearby.forEach(e => {
        console.error(`  - "${e.title}" at ${new Date(e.startTimestamp).toISOString()} (all-day: ${e.isAllDay})`);
      });
    }

    return filtered.sort((a, b) => a.startTimestamp - b.startTimestamp);
  } catch (e) {
    console.error("Error getting calendar by date:", e.message);
    return [];
  }
}

export async function getAllCalendarEvents() {
  await initDB();
  if (!tables.calendar) return [];

  try {
    const results = await tables.calendar.query()
      .select(["id", "title", "start", "end", "startTimestamp", "calendar", "location", "isAllDay"])
      .toArray();

    return results.sort((a, b) => a.startTimestamp - b.startTimestamp);
  } catch (e) {
    console.error("Error getting all calendar events:", e.message);
    return [];
  }
}

// ============ NEW TOOLS - PHASE 1 ============

// Mailboxes to exclude by default
const EXCLUDED_MAILBOXES = ['junk', 'trash', 'deleted messages', 'spam'];

// mail_senders: List most frequent email senders
export async function getFrequentSenders(limit = 30, daysBack = 0, includeJunk = false) {
  await initDB();
  if (!tables.emails) return [];

  try {
    let emails = await tables.emails.query().select(["fromEmail", "from", "dateTimestamp", "mailbox"]).toArray();
    if (daysBack > 0) {
      const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
      emails = emails.filter(e => e.dateTimestamp >= cutoff);
    }
    // Exclude junk/trash by default
    if (!includeJunk) {
      emails = emails.filter(e =>
        !EXCLUDED_MAILBOXES.some(mb =>
          (e.mailbox || "").toLowerCase().includes(mb)
        )
      );
    }
    const senderCounts = {};
    emails.forEach(e => {
      const key = e.fromEmail || e.from || "Unknown";
      senderCounts[key] = (senderCounts[key] || 0) + 1;
    });
    return Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([email, count]) => ({ email, messageCount: count }));
  } catch (e) {
    console.error("Error getting frequent senders:", e.message);
    return [];
  }
}

// messages_contacts: List all contacts you've messaged
export function getMessageContacts(limit = 50) {
  try {
    // Validate limit to prevent SQL issues
    const safeLimit = validateLimit(limit, 50, 500);

    const query = `
      SELECT
        h.id as contact,
        COUNT(m.ROWID) as messageCount,
        datetime(MAX(m.date)/1000000000 + 978307200, 'unixepoch', 'localtime') as lastMessageDate
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      WHERE h.id IS NOT NULL
      GROUP BY h.id
      ORDER BY MAX(m.date) DESC
      LIMIT ${safeLimit}
    `;
    return safeSqlite3Json(MESSAGES_DB, query, { timeout: 30000 });
  } catch (e) {
    console.error("Error getting message contacts:", e.message);
    return [];
  }
}

// calendar_upcoming: Get next N upcoming events
export function getUpcomingEvents(limit = 10) {
  try {
    // Validate limit to prevent SQL issues
    const safeLimit = validateLimit(limit, 10, 100);
    const nowMac = Math.floor(Date.now() / 1000) - 978307200;
    const fetchLimit = safeLimit + 1; // Fetch one extra to detect if more exist

    // Query OccurrenceCache to include recurring event occurrences
    const query = `
      SELECT
        ci.summary as title,
        datetime(COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date) + 978307200, 'unixepoch', 'localtime') as start,
        datetime(COALESCE(oc.occurrence_end_date, ci.end_date) + 978307200, 'unixepoch', 'localtime') as end,
        ci.all_day as isAllDay,
        c.title as calendar,
        l.title as location,
        oc.day as sort_day
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      LEFT JOIN Location l ON ci.location_id = l.ROWID
      WHERE oc.day >= ${nowMac} AND ci.summary IS NOT NULL AND ci.summary <> ''
      ORDER BY sort_day ASC
      LIMIT ${fetchLimit}
    `;
    const events = safeSqlite3Json(CALENDAR_DB, query, { timeout: 10000 });
    const hasMore = events.length > safeLimit;
    const limitedEvents = events.slice(0, safeLimit);
    return { events: limitedEvents, showing: limitedEvents.length, hasMore };
  } catch (e) {
    console.error("Error getting upcoming events:", e.message);
    return { events: [], showing: 0, hasMore: false };
  }
}

// Convert local-day unix ms bounds to Apple/Core Data seconds (unix - 978307200)
export function localDayToMacBounds(startMs, endMs) {
  const startMac = Math.floor(Number(startMs) / 1000) - MAC_ABSOLUTE_EPOCH;
  const endMac = Math.floor(Number(endMs) / 1000) - MAC_ABSOLUTE_EPOCH;
  if (!Number.isFinite(startMac) || !Number.isFinite(endMac)) {
    throw new Error("Invalid date bounds");
  }
  return { startMac, endMac };
}

// Date-bounded OccurrenceCache query: one row per occurrence, no GROUP BY ci.ROWID
export function buildEventsOnDateQuery(startMac, endMac) {
  const startBound = Math.floor(Number(startMac));
  const endBound = Math.floor(Number(endMac));
  if (!Number.isFinite(startBound) || !Number.isFinite(endBound)) {
    throw new Error("Invalid Mac Absolute Time bounds");
  }
  const timedStart = "COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date)";
  const occEnd = "COALESCE(oc.occurrence_end_date, ci.end_date)";
  // First local day = occurrence-end local date minus (durationDays - 1). Day math, not seconds (DST-safe).
  const allDayStartDate = `date(${occEnd} + 978307200, 'unixepoch', 'localtime', '-' || (CAST(round((ci.end_date - ci.start_date) / 86400.0) AS INTEGER) - 1) || ' days')`;
  const allDayStartMac = `CAST(strftime('%s', ${allDayStartDate} || ' 00:00:00', 'utc') AS INTEGER) - 978307200`;
  return `
      SELECT DISTINCT
        ci.ROWID as itemId,
        ci.summary as title,
        datetime(CASE WHEN ci.all_day THEN ${allDayStartMac} ELSE ${timedStart} END + 978307200, 'unixepoch', 'localtime') as start,
        datetime(${occEnd} + 978307200, 'unixepoch', 'localtime') as end,
        CASE WHEN ci.all_day THEN ${allDayStartMac} ELSE ${timedStart} END as startMac,
        ${occEnd} as endMac,
        ci.all_day as isAllDay,
        c.title as calendar,
        l.title as location
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      LEFT JOIN Location l ON ci.location_id = l.ROWID
      WHERE ci.summary IS NOT NULL AND ci.summary <> ''
        AND (c.title IS NULL OR c.title NOT IN ('Found in Mail', 'Found in Natural Language'))
        AND (
          (oc.day >= ${startBound} AND oc.day < ${endBound})
          OR (
            ci.all_day = 0
            AND ${timedStart} < ${startBound}
            AND ${occEnd} > ${startBound}
          )
        )
      ORDER BY startMac ASC, title ASC
    `;
}

// Copy Calendar.sqlitedb (+ wal/shm) to /tmp for one query, then delete the copies.
// Calendar.app holds a lock on the live db; sqlite can read a snapshot copy.
function withCalendarCopy(fn) {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDb = path.join("/tmp", `${CALENDAR_TMP_PREFIX}${id}.sqlitedb`);
  const tmpWal = `${tmpDb}-wal`;
  const tmpShm = `${tmpDb}-shm`;
  const srcWal = `${CALENDAR_DB}-wal`;
  const srcShm = `${CALENDAR_DB}-shm`;

  try {
    if (!fs.existsSync(CALENDAR_DB)) {
      throw new Error("Calendar database not found");
    }
    fs.copyFileSync(CALENDAR_DB, tmpDb);
    if (fs.existsSync(srcWal)) {
      fs.copyFileSync(srcWal, tmpWal);
    }
    if (fs.existsSync(srcShm)) {
      fs.copyFileSync(srcShm, tmpShm);
    }
    return fn(tmpDb);
  } finally {
    for (const file of [tmpDb, tmpWal, tmpShm]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone or never created
      }
    }
  }
}

// calendar_date: live OccurrenceCache for every occurrence on a local day
export function getEventsOnDate(startMs, endMs) {
  try {
    if (!fs.existsSync(CALENDAR_DB)) {
      return { events: [], error: "Calendar database not found" };
    }
    const { startMac, endMac } = localDayToMacBounds(startMs, endMs);
    const query = buildEventsOnDateQuery(startMac, endMac);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const events = withCalendarCopy((dbPath) => {
          return safeSqlite3Json(dbPath, query, { timeout: 15000 });
        });
        return { events, error: null };
      } catch (e) {
        lastError = e;
        console.error(`Error getting events on date (attempt ${attempt + 1}):`, e.message);
      }
    }
    return { events: [], error: lastError.message };
  } catch (e) {
    console.error("Error getting events on date:", e.message);
    return { events: [], error: e.message };
  }
}

// ============ NEW TOOLS - PHASE 2 ============

// mail_unread_count: Get count of unread emails via AppleScript
export function getUnreadCount(mailbox = null) {
  try {
    let script;

    if (mailbox) {
      // Validate mailbox name to prevent AppleScript injection
      const validatedMailbox = validateMailboxName(mailbox);
      if (!validatedMailbox) {
        return { unreadCount: 0, mailbox, error: "Invalid mailbox name. Only alphanumeric characters, spaces, hyphens, underscores, and periods are allowed." };
      }

      // Escape for AppleScript double-quoted string (belt and suspenders)
      const escapedMailbox = escapeAppleScript(validatedMailbox);

      script = `tell application "Mail"
           set unreadCount to 0
           repeat with acc in accounts
             try
               set mb to mailbox "${escapedMailbox}" of acc
               set unreadCount to unreadCount + (count of (messages of mb whose read status is false))
             end try
           end repeat
           return unreadCount
         end tell`;
    } else {
      script = `tell application "Mail"
           return unread count of inbox
         end tell`;
    }

    const result = safeOsascript(script, { timeout: 15000 });
    return { unreadCount: parseInt(result.trim()) || 0, mailbox: mailbox || "INBOX" };
  } catch (e) {
    console.error("Error getting unread count:", e.message);
    return { unreadCount: 0, mailbox: mailbox || "INBOX", error: e.message };
  }
}

// calendar_week: Get events for current or next week
export function getWeekEvents(weekOffset = 0) {
  try {
    const now = new Date();
    // Get Monday of the current week
    const monday = new Date(now);
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day; // If Sunday, go back 6 days; otherwise go to Monday
    monday.setDate(now.getDate() + diff + (weekOffset * 7));
    monday.setHours(0, 0, 0, 0);

    // Get Sunday end of week
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const startMac = Math.floor(monday.getTime() / 1000) - 978307200;
    const endMac = Math.floor(sunday.getTime() / 1000) - 978307200;

    // Query OccurrenceCache to include recurring event occurrences
    const query = `
      SELECT
        ci.summary as title,
        datetime(COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date) + 978307200, 'unixepoch', 'localtime') as start,
        datetime(COALESCE(oc.occurrence_end_date, ci.end_date) + 978307200, 'unixepoch', 'localtime') as end,
        ci.all_day as isAllDay,
        c.title as calendar,
        l.title as location
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      LEFT JOIN Location l ON ci.location_id = l.ROWID
      WHERE oc.day >= ${startMac} AND oc.day <= ${endMac}
        AND ci.summary IS NOT NULL AND ci.summary <> ''
      ORDER BY oc.day ASC
    `;
    const events = safeSqlite3Json(CALENDAR_DB, query, { timeout: 15000 });

    const weekStart = monday.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const weekEnd = sunday.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

    return {
      events,
      weekLabel: weekOffset === 0 ? "This Week" : weekOffset === 1 ? "Next Week" : `Week of ${weekStart}`,
      dateRange: `${weekStart} - ${weekEnd}`
    };
  } catch (e) {
    console.error("Error getting week events:", e.message);
    return { events: [], weekLabel: "Unknown", dateRange: "", error: e.message };
  }
}

// ============ NEW TOOLS - PHASE 3 ============

// mail_thread: Get email thread by searching for related emails
// Uses subject-based matching since Message-ID isn't indexed
export async function getEmailThread(filePath, limit = 20) {
  await initDB();
  if (!tables.emails) return { error: "Email index not ready", emails: [] };

  try {
    // Validate file path to prevent path traversal attacks
    let validatedPath;
    try {
      validatedPath = validateEmailPath(filePath, MAIL_DIR);
    } catch (e) {
      return { error: `Invalid file path: ${e.message}`, emails: [] };
    }

    // Verify file exists
    if (!fs.existsSync(validatedPath)) {
      return { error: "Email file not found", emails: [] };
    }

    // Read the email to get subject
    const content = fs.readFileSync(validatedPath, "utf-8");
    const subjectMatch = content.match(/^Subject:\s*(.+)$/m);
    if (!subjectMatch) {
      return { error: "Could not extract subject from email", emails: [] };
    }

    // Clean subject - remove Re:, Fwd:, etc.
    let subject = subjectMatch[1].trim();
    const baseSubject = subject.replace(/^(Re|Fwd|Fw):\s*/gi, "").trim();

    if (baseSubject.length < 5) {
      return { error: "Subject too short to find thread", emails: [] };
    }

    // Search for emails with similar subjects
    const allEmails = await tables.emails.query()
      .select(["filePath", "from", "to", "subject", "date", "dateTimestamp"])
      .toArray();

    // Filter to emails with matching base subject
    const threadEmails = allEmails
      .filter(e => {
        const eBaseSubject = (e.subject || "").replace(/^(Re|Fwd|Fw):\s*/gi, "").trim();
        return eBaseSubject.toLowerCase() === baseSubject.toLowerCase();
      })
      .sort((a, b) => a.dateTimestamp - b.dateTimestamp)
      .slice(0, limit);

    return {
      emails: threadEmails,
      baseSubject,
      threadCount: threadEmails.length
    };
  } catch (e) {
    console.error("Error getting email thread:", e.message);
    return { error: e.message, emails: [] };
  }
}

// calendar_recurring: Get recurring events (shows events with recurrence rules and their upcoming occurrences)
export function getRecurringEvents(limit = 20) {
  try {
    // Validate limit to prevent SQL issues
    const safeLimit = validateLimit(limit, 20, 100);
    const nowMac = Math.floor(Date.now() / 1000) - 978307200;
    const fetchLimit = safeLimit + 1; // Fetch one extra to detect if more exist

    // Query events that have recurrence rules defined in the Recurrence table
    // Show the next upcoming occurrence of each recurring event
    const query = `
      SELECT DISTINCT
        ci.summary as title,
        datetime(COALESCE(MIN(oc.occurrence_end_date) - (ci.end_date - ci.start_date), MIN(oc.day)) + 978307200, 'unixepoch', 'localtime') as start,
        c.title as calendar,
        ci.all_day as isAllDay,
        COUNT(DISTINCT oc.day) as occurrenceCount
      FROM Recurrence r
      INNER JOIN CalendarItem ci ON r.owner_id = ci.ROWID
      INNER JOIN OccurrenceCache oc ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      WHERE oc.day >= ${nowMac}
        AND ci.summary IS NOT NULL AND ci.summary <> ''
      GROUP BY ci.ROWID, ci.summary, c.title, ci.all_day
      ORDER BY occurrenceCount DESC, MIN(oc.day) ASC
      LIMIT ${fetchLimit}
    `;
    const events = safeSqlite3Json(CALENDAR_DB, query, { timeout: 30000 });
    const hasMore = events.length > safeLimit;
    const limitedEvents = events.slice(0, safeLimit);
    return { events: limitedEvents, showing: limitedEvents.length, hasMore };
  } catch (e) {
    console.error("Error getting recurring events:", e.message);
    return { events: [], showing: 0, hasMore: false };
  }
}
