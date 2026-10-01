/**
 * Exact mail lookup against Mail's own Envelope Index (no vector index).
 *
 * mail_find answers "which messages match these exact facts" (subject
 * prefix, sender, recipient, mailbox, date) and bulk mail_trash uses
 * locateMessageCopies() to address every copy of a Message-ID by Mail's
 * internal id. A message's AppleScript `id` is its Envelope Index ROWID, so
 * `messages of <one mailbox> whose id is N` resolves in about 2s even on a
 * 60k-message INBOX, where `whose message id is X` across every mailbox
 * takes 30-38s (see MAIL_FIND_TIMEOUT_MS in mailWrite.js).
 *
 * Read-only: sqlite3 opens the database with -readonly and Mail stays its
 * only writer. Needs the same Full Disk Access as the .emlx indexer.
 */

import fs from "fs";
import path from "path";
import { safeSqlite3Json } from "./shell.js";
import { normalizeList, validateMessageId } from "./writeGuards.js";

const MAIL_DIR = path.join(process.env.HOME || "", "Library", "Mail");

export const MAIL_FIND_DEFAULT_LIMIT = 50;
export const MAIL_FIND_MAX_LIMIT = 500;
export const MAIL_FIND_MAX_IDS = 500;
const MAX_TEXT_FILTER = 300;
const MAX_COPIES = 5000;

/** Mailbox leaf names per kind, as Mail names them across iCloud, IMAP, Exchange and Gmail. */
export const MAILBOX_KIND_LEAVES = {
  inbox: ["INBOX"],
  sent: ["Sent Messages", "Sent", "Sent Items", "Sent Mail"],
  trash: ["Deleted Messages", "Trash", "Bin", "Deleted Items"],
  junk: ["Junk", "Junk E-mail", "Spam"],
  drafts: ["Drafts"],
  archive: ["Archive", "All Mail"]
};
export const MAILBOX_KINDS = Object.keys(MAILBOX_KIND_LEAVES);
export const TRASH_MAILBOX_NAMES = MAILBOX_KIND_LEAVES.trash;

const ACCOUNT_ID_RE = /^[0-9A-Fa-f-]{8,64}$/;
const ADDRESS_RE = /^[^\s@'"]{1,200}@[^\s@'"]{1,200}$/;

export const ENVELOPE_INDEX_ACCESS_GUIDANCE =
  "Mail's Envelope Index could not be read. Give the node binary that runs Apple Tools Full Disk Access " +
  "(System Settings → Privacy & Security → Full Disk Access), and make sure Mail has been set up on this Mac.";

/**
 * Newest `~/Library/Mail/V<n>/MailData/Envelope Index`, or null.
 */
export function envelopeIndexPath(mailDir = MAIL_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(mailDir);
  } catch {
    return null;
  }
  const versions = entries
    .map((name) => /^V(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => b - a);
  for (const v of versions) {
    const candidate = path.join(mailDir, `V${v}`, "MailData", "Envelope Index");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * `imap://<account uuid>/Sent%20Messages` → account id + decoded mailbox path.
 * Local ("On My Mac") mailboxes have no account id and cannot be addressed
 * by `account id` in AppleScript.
 */
export function parseMailboxUrl(url) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)\/(.+)$/i.exec(String(url || ""));
  if (!m) return null;
  let mailboxPath;
  try {
    mailboxPath = m[3].split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return null;
  }
  const accountId = ACCOUNT_ID_RE.test(m[2]) ? m[2] : null;
  return { scheme: m[1].toLowerCase(), accountId, mailboxPath };
}

export function mailboxKind(mailboxPath) {
  const leaf = String(mailboxPath || "").split("/").pop().toLowerCase();
  for (const [kind, leaves] of Object.entries(MAILBOX_KIND_LEAVES)) {
    if (leaves.some((name) => name.toLowerCase() === leaf)) return kind;
  }
  return "other";
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function likeEscape(value) {
  return String(value).replace(/[\\%_]/g, (c) => `\\${c}`);
}

function likeClause(expr, pattern) {
  return `${expr} LIKE ${sqlLiteral(pattern)} ESCAPE '\\'`;
}

/** SQL condition: mailbox URL `column` ends in one of `kind`'s leaf names. */
export function mailboxKindCondition(kind, column = "mb.url") {
  const leaves = MAILBOX_KIND_LEAVES[kind] || [];
  return `(${leaves.map((leaf) => likeClause(column, `%/${likeEscape(encodeURIComponent(leaf))}`)).join(" OR ")})`;
}

function cleanText(value, field) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: `${field} must be a string` };
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return { value: null };
  if (trimmed.length > MAX_TEXT_FILTER) return { error: `${field} is longer than ${MAX_TEXT_FILTER} characters` };
  return { value: trimmed };
}

function cleanAddress(value, field) {
  const text = cleanText(value, field);
  if (text.error || !text.value) return text;
  if (!ADDRESS_RE.test(text.value)) return { error: `${field} must be one email address` };
  return { value: text.value.toLowerCase() };
}

function parseTime(value, field) {
  if (value === undefined || value === null || value === "") return { value: null };
  const ms = typeof value === "number" ? value * 1000 : Date.parse(String(value));
  if (!Number.isFinite(ms)) return { error: `${field} must be an ISO 8601 date/time` };
  return { value: Math.floor(ms / 1000) };
}

/**
 * Validate mail_find arguments into SQL-ready filters.
 * @returns {{ filters?: object, error?: string }}
 */
export function validateFindArgs(args = {}, { now = Date.now() } = {}) {
  const f = {};
  for (const [key, field] of [["subjectPrefix", "subject_prefix"], ["subjectContains", "subject_contains"]]) {
    const r = cleanText(args[field], field);
    if (r.error) return { error: r.error };
    f[key] = r.value;
  }
  for (const [key, field] of [["from", "from"], ["to", "to"]]) {
    const r = cleanAddress(args[field], field);
    if (r.error) return { error: r.error };
    f[key] = r.value;
  }
  f.toOnly = args.to_only === true || args.to_only === "true";
  if (f.toOnly && !f.to) return { error: "to_only needs to" };
  f.fromMe = args.from_me === true || args.from_me === "true";

  const ids = normalizeList(args.message_ids);
  if (ids.length > MAIL_FIND_MAX_IDS) return { error: `message_ids accepts at most ${MAIL_FIND_MAX_IDS} ids` };
  f.messageIds = [];
  for (const raw of ids) {
    const id = validateMessageId(raw);
    if (!id) return { error: "message_ids contains an invalid RFC822 Message-ID" };
    f.messageIds.push(id);
  }

  const mailboxes = normalizeList(args.mailboxes).map((m) => m.toLowerCase());
  const unknown = mailboxes.filter((m) => !MAILBOX_KINDS.includes(m));
  if (unknown.length) return { error: `mailboxes must be from: ${MAILBOX_KINDS.join(", ")}` };
  f.mailboxes = mailboxes;
  f.includeTrash = args.include_trash === true || args.include_trash === "true";

  const after = parseTime(args.received_after, "received_after");
  if (after.error) return { error: after.error };
  const before = parseTime(args.received_before, "received_before");
  if (before.error) return { error: before.error };
  f.receivedAfter = after.value;
  f.receivedBefore = before.value;
  if (args.older_than_hours !== undefined && args.older_than_hours !== null && args.older_than_hours !== "") {
    const hours = Number(args.older_than_hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365 * 20) {
      return { error: "older_than_hours must be a number of hours (0 or more)" };
    }
    const cutoff = Math.floor(now / 1000 - hours * 3600);
    f.receivedBefore = f.receivedBefore === null ? cutoff : Math.min(f.receivedBefore, cutoff);
  }

  if (!f.subjectPrefix && !f.subjectContains && !f.from && !f.to && f.messageIds.length === 0) {
    return { error: "add at least one of subject_prefix, subject_contains, from, to, or message_ids" };
  }

  const limit = args.limit === undefined || args.limit === null ? MAIL_FIND_DEFAULT_LIMIT : Number(args.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAIL_FIND_MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAIL_FIND_MAX_LIMIT}` };
  }
  f.limit = limit;
  return { filters: f };
}

const SUBJECT_EXPR = "(coalesce(m.subject_prefix, '') || s.subject)";

/** Build the Envelope Index query for validated filters. Selects limit+1 rows to detect truncation. */
export function buildFindQuery(f) {
  const where = ["m.deleted = 0"];
  if (f.subjectPrefix) where.push(likeClause(SUBJECT_EXPR, `${likeEscape(f.subjectPrefix)}%`));
  if (f.subjectContains) where.push(likeClause(SUBJECT_EXPR, `%${likeEscape(f.subjectContains)}%`));
  if (f.from) where.push(`lower(a.address) = ${sqlLiteral(f.from)}`);
  if (f.to) {
    where.push(
      `EXISTS (SELECT 1 FROM recipients r JOIN addresses ra ON ra.ROWID = r.address WHERE r.message = m.ROWID AND lower(ra.address) = ${sqlLiteral(f.to)})`
    );
    if (f.toOnly) where.push("(SELECT count(*) FROM recipients r WHERE r.message = m.ROWID) = 1");
  }
  if (f.fromMe) {
    // "Me" = any address that appears as the sender of a message in a Sent mailbox.
    where.push(
      `m.sender IN (SELECT DISTINCT m2.sender FROM messages m2 JOIN mailboxes mb2 ON mb2.ROWID = m2.mailbox WHERE m2.sender IS NOT NULL AND ${mailboxKindCondition("sent", "mb2.url")})`
    );
  }
  if (f.messageIds.length) {
    where.push(`g.message_id_header IN (${f.messageIds.map((id) => sqlLiteral(`<${id}>`)).join(", ")})`);
  }
  if (f.receivedAfter !== null) where.push(`m.date_received >= ${Math.floor(f.receivedAfter)}`);
  if (f.receivedBefore !== null) where.push(`m.date_received < ${Math.floor(f.receivedBefore)}`);
  if (f.mailboxes.length) {
    where.push(`(${f.mailboxes.map((kind) => mailboxKindCondition(kind)).join(" OR ")})`);
  } else if (!f.includeTrash) {
    where.push(`NOT ${mailboxKindCondition("trash")}`);
  }

  return `SELECT m.ROWID AS id, g.message_id_header AS message_id, ${SUBJECT_EXPR} AS subject,
    a.address AS sender, m.date_received AS received, mb.url AS mailbox_url,
    (SELECT group_concat(ra.address, ',') FROM recipients r JOIN addresses ra ON ra.ROWID = r.address WHERE r.message = m.ROWID) AS recipients
  FROM messages m
  JOIN subjects s ON s.ROWID = m.subject
  JOIN mailboxes mb ON mb.ROWID = m.mailbox
  LEFT JOIN addresses a ON a.ROWID = m.sender
  LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id
  WHERE ${where.join("\n    AND ")}
  ORDER BY m.date_received DESC, m.ROWID DESC
  LIMIT ${f.limit + 1}`;
}

function mapRow(row) {
  const box = parseMailboxUrl(row.mailbox_url) || { accountId: null, mailboxPath: String(row.mailbox_url || "") };
  return {
    id: row.id,
    message_id: row.message_id ? String(row.message_id).replace(/^</, "").replace(/>$/, "") : null,
    subject: row.subject || "",
    from: row.sender || null,
    to: row.recipients ? String(row.recipients).split(",") : [],
    received: Number.isFinite(row.received) ? new Date(row.received * 1000).toISOString() : null,
    mailbox: mailboxKind(box.mailboxPath),
    mailbox_path: box.mailboxPath,
    account_id: box.accountId
  };
}

function runQuery(sql, { dbPath, query = safeSqlite3Json } = {}) {
  const db = dbPath || envelopeIndexPath();
  if (!db) throw new Error(ENVELOPE_INDEX_ACCESS_GUIDANCE);
  try {
    return query(db, sql, { readonly: true, timeout: 20000 });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/unable to open|authoriz|not permitted|denied/i.test(msg)) throw new Error(ENVELOPE_INDEX_ACCESS_GUIDANCE);
    throw e;
  }
}

/**
 * Exact lookup. Every copy is its own row (the same Message-ID in INBOX and
 * Sent shows twice).
 * @returns {{ messages: object[], truncated: boolean }}
 */
export function findMail(filters, options = {}) {
  const rows = runQuery(buildFindQuery(filters), options);
  const truncated = rows.length > filters.limit;
  return { messages: rows.slice(0, filters.limit).map(mapRow), truncated };
}

/**
 * Every live copy of each Message-ID, split into copies outside Trash (to
 * move) and the ids that have no such copy (already trashed or not in Mail).
 */
export function locateMessageCopies(messageIds, options = {}) {
  const filters = {
    subjectPrefix: null,
    subjectContains: null,
    from: null,
    to: null,
    toOnly: false,
    fromMe: false,
    messageIds,
    mailboxes: [],
    includeTrash: false,
    receivedAfter: null,
    receivedBefore: null,
    limit: MAX_COPIES
  };
  const { messages } = findMail(filters, options);
  const found = new Set(messages.map((m) => m.message_id));
  return { copies: messages, missingIds: messageIds.filter((id) => !found.has(id)) };
}

export function formatFindResult({ messages, truncated }) {
  return JSON.stringify(
    {
      count: messages.length,
      truncated,
      note: truncated ? "More messages match; raise limit or narrow the filters." : undefined,
      messages
    },
    null,
    2
  );
}

/** mail_find tool entry point. Returns text; throws on invalid args or an unreadable index. */
export function mailFind(args = {}, options = {}) {
  const { filters, error } = validateFindArgs(args, options);
  if (error) throw new Error(`mail_find: ${error}`);
  return formatFindResult(findMail(filters, options));
}
