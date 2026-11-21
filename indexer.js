import fs from "fs";
import path from "path";
import * as lancedb from "@lancedb/lancedb";
import {
  validateEmailPath,
  validateMailboxName,
  escapeAppleScript,
  validateLimit,
  validateLanceDBId,
  escapeSQL,
  stripHtmlTags,
  toUnixMillis,
  unfoldRfc822Headers,
  stripSubjectPrefixes
} from "./lib/validators.js";
import { safeSqlite3Json, safeSqlite3JsonAsync, safeOsascript, safeFindAsync } from "./lib/shell.js";
import { indexUnavailableMessage } from "./lib/indexGate.js";
import {
  createLanceTableCache,
  createLanceSession,
  INDEX_TABLE_NAMES,
  LANCE_CONNECT_OPTIONS
} from "./lib/lancedbTables.js";
import {
  createIndexedIdCache,
  createDuplicatePathTracker,
  isIndexOptimizeDue,
  optimizeIndexTables
} from "./lib/indexMaintenance.js";
import { createMessageContactMatcher } from "./lib/messageContact.js";
import { resolveByExactName, normalizePhone } from "./contacts.js";

export {
  loadContacts,
  resolveEmail,
  resolvePhone,
  resolveByName,
  resolveByExactName,
  normalizePhone,
  lookupContact,
  searchContacts,
  getContactIdentifiers,
  formatContact,
  getContactStats
} from "./contacts.js";

export const INDEX_DIR = process.env.APPLE_TOOLS_INDEX_DIR ||
  path.join(process.env.HOME, ".apple-tools-mcp", "vector-index");
const META_FILE = process.env.APPLE_TOOLS_META_FILE ||
  path.join(process.env.HOME, ".apple-tools-mcp", "index-meta.json");
const DAYS_BACK = process.env.APPLE_TOOLS_INDEX_DAYS_BACK !== undefined
  ? parseInt(process.env.APPLE_TOOLS_INDEX_DAYS_BACK, 10) || null
  : null;
const MAIL_DIR = path.join(process.env.HOME, "Library", "Mail");

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
const BATCH_SIZE = 64;
const BATCH_DELAY_MS = 0;

const MAC_ABSOLUTE_EPOCH = 978307200;
export const CALENDAR_TMP_PREFIX = "apple-tools-cal-";

let embeddingPipeline = null;

const lanceCache = createLanceTableCache({
  connect: (uri, options, session) => lancedb.connect(uri, options, session),
  indexDir: INDEX_DIR,
  mkdirSync: (p, o) => fs.mkdirSync(p, o),
  connectOptions: LANCE_CONNECT_OPTIONS,
  session: createLanceSession(lancedb.Session)
});
const tables = lanceCache.tables;
let db = null;

const EMAIL_ID_FIELDS = ["filePath", "messageId"];
const indexedIdCache = createIndexedIdCache({
  getTable: async (name) => {
    await initDB();
    return tables[name] || null;
  }
});
const duplicateEmailPaths = createDuplicatePathTracker();

async function getEmbedder() {
  if (!embeddingPipeline) {
    console.error("Loading embedding model (first time may take a minute)...");
    const { pipeline } = await import("@huggingface/transformers");
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

const EMBEDDING_DIM = 384;

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

  const EMBEDDING_TIMEOUT_MS = 30000;

  try {
    const result = await withTimeout(
      embedder(texts, { pooling: "mean", normalize: true }),
      EMBEDDING_TIMEOUT_MS,
      "Batch embedding"
    );

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
      const embeddings = [];
      for (const text of texts) {
        try {
          const emb = await withTimeout(embed(text), 10000, "Single embedding");
          embeddings.push(emb);
        } catch (e) {
          console.error(`Failed to embed text: ${e.message}`);
          embeddings.push(new Array(EMBEDDING_DIM).fill(0));
        }
      }
      return embeddings;
    }
    throw error;
  }
}


function extractEmail(str) {
  if (!str) return "";
  const match = str.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase();
  if (str.includes("@")) return str.trim().toLowerCase();
  return "";
}

function extractEmails(str) {
  if (!str) return [];
  const emails = [];
  for (const part of str.split(",")) {
    const email = extractEmail(part.trim());
    if (email && email.includes("@")) {
      emails.push(email);
    }
  }
  return emails;
}

function parseDateTime(dateStr) {
  if (!dateStr) return 0;
  try {
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getTime();

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


function extractMailbox(filePath) {
  const match = filePath.match(/([^/]+)\.mbox/);
  return match ? match[1] : "Unknown";
}

const MAILBOX_PRIORITY = {
  "INBOX": 1,
  "Sent": 2,
  "Sent Messages": 2,
  "Sent Mail": 2,
  "Drafts": 3,
  "Flagged": 4,

  "Archive": 5,
  "Archives": 5,

  "All Mail": 90,
  "[Gmail]": 90,

  "Junk": 95,
  "Spam": 95,
  "Junk E-mail": 95,
  "Trash": 99,
  "Deleted Messages": 99,
  "Deleted Items": 99,
  "Bin": 99
};

function getMailboxPriority(filePath) {
  const mailbox = extractMailbox(filePath);
  return MAILBOX_PRIORITY[mailbox] ?? 50;
}

function parseEmlx(filePath) {
  try {
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const isPartial = filePath.endsWith(".partial.emlx");

    let content = rawContent;
    const lines = rawContent.split("\n");
    if (lines[0] && /^\d+\s*$/.test(lines[0])) {
      content = lines.slice(1).join("\n");
    }

    const unfolded = unfoldRfc822Headers(content);

    const fromMatch = unfolded.match(/^From:\s*(.+)$/m);
    const subjectMatch = unfolded.match(/^Subject:\s*(.+)$/m);
    const dateMatch = unfolded.match(/^Date:\s*(.+)$/m);
    const toMatch = unfolded.match(/^To:\s*(.+)$/m);
    const ccMatch = unfolded.match(/^Cc:\s*(.+)$/m);
    const messageIdMatch = unfolded.match(/^Message-ID:\s*(.+)$/im);
    const flaggedMatch = unfolded.match(/^X-Flagged:\s*(.+)$/im) || unfolded.match(/flags.*flagged/i);

    const hasAttachment = /Content-Disposition:\s*attachment/i.test(content) ||
                          /multipart\/mixed/i.test(content) ||
                          /filename=/i.test(content);

    const headerEnd = content.search(/\r?\n\r?\n/);
    let body = "";
    if (headerEnd > 0) {
      body = content.substring(headerEnd + 2, Math.min(headerEnd + 2000, content.length));
      body = stripHtmlTags(body);
    }

    const fromRaw = fromMatch?.[1]?.trim() || "";
    const toRaw = toMatch?.[1]?.trim() || "";
    const ccRaw = ccMatch?.[1]?.trim() || "";
    const subject = subjectMatch?.[1]?.trim() || "";
    const date = dateMatch?.[1]?.trim() || "";

    const fromEmail = extractEmail(fromRaw);
    const toEmails = extractEmails(toRaw);
    const ccEmails = extractEmails(ccRaw);
    const allRecipients = [...toEmails, ...ccEmails];

    const dateTimestamp = parseDateTime(date);

    const mailbox = extractMailbox(filePath);
    const isSent = mailbox.toLowerCase().includes("sent");
    const isFlagged = !!flaggedMatch;

    const searchText = `From: ${fromRaw}\nTo: ${toRaw}\nSubject: ${subject}\n${body}`.substring(0, 1000);
    const messageId = messageIdMatch?.[1]?.trim() || "";

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

async function findAllEmlxFiles() {
  return safeFindAsync(MAIL_DIR, { name: "*.emlx", type: "f" });
}

const EMLX_HEADER_READ_BYTES = 64 * 1024;
function readEmlxMessageId(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(EMLX_HEADER_READ_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let content = buf.subarray(0, n).toString("utf-8");
    const firstNewline = content.indexOf("\n");
    if (firstNewline >= 0 && /^\d+\s*$/.test(content.slice(0, firstNewline))) {
      content = content.slice(firstNewline + 1);
    }
    const match = unfoldRfc822Headers(content).match(/^Message-ID:\s*(.+)$/im);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { }
    }
  }
}

const STALE_EMAIL_CHUNK = 500;

function emailFileGone(filePath) {
  try {
    fs.statSync(filePath);
    return false;
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR";
  }
}

function lanceStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function reconcileStaleEmailRows(indexedPaths) {
  let staleCount = 0;
  for (const p of indexedPaths) {
    if (emailFileGone(p)) staleCount++;
  }
  if (staleCount === 0 || !tables.emails) return null;

  let allFiles;
  try {
    fs.readdirSync(MAIL_DIR);
    allFiles = await findAllEmlxFiles();
  } catch (e) {
    console.error(`Stale email check skipped: Mail folder unreadable (${e.message})`);
    return null;
  }
  if (allFiles.length === 0) {
    console.error(`Stale email check skipped: ${staleCount} indexed paths are missing but the Mail scan found no .emlx files`);
    return null;
  }

  console.error(`\n=== STALE EMAIL ROWS: ${staleCount} indexed paths no longer exist ===`);
  const started = Date.now();

  const idRows = await tables.emails.query().select(["filePath", "messageId"]).toArray();
  const stale = idRows.filter(r => emailFileGone(r.filePath));
  const wantedIds = new Set(stale.map(r => r.messageId).filter(Boolean));

  const liveById = new Map();
  for (const filePath of allFiles) {
    if (indexedPaths.has(filePath)) continue;
    const messageId = readEmlxMessageId(filePath);
    if (!messageId || !wantedIds.has(messageId)) continue;
    const current = liveById.get(messageId);
    if (!current || getMailboxPriority(filePath) < getMailboxPriority(current)) {
      liveById.set(messageId, filePath);
    }
  }

  const repath = new Map();
  const drop = [];
  for (const row of stale) {
    const target = row.messageId ? liveById.get(row.messageId) : undefined;
    if (target) {
      repath.set(row.filePath, target);
      liveById.delete(row.messageId);
    } else {
      drop.push(row.filePath);
    }
  }

  const inList = (paths) => `\`filePath\` IN (${paths.map(lanceStringLiteral).join(", ")})`;
  let repathed = 0;
  let removed = 0;
  const oldPaths = [...repath.keys()];
  for (let i = 0; i < oldPaths.length; i += STALE_EMAIL_CHUNK) {
    const chunk = oldPaths.slice(i, i + STALE_EMAIL_CHUNK);
    const rows = await tables.emails.query().where(inList(chunk)).toArray();
    const seen = new Set();
    const records = rows.filter(row => {
      if (seen.has(row.filePath)) return false;
      seen.add(row.filePath);
      return true;
    }).map(row => {
      const filePath = repath.get(row.filePath);
      const mailbox = extractMailbox(filePath);
      return {
        ...row,
        filePath,
        mailbox,
        isSent: mailbox.toLowerCase().includes("sent"),
        vector: Array.from(row.vector)
      };
    });
    if (records.length > 0) await tables.emails.add(records);
    await tables.emails.delete(inList(chunk));
    repathed += records.length;
  }
  for (let i = 0; i < drop.length; i += STALE_EMAIL_CHUNK) {
    const chunk = drop.slice(i, i + STALE_EMAIL_CHUNK);
    await tables.emails.delete(inList(chunk));
    removed += chunk.length;
  }

  indexedIdCache.invalidate("emails");
  duplicateEmailPaths.clear();
  console.error(`Stale email rows: re-pathed ${repathed}, removed ${removed} (${Date.now() - started}ms)`);
  return { repathed, removed, allFiles };
}

async function findNewEmlxFiles(sinceTimestamp) {
  if (!sinceTimestamp) {
    console.error("No previous index timestamp, doing full scan...");
    return findAllEmlxFiles();
  }

  try {
    const daysAgo = Math.ceil((Date.now() - sinceTimestamp) / (24 * 60 * 60 * 1000));

    const files = await safeFindAsync(MAIL_DIR, { name: "*.emlx", type: "f", mtime: `-${daysAgo}` });
    console.error(`find found ${files.length} new/modified emails in last ${daysAgo} days`);
    return files;
  } catch (e) {
    console.error("find failed, falling back to full scan:", e.message);
    return findAllEmlxFiles();
  }
}


function validateExtractedText(text) {
  if (!text || typeof text !== 'string') return false;
  text = text.trim();
  if (text.length < 1 || text.length > 10000) return false;

  const printableRatio = (text.match(/[\x20-\x7E\u00A0-\uFFFF]/g) || []).length / text.length;
  return printableRatio >= 0.8;
}

function extractStrategy1_CurrentPattern(buf) {
  const nsStringMarker = Buffer.from('NSString');
  let markerIndex = buf.indexOf(nsStringMarker);
  if (markerIndex === -1) return null;

  const searchStart = markerIndex + nsStringMarker.length;
  const plusIndex = buf.indexOf(0x2B, searchStart);
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

function extractStrategy2_DirectUTF8Scan(buf) {
  const fullText = buf.toString('utf-8');
  const regex = /[\x20-\x7E\u00A0-\uFFFF]{20,}/g;
  const matches = fullText.match(regex);

  if (!matches || matches.length === 0) return null;

  return matches.reduce((a, b) => a.length > b.length ? a : b).trim();
}

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

    const textStart = nsIdx + nsStringMarker.length + 10;
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
  return extractedTexts.reduce((a, b) => a.length > b.length ? a : b);
}

function extractStrategy4_RegexBased(buf) {
  const text = buf.toString('utf-8', 0, Math.min(buf.length, 2000));

  const patterns = [
    /(?:wrote|said):\s*\n?\s*(.{20,})/i,
    /"(.{20,})"/,
    /\n\s*([A-Z].{20,})\s*\n/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const extracted = match[1].trim();
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

function extractTextFromAttributedBody(buffer) {
  if (!buffer || buffer.length === 0) return null;

  try {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

    const strategies = [
      extractStrategy1_CurrentPattern,
      extractStrategy2_DirectUTF8Scan,
      extractStrategy3_NSKeyedArchiver,
      extractStrategy4_RegexBased
    ];

    for (const strategy of strategies) {
      try {
        const text = strategy(buf);
        if (text && validateExtractedText(text)) {
          return text;
        }
      } catch (e) {
        continue;
      }
    }

    return null;
  } catch (e) {
    return null;
  }
}

async function getMessages(sinceTimestamp = null) {
  try {
    let dateFilter = '';


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
    const results = await safeSqlite3JsonAsync(MESSAGES_DB, query, { timeout: 60000 });
    if (!Array.isArray(results)) {
      throw new Error("Unexpected sqlite3 result for messages");
    }

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
        }
      }
      delete msg.attributedBodyHex;
    }

    if (extractedCount > 0) {
      console.error(`Extracted text from attributedBody for ${extractedCount} messages`);
    }

    return results.filter(msg => msg.text && msg.text.trim() !== '');
  } catch (e) {
    console.error("Error reading messages:", e.message);
    throw e;
  }
}


function macAbsoluteToUnixMs(macTime) {
  if (!macTime) return 0;
  return (macTime + MAC_ABSOLUTE_EPOCH) * 1000;
}

function unixMsToMacAbsolute(unixMs) {
  return (unixMs / 1000) - MAC_ABSOLUTE_EPOCH;
}

function formatMacAbsoluteDate(macTime) {
  if (!macTime) return "";
  const date = new Date(macAbsoluteToUnixMs(macTime));
  return date.toLocaleString();
}

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

async function getCalendarEvents() {
  if (!fs.existsSync(CALENDAR_DB)) {
    throw new Error("Calendar database not found");
  }

  const now = Date.now();
  const pastDate = unixMsToMacAbsolute(now - 10 * 365 * 24 * 60 * 60 * 1000);
  const futureDate = unixMsToMacAbsolute(now + 10 * 365 * 24 * 60 * 60 * 1000);

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

  const attendeesQuery = `
      SELECT
        p.owner_id,
        COALESCE(i.display_name, p.email, 'Unknown') as name,
        p.status
      FROM Participant p
      LEFT JOIN Identity i ON p.identity_id = i.ROWID
      WHERE p.entity_type = 0
    `;

  return withCalendarCopyAsync(async (dbPath) => {
    const rows = await safeSqlite3JsonAsync(dbPath, query, { timeout: 30000 });

    let attendeesMap = new Map();
    try {
      const attendeesRows = await safeSqlite3JsonAsync(dbPath, attendeesQuery, { timeout: 10000 });

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
        dbId: row.id,
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
  });
}


export async function initDB() {
  const result = await lanceCache.initDB();
  db = result.db;
  return { db, tables };
}

export async function getOpenTable(type) {
  await initDB();
  return tables[type] || null;
}

function resetLanceConnection() {
  lanceCache.reset();
  db = null;
  indexedIdCache.invalidate();
  duplicateEmailPaths.clear();
}

export async function clearEmailsTable() {
  await initDB();
  if (tables.emails) {
    await db.dropTable("emails");
    tables.emails = null;
    indexedIdCache.invalidate("emails");
    duplicateEmailPaths.clear();
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
    indexedIdCache.invalidate("messages");
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

  resetLanceConnection();

  for (const source of sources) {
    try {
      if (source === "emails") {
        if (progressCallback) progressCallback("Indexing emails...");
        const indexResult = await indexEmails(progressCallback, true);
        results.indexed.emails = indexResult;
      } else if (source === "messages") {
        if (progressCallback) progressCallback("Indexing messages...");
        const indexResult = await indexMessages(true);
        results.indexed.messages = indexResult;
      } else if (source === "calendar") {
        if (progressCallback) progressCallback("Indexing calendar...");
        const indexResult = await indexCalendar();
        results.indexed.calendar = indexResult;
      }
      const skipped = results.indexed[source]?.error;
      if (skipped) results.errors.push({ source, phase: "read", error: skipped });
    } catch (e) {
      results.errors.push({ source, phase: "index", error: e.message });
    }
  }

  if (isFullIndexPass(sources, results.errors)) {
    try {
      recordIndexPassTime();
    } catch (e) {
      console.error(`Could not record the index pass time: ${e.message}`);
    }
  }

  return results;
}

export function isFullIndexPass(sources, errors = []) {
  const covered = new Set(Array.isArray(sources) ? sources : []);
  return INDEX_TABLE_NAMES.every((s) => covered.has(s)) && errors.length === 0;
}

function recordIndexPassTime() {
  const { lastSkippedIndexPassTime, ...meta } = loadIndexMeta();
  saveIndexMeta({ ...meta, lastIndexPassTime: Date.now() });
}

function recordSkippedIndexPass() {
  try {
    saveIndexMeta({ ...loadIndexMeta(), lastSkippedIndexPassTime: Date.now() });
  } catch (e) {
    console.error(`Could not record the skipped index pass: ${e.message}`);
  }
}

async function getIndexedIds(tableName, idField) {
  await initDB();
  if (!tables[tableName]) return new Set();

  try {
    const results = await tables[tableName].query().select([idField]).toArray();
    return new Set(results.map(r => r[idField]));
  } catch (e) {
    console.error(`Error getting indexed IDs from ${tableName}: ${e.message}`);
    throw new Error(`Failed to get indexed IDs from ${tableName}: ${e.message}`);
  }
}

async function getIndexedIdsWithRetry(tableName, idField, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await getIndexedIds(tableName, idField);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.error(`Retry ${attempt}/${maxRetries} after ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}

async function getCachedIdSetsWithRetry(tableName, fields, maxRetries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await indexedIdCache.getIdSets(tableName, fields);
    } catch (e) {
      console.error(`Error getting indexed IDs from ${tableName}: ${e.message}`);
      lastError = new Error(`Failed to get indexed IDs from ${tableName}: ${e.message}`);
      indexedIdCache.invalidate(tableName);
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
        console.error(`Retry ${attempt}/${maxRetries} after ${backoff}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}


export async function indexEmails(progressCallback = null, forceFullScan = false) {
  await initDB();

  const meta = loadIndexMeta();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  let lastEmailIndexTime;
  if (DAYS_BACK) {
    lastEmailIndexTime = Date.now() - (DAYS_BACK * 24 * 60 * 60 * 1000);
    console.error(`\n=== EMAIL INDEXING (DAYS_BACK=${DAYS_BACK}) ===`);
    console.error(`Will search for emails modified since: ${new Date(lastEmailIndexTime).toISOString()}`);
  } else if (forceFullScan) {
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

  const indexStartTime = Date.now();

  const startTime = Date.now();
  console.error(`Calling findNewEmlxFiles with timestamp: ${lastEmailIndexTime ? new Date(lastEmailIndexTime).toISOString() : 'null (full scan)'}`);
  let newFiles;
  try {
    newFiles = await findNewEmlxFiles(lastEmailIndexTime);
  } catch (e) {
    console.error(`Email source read failed; skipping this cycle so the lookback timestamp is not advanced: ${e.message}`);
    return { indexed: 0, added: 0, error: e.message };
  }
  console.error(`Found ${newFiles.length} new/modified email files (${Date.now() - startTime}ms)`);

  let emailIdSets = await getCachedIdSetsWithRetry("emails", EMAIL_ID_FIELDS);

  let staleResult = null;
  try {
    staleResult = await reconcileStaleEmailRows(emailIdSets.filePath);
  } catch (e) {
    indexedIdCache.invalidate("emails");
    console.error(`Stale email check failed; continuing with the normal pass: ${e.message}`);
  }
  if (staleResult) {
    if (!DAYS_BACK) newFiles = staleResult.allFiles;
    emailIdSets = await getCachedIdSetsWithRetry("emails", EMAIL_ID_FIELDS);
  }
  const staleCounts = staleResult
    ? { repathed: staleResult.repathed, removed: staleResult.removed }
    : {};
  const indexedPaths = emailIdSets.filePath;
  const indexedMessageIds = emailIdSets.messageId;
  console.error(`Already indexed: ${indexedPaths.size} emails`);

  duplicateEmailPaths.retainOnly(newFiles);
  let knownDuplicates = 0;
  let toIndex = newFiles.filter(f => {
    if (indexedPaths.has(f)) return false;
    if (duplicateEmailPaths.has(f)) {
      knownDuplicates++;
      return false;
    }
    return true;
  });
  if (knownDuplicates > 0) {
    console.error(`Known duplicate copies (already indexed by Message-ID): ${knownDuplicates}`);
  }
  console.error(`Need to index: ${toIndex.length} emails`);

  toIndex.sort((a, b) => getMailboxPriority(a) - getMailboxPriority(b));

  if (toIndex.length === 0) {
    saveIndexMeta({ ...meta, lastEmailIndexTime: indexStartTime });
    return { indexed: indexedPaths.size, added: 0, ...staleCounts };
  }

  let processed = 0;
  let indexedCount = 0;
  let skippedCount = { parseNull: 0, shortSearchText: 0, duplicateMessageId: 0, alreadyIndexed: 0 };

  const totalBatches = Math.ceil(toIndex.length / BATCH_SIZE);
  const startProcessTime = Date.now();
  console.error(`\nProcessing ${toIndex.length} emails in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);

    const parsedEmails = [];
    const searchTexts = [];
    const batchMessageIds = new Set();

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
      if (parsed.messageId && (indexedMessageIds.has(parsed.messageId) || batchMessageIds.has(parsed.messageId))) {
        skippedCount.duplicateMessageId++;
        duplicateEmailPaths.add(filePath);
        continue;
      }
      if (parsed.messageId) {
        batchMessageIds.add(parsed.messageId);
      }
      parsedEmails.push({ filePath, parsed });
      searchTexts.push(parsed.searchText);
    }

    let vectors = [];
    if (searchTexts.length > 0) {
      try {
        vectors = await embedBatch(searchTexts);
      } catch (e) {
        console.error("Batch embedding error:", e.message);
        continue;
      }
    }

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
    })).filter(r => r.vector);

    if (records.length > 0) {
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
          indexedCount += uniqueRecords.length;
          for (const record of uniqueRecords) {
            if (record.messageId) {
              indexedMessageIds.add(record.messageId);
            }
          }
        } else {
          const currentIndexed = (await getCachedIdSetsWithRetry("emails", EMAIL_ID_FIELDS)).filePath;
          const trulyNew = uniqueRecords.filter(r => !currentIndexed.has(r.filePath));

          if (trulyNew.length < uniqueRecords.length) {
            skippedCount.alreadyIndexed += uniqueRecords.length - trulyNew.length;
            console.error(`WARNING: ${uniqueRecords.length - trulyNew.length} records were already indexed. Filtering them out.`);
          }

          if (trulyNew.length > 0) {
            const beforeCount = await tables.emails.countRows();
            await tables.emails.add(trulyNew);
            indexedCount += trulyNew.length;
            const afterCount = await tables.emails.countRows();
            const actualAdded = afterCount - beforeCount;

            if (actualAdded !== trulyNew.length) {
              console.error(`WARNING: Expected to add ${trulyNew.length} records but index grew by ${actualAdded}. Possible duplicate issue.`);
            }

            for (const record of trulyNew) {
              if (record.messageId) {
                indexedMessageIds.add(record.messageId);
              }
            }
            await indexedIdCache.noteAdded("emails", trulyNew);
          }
        }
      }
    }

    processed += batch.length;

    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    const elapsedMs = Date.now() - startProcessTime;
    const avgTimePerBatch = elapsedMs / currentBatch;
    const remainingBatches = totalBatches - currentBatch;
    const estimatedRemainingMs = avgTimePerBatch * remainingBatches;
    const estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 60000);

    console.error(`Batch ${currentBatch}/${totalBatches} complete | Processed: ${processed}/${toIndex.length} emails | Est. remaining: ${estimatedRemainingMin}m`);

    if (progressCallback) {
      progressCallback(`emails-batch-${processed}/${toIndex.length}`);
    }

    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  saveIndexMeta({ ...meta, lastEmailIndexTime: indexStartTime });

  const totalProcessingTime = Date.now() - startProcessTime;
  const totalSkipped = skippedCount.parseNull + skippedCount.shortSearchText +
    skippedCount.duplicateMessageId + skippedCount.alreadyIndexed;
  console.error(`\nEmail indexing summary:`);
  console.error(`  Files to index: ${toIndex.length}`);
  console.error(`  Successfully indexed: ${indexedCount}`);
  console.error(`  Skipped - parse errors: ${skippedCount.parseNull}`);
  console.error(`  Skipped - short searchText: ${skippedCount.shortSearchText}`);
  console.error(`  Skipped - duplicate messageId: ${skippedCount.duplicateMessageId}`);
  console.error(`  Skipped - already indexed: ${skippedCount.alreadyIndexed}`);
  console.error(`  Total skipped: ${totalSkipped}`);
  console.error(`  Discrepancy: ${toIndex.length - indexedCount - totalSkipped}`);
  console.error(`  Total time: ${Math.round(totalProcessingTime / 1000)}s (${Math.round(totalProcessingTime / 60000)}m)\n`);

  const finalIndexedPaths = (await getCachedIdSetsWithRetry("emails", EMAIL_ID_FIELDS)).filePath;
  return { indexed: finalIndexedPaths.size, added: indexedCount, ...staleCounts };
}

export async function indexMessages(forceFullScan = false) {
  await initDB();

  const meta = loadIndexMeta();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const lastMessageIndexTime = forceFullScan ? null :
    (meta.lastMessageIndexTime ? meta.lastMessageIndexTime - ONE_HOUR_MS : null);

  const indexStartTime = Date.now();

  let messages;
  try {
    messages = await getMessages(lastMessageIndexTime);
  } catch (e) {
    console.error(`Messages source read failed; skipping this cycle so the lookback timestamp is not advanced: ${e.message}`);
    return { indexed: 0, added: 0, error: e.message };
  }
  console.error(`Found ${messages.length} messages${lastMessageIndexTime ? ' (incremental)' : ' (full scan)'}`);

  const indexed = (await getCachedIdSetsWithRetry("messages", ["id"])).id;
  console.error(`Already indexed: ${indexed.size} messages`);

  const toIndex = messages.filter(m => !indexed.has(String(m.id)));
  console.error(`Need to index: ${toIndex.length} messages`);

  if (toIndex.length === 0) {
    saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime });
    return { indexed: indexed.size, added: 0 };
  }

  let processed = 0;
  let addedCount = 0;

  const totalBatches = Math.ceil(toIndex.length / BATCH_SIZE);
  const startProcessTime = Date.now();
  console.error(`\nProcessing ${toIndex.length} messages in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

  for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
    const batch = toIndex.slice(i, i + BATCH_SIZE);

    const preparedMsgs = [];
    const searchTexts = [];

    for (const msg of batch) {
      const searchText = `From: ${msg.sender}\nMessage: ${msg.text}`.substring(0, 500);
      if (searchText.length > 10) {
        preparedMsgs.push(msg);
        searchTexts.push(searchText);
      }
    }

    let vectors = [];
    if (searchTexts.length > 0) {
      try {
        vectors = await embedBatch(searchTexts);
      } catch (e) {
        console.error("Batch embedding error:", e.message);
        continue;
      }
    }

    const records = preparedMsgs.map((msg, idx) => {
      const isGroupChat = Boolean((parseInt(msg.participantCount) || 0) > 2 || (msg.chatName && msg.chatName.length > 0));
      const hasAttachment = Boolean((parseInt(msg.attachmentCount) || 0) > 0);
      return {
        id: String(msg.id),
        date: msg.date,
        dateTimestamp: toUnixMillis(msg.dateTimestamp),
        sender: msg.sender,
        text: msg.text?.substring(0, 500) || "",
        chatId: String(msg.chatId || ""),
        chatIdentifier: msg.chatIdentifier || "",
        chatName: msg.chatName || "",
        isGroupChat,
        hasAttachment,
        vector: vectors[idx]
      };
    }).filter(r => r.vector);

    if (records.length > 0) {
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
          addedCount += uniqueRecords.length;
        } else {
          const currentIndexed = (await getCachedIdSetsWithRetry("messages", ["id"])).id;
          const trulyNew = uniqueRecords.filter(r => !currentIndexed.has(r.id));

          if (trulyNew.length < uniqueRecords.length) {
            console.error(`WARNING: ${uniqueRecords.length - trulyNew.length} records were already indexed. Filtering them out.`);
          }

          if (trulyNew.length > 0) {
            const beforeCount = await tables.messages.countRows();
            await tables.messages.add(trulyNew);
            addedCount += trulyNew.length;
            const afterCount = await tables.messages.countRows();
            const actualAdded = afterCount - beforeCount;

            if (actualAdded !== trulyNew.length) {
              console.error(`WARNING: Expected to add ${trulyNew.length} records but index grew by ${actualAdded}. Possible duplicate issue.`);
            }
            await indexedIdCache.noteAdded("messages", trulyNew);
          }
        }
      }
    }

    processed += batch.length;

    const currentBatch = Math.floor(i / BATCH_SIZE) + 1;
    const elapsedMs = Date.now() - startProcessTime;
    const avgTimePerBatch = elapsedMs / currentBatch;
    const remainingBatches = totalBatches - currentBatch;
    const estimatedRemainingMs = avgTimePerBatch * remainingBatches;
    const estimatedRemainingMin = Math.ceil(estimatedRemainingMs / 60000);

    console.error(`Batch ${currentBatch}/${totalBatches} complete | Processed: ${processed}/${toIndex.length} messages | Est. remaining: ${estimatedRemainingMin}m`);

    if (i + BATCH_SIZE < toIndex.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }

  saveIndexMeta({ ...meta, lastMessageIndexTime: indexStartTime });

  return { indexed: indexed.size, added: addedCount };
}

export async function indexCalendar() {
  await initDB();

  let events;
  try {
    events = await getCalendarEvents();
  } catch (e) {
    console.error(`Calendar source read failed; skipping index update to avoid data loss: ${e.message}`);
    return { indexed: 0, added: 0, removed: 0, error: e.message };
  }
  console.error(`Found ${events.length} calendar events`);

  const indexed = await getIndexedIdsWithRetry("calendar", "id");
  console.error(`Already indexed: ${indexed.size} calendar events`);

  const currentIds = new Set(events.map(evt => `${evt.dbId}`));

  const staleIds = [...indexed].filter(id => !currentIds.has(id));
  if (staleIds.length > 0 && tables.calendar) {
    console.error(`Removing ${staleIds.length} stale calendar entries...`);

    const validIds = [];
    for (const staleId of staleIds) {
      const validatedId = validateLanceDBId(staleId);
      if (!validatedId) {
        console.error(`Skipping invalid stale ID: ${staleId.substring(0, 50)}...`);
        continue;
      }
      validIds.push(escapeSQL(validatedId));
    }

    const BATCH_DELETE_SIZE = 100;
    for (let i = 0; i < validIds.length; i += BATCH_DELETE_SIZE) {
      const batch = validIds.slice(i, i + BATCH_DELETE_SIZE);
      if (batch.length > 0) {
        try {
          const conditions = batch.map(id => `id = '${id}'`).join(' OR ');
          await tables.calendar.delete(conditions);
        } catch (e) {
          console.error(`Failed to delete batch: ${e.message}`);
        }
      }
    }
  }

  const validEvents = [];
  const searchTexts = [];

  for (const evt of events) {
    const eventId = `${evt.dbId}`;
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
  })).filter(r => r.vector);

  if (records.length > 0) {
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
        await tables.calendar.add(uniqueRecords);
      } else {
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

  await maybeOptimizeIndex({ emails: emailResult, messages: messageResult, calendar: calendarResult });

  if ([emailResult, messageResult, calendarResult].some(result => !result.error)) {
    recordIndexPassTime();
  } else {
    recordSkippedIndexPass();
  }

  console.error("Full index complete.");
  return { emails: emailResult, messages: messageResult, calendar: calendarResult };
}

async function maybeOptimizeIndex(results) {
  const wroteSomething =
    (results.emails?.added || 0) > 0 ||
    (results.emails?.repathed || 0) > 0 ||
    (results.emails?.removed || 0) > 0 ||
    (results.messages?.added || 0) > 0 ||
    (results.calendar?.added || 0) > 0 ||
    (results.calendar?.removed || 0) > 0;
  const meta = loadIndexMeta();
  if (!isIndexOptimizeDue({ lastOptimizeTime: meta.lastIndexOptimizeTime, wroteSomething })) {
    return null;
  }
  console.error("Optimizing index tables (compaction + old version cleanup)...");
  const result = await optimizeIndexTables({ tables, tableNames: INDEX_TABLE_NAMES });
  indexedIdCache.invalidate();
  saveIndexMeta({ ...loadIndexMeta(), lastIndexOptimizeTime: Date.now() });
  return result;
}

export function getLastIndexPassTime() {
  const t = loadIndexMeta().lastIndexPassTime;
  return Number.isFinite(t) && t > 0 ? t : null;
}

export function getLastSkippedIndexPassTime() {
  const t = loadIndexMeta().lastSkippedIndexPassTime;
  return Number.isFinite(t) && t > 0 ? t : null;
}

export async function isIndexReady(type = "emails") {
  await initDB();
  return tables[type] != null;
}


export async function getRecentEmails(limit = 10, daysBack = 7) {
  await initDB();
  if (!tables.emails) return [];

  const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);

  try {
    const results = await tables.emails.query()
      .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "mailbox", "isSent", "isFlagged", "messageId", "body"])
      .toArray();

    return results
      .filter(r => r.dateTimestamp >= cutoff)
      .sort((a, b) => b.dateTimestamp - a.dateTimestamp)
      .slice(0, limit);
  } catch (e) {
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
    const results = await tables.emails.query()
      .select(["filePath", "from", "fromEmail", "to", "subject", "date", "dateTimestamp", "hasAttachment", "mailbox", "isSent", "isFlagged", "messageId", "body"])
      .toArray();

    return results
      .filter(r => r.dateTimestamp >= startTs && r.dateTimestamp < endTs)
      .sort((a, b) => b.dateTimestamp - a.dateTimestamp);
  } catch (e) {
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
    const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);
    const results = await tables.messages.query()
      .select(["id", "date", "dateTimestamp", "sender", "text", "chatId", "chatIdentifier", "chatName", "isGroupChat"])
      .toArray();

    const filtered = results
      .filter(r => toUnixMillis(r.dateTimestamp) >= cutoff)
      .sort((a, b) => toUnixMillis(b.dateTimestamp) - toUnixMillis(a.dateTimestamp));

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
    const matcher = createMessageContactMatcher(contact, { resolveExactName: resolveByExactName, normalizePhone });
    if (!matcher) return [];
    const results = await tables.messages.query()
      .select(["id", "date", "dateTimestamp", "sender", "text", "chatId", "chatIdentifier"])
      .toArray();

    const filtered = results.filter(r => matcher.matches(r));

    return filtered
      .sort((a, b) => toUnixMillis(a.dateTimestamp) - toUnixMillis(b.dateTimestamp))
      .slice(-limit);
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


const EXCLUDED_MAILBOXES = ['junk', 'trash', 'deleted messages', 'spam'];

export async function getFrequentSenders(limit = 30, daysBack = 0, includeJunk = false) {
  await initDB();
  if (!tables.emails) return [];

  try {
    let emails = await tables.emails.query().select(["fromEmail", "from", "dateTimestamp", "mailbox"]).toArray();
    if (daysBack > 0) {
      const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
      emails = emails.filter(e => e.dateTimestamp >= cutoff);
    }
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

export function getMessageContacts(limit = 50) {
  try {
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
    return { error: e.message };
  }
}

export function buildUpcomingEventsQuery(dayStartMac, fetchLimit) {
  const occStart = "COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date)";
  return `
      SELECT
        ci.summary as title,
        datetime(${occStart} + 978307200, 'unixepoch', 'localtime') as start,
        datetime(COALESCE(oc.occurrence_end_date, ci.end_date) + 978307200, 'unixepoch', 'localtime') as end,
        ci.all_day as isAllDay,
        c.title as calendar,
        l.title as location,
        oc.day as sort_day
      FROM OccurrenceCache oc
      INNER JOIN CalendarItem ci ON oc.event_id = ci.ROWID
      LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
      LEFT JOIN Location l ON ci.location_id = l.ROWID
      WHERE oc.day >= ${dayStartMac} AND ci.summary IS NOT NULL AND ci.summary <> ''
      ORDER BY sort_day ASC, ci.all_day DESC, ${occStart} ASC, title ASC
      LIMIT ${fetchLimit}
    `;
}

function localTodayStartMac() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000) - MAC_ABSOLUTE_EPOCH;
}

function assertOccurrenceCache(dbPath) {
  const rows = safeSqlite3Json(dbPath, "SELECT COUNT(*) AS n FROM (SELECT 1 FROM OccurrenceCache LIMIT 1)", { timeout: 10000 });
  if (!rows.length || !Number(rows[0].n)) {
    throw new Error("Calendar OccurrenceCache is empty, so the calendar could not be read");
  }
}

export function getUpcomingEvents(limit = 10) {
  try {
    const safeLimit = validateLimit(limit, 10, 100);
    const fetchLimit = safeLimit + 1;
    const query = buildUpcomingEventsQuery(localTodayStartMac(), fetchLimit);
    const events = withCalendarCopy((dbPath) => {
      assertOccurrenceCache(dbPath);
      return safeSqlite3Json(dbPath, query, { timeout: 10000 });
    });
    const hasMore = events.length > safeLimit;
    const limitedEvents = events.slice(0, safeLimit);
    return { events: limitedEvents, showing: limitedEvents.length, hasMore };
  } catch (e) {
    console.error("Error getting upcoming events:", e.message);
    return { events: [], showing: 0, hasMore: false, error: e.message };
  }
}

export function localDayToMacBounds(startMs, endMs) {
  const startMac = Math.floor(Number(startMs) / 1000) - MAC_ABSOLUTE_EPOCH;
  const endMac = Math.floor(Number(endMs) / 1000) - MAC_ABSOLUTE_EPOCH;
  if (!Number.isFinite(startMac) || !Number.isFinite(endMac)) {
    throw new Error("Invalid date bounds");
  }
  return { startMac, endMac };
}

export function buildEventsOnDateQuery(startMac, endMac, { includeUid = true } = {}) {
  const startBound = Math.floor(Number(startMac));
  const endBound = Math.floor(Number(endMac));
  if (!Number.isFinite(startBound) || !Number.isFinite(endBound)) {
    throw new Error("Invalid Mac Absolute Time bounds");
  }
  const timedStart = "COALESCE(oc.occurrence_end_date - (ci.end_date - ci.start_date), ci.start_date)";
  const occEnd = "COALESCE(oc.occurrence_end_date, ci.end_date)";
  const allDayStartDate = `date(${occEnd} + 978307200, 'unixepoch', 'localtime', '-' || (CAST(round((ci.end_date - ci.start_date) / 86400.0) AS INTEGER) - 1) || ' days')`;
  const allDayStartMac = `CAST(strftime('%s', ${allDayStartDate} || ' 00:00:00', 'utc') AS INTEGER) - 978307200`;
  return `
      SELECT DISTINCT
        ci.ROWID as itemId,
        ${includeUid ? "ci.unique_identifier as uid," : "'' as uid,"}
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

function copyCalendarDb() {
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDb = path.join("/tmp", `${CALENDAR_TMP_PREFIX}${id}.sqlitedb`);
  const files = [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`];
  const cleanup = () => {
    for (const file of files) {
      try {
        fs.unlinkSync(file);
      } catch {
      }
    }
  };
  try {
    if (!fs.existsSync(CALENDAR_DB)) {
      throw new Error("Calendar database not found");
    }
    fs.copyFileSync(CALENDAR_DB, tmpDb);
    if (fs.existsSync(`${CALENDAR_DB}-wal`)) {
      fs.copyFileSync(`${CALENDAR_DB}-wal`, files[1]);
    }
    if (fs.existsSync(`${CALENDAR_DB}-shm`)) {
      fs.copyFileSync(`${CALENDAR_DB}-shm`, files[2]);
    }
  } catch (e) {
    cleanup();
    throw e;
  }
  return { tmpDb, cleanup };
}

async function withCalendarCopyAsync(fn) {
  const { tmpDb, cleanup } = copyCalendarDb();
  try {
    return await fn(tmpDb);
  } finally {
    cleanup();
  }
}

function withCalendarCopy(fn) {
  const { tmpDb, cleanup } = copyCalendarDb();
  try {
    return fn(tmpDb);
  } finally {
    cleanup();
  }
}

export function getEventsOnDate(startMs, endMs) {
  try {
    if (!fs.existsSync(CALENDAR_DB)) {
      return { events: [], error: "Calendar database not found" };
    }
    const { startMac, endMac } = localDayToMacBounds(startMs, endMs);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const query = buildEventsOnDateQuery(startMac, endMac, { includeUid: attempt === 0 });
      try {
        const events = withCalendarCopy((dbPath) => {
          assertOccurrenceCache(dbPath);
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


export function getUnreadCount(mailbox = null) {
  try {
    let script;

    if (mailbox) {
      const validatedMailbox = validateMailboxName(mailbox);
      if (!validatedMailbox) {
        return { unreadCount: 0, mailbox, error: "Invalid mailbox name. Only alphanumeric characters, spaces, hyphens, underscores, and periods are allowed." };
      }

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

export function getWeekEvents(weekOffset = 0) {
  try {
    const now = new Date();
    const monday = new Date(now);
    const day = now.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    monday.setDate(now.getDate() + diff + (weekOffset * 7));
    monday.setHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);

    const startMac = Math.floor(monday.getTime() / 1000) - 978307200;
    const endMac = Math.floor(sunday.getTime() / 1000) - 978307200;

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
    const events = withCalendarCopy((dbPath) => {
      return safeSqlite3Json(dbPath, query, { timeout: 15000 });
    });

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


export async function getEmailThread(filePath, limit = 20) {
  await initDB();
  if (!tables.emails) return { error: indexUnavailableMessage("emails"), emails: [] };

  try {
    let validatedPath;
    try {
      validatedPath = validateEmailPath(filePath, MAIL_DIR);
    } catch (e) {
      return { error: `Invalid file path: ${e.message}`, emails: [] };
    }

    if (!fs.existsSync(validatedPath)) {
      return { error: "Email file not found", emails: [] };
    }

    const content = unfoldRfc822Headers(fs.readFileSync(validatedPath, "utf-8"));
    const subjectMatch = content.match(/^Subject:\s*(.+)$/m);
    if (!subjectMatch) {
      return { error: "Could not extract subject from email", emails: [] };
    }

    const baseSubject = stripSubjectPrefixes(subjectMatch[1]);

    if (baseSubject.length < 5) {
      return { error: "Subject too short to find thread", emails: [] };
    }

    const allEmails = await tables.emails.query()
      .select(["filePath", "from", "to", "subject", "date", "dateTimestamp"])
      .toArray();

    const threadEmails = allEmails
      .filter(e => {
        const eBaseSubject = stripSubjectPrefixes(e.subject || "");
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

export function buildRecurringEventsQuery(dayStartMac, fetchLimit) {
  return `
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
      WHERE oc.day >= ${dayStartMac}
        AND ci.summary IS NOT NULL AND ci.summary <> ''
      GROUP BY ci.ROWID, ci.summary, c.title, ci.all_day
      ORDER BY occurrenceCount DESC, MIN(oc.day) ASC
      LIMIT ${fetchLimit}
    `;
}

export function getRecurringEvents(limit = 20) {
  try {
    const safeLimit = validateLimit(limit, 20, 100);
    const fetchLimit = safeLimit + 1;
    const query = buildRecurringEventsQuery(localTodayStartMac(), fetchLimit);
    const events = withCalendarCopy((dbPath) => {
      return safeSqlite3Json(dbPath, query, { timeout: 30000 });
    });
    const hasMore = events.length > safeLimit;
    const limitedEvents = events.slice(0, safeLimit);
    return { events: limitedEvents, showing: limitedEvents.length, hasMore };
  } catch (e) {
    console.error("Error getting recurring events:", e.message);
    return { events: [], showing: 0, hasMore: false, error: e.message };
  }
}
