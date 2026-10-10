/**
 * mail_links: the links in one message, decoded, by its Envelope Index id.
 *
 * mail_read strips HTML, which drops every link target, and it reads the
 * .emlx without MIME decoding, so a quoted-printable URL comes back broken
 * across soft line breaks. Sign-in emails (magic links, confirm links) put
 * the one thing a caller needs behind an <a href>. This reads the message
 * file Mail keeps for the id mail_find returns, decodes its MIME parts
 * (multipart, quoted-printable, base64, charset), and returns each http(s)
 * link with its visible text.
 *
 * Read-only. Needs the same Full Disk Access as mail_find and the indexer.
 */

import fs from "fs";
import path from "path";
import { envelopeIndexPath, parseMailboxUrl, ENVELOPE_INDEX_ACCESS_GUIDANCE } from "./mailFind.js";
import { safeSqlite3Json } from "./shell.js";
import { stripHtmlTags } from "./validators.js";

export const MAIL_LINKS_MAX = 200;
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const MAX_HTML_CHARS = 2_000_000;
const MAX_MIME_DEPTH = 8;

/** The RFC822 bytes inside an .emlx (first line is the byte count; a plist trails the message). */
export function emlxMessageBytes(buf) {
  const nl = buf.indexOf(0x0a);
  const count = nl > 0 ? Number.parseInt(buf.subarray(0, nl).toString("ascii").trim(), 10) : NaN;
  if (!Number.isFinite(count) || count <= 0) return buf;
  return buf.subarray(nl + 1, Math.min(buf.length, nl + 1 + count));
}

function splitHeaderBody(buf) {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return [buf.subarray(0, crlf).toString("latin1"), buf.subarray(crlf + 4)];
  if (lf >= 0) return [buf.subarray(0, lf).toString("latin1"), buf.subarray(lf + 2)];
  return [buf.toString("latin1"), Buffer.alloc(0)];
}

function parseHeaders(text) {
  const headers = new Map();
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

/** `text/html; charset="utf-8"` → { type: "text/html", params: { charset: "utf-8" } } */
export function parseContentType(value) {
  const [type, ...rest] = String(value || "text/plain").split(";");
  const params = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i > 0) params[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { type: type.trim().toLowerCase(), params };
}

export function decodeQuotedPrintable(buf) {
  const s = buf.toString("latin1").replace(/=\r?\n/g, "");
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      out[n++] = Number.parseInt(s.slice(i + 1, i + 3), 16);
      i += 2;
    } else {
      out[n++] = s.charCodeAt(i) & 0xff;
    }
  }
  return out.subarray(0, n);
}

function decodeText(buf, encoding, charset) {
  const enc = String(encoding || "").toLowerCase();
  const bytes =
    enc === "quoted-printable"
      ? decodeQuotedPrintable(buf)
      : enc === "base64"
        ? Buffer.from(buf.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
        : buf;
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Text leaves of a MIME message: [{ type, text }] for text/html and text/plain parts. */
export function mimeTextParts(buf, depth = 0) {
  const [headerText, body] = splitHeaderBody(buf);
  const headers = parseHeaders(headerText);
  const { type, params } = parseContentType(headers.get("content-type"));
  if (type.startsWith("multipart/") && params.boundary && depth < MAX_MIME_DEPTH) {
    const marker = Buffer.from(`--${params.boundary}`, "latin1");
    const parts = [];
    let start = body.indexOf(marker);
    while (start >= 0) {
      const afterMarker = start + marker.length;
      if (body.subarray(afterMarker, afterMarker + 2).toString("latin1") === "--") break;
      const next = body.indexOf(marker, afterMarker);
      let chunk = body.subarray(afterMarker, next >= 0 ? next : body.length);
      chunk = chunk.subarray(chunk[0] === 0x0d && chunk[1] === 0x0a ? 2 : chunk[0] === 0x0a ? 1 : 0);
      parts.push(...mimeTextParts(chunk, depth + 1));
      start = next;
    }
    return parts;
  }
  if (type !== "text/html" && type !== "text/plain") return [];
  return [{ type, text: decodeText(body, headers.get("content-transfer-encoding"), params.charset) }];
}

export function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCodePoint(Number.parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});/g, (_, d) => safeCodePoint(Number.parseInt(d, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
}

function safeCodePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}

function isHttpUrl(url) {
  return /^https?:\/\/[^\s]+$/i.test(url);
}

function attrValue(tag, name) {
  const lower = tag.toLowerCase();
  let from = 0;
  for (;;) {
    const i = lower.indexOf(name, from);
    if (i < 0) return null;
    from = i + name.length;
    if (i > 0 && !/\s/.test(tag[i - 1])) continue;
    let j = from;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    if (tag[j] !== "=") continue;
    j++;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    const q = tag[j];
    if (q === '"' || q === "'") {
      const end = tag.indexOf(q, j + 1);
      return end < 0 ? null : tag.slice(j + 1, end);
    }
    let end = j;
    while (end < tag.length && !/[\s>]/.test(tag[end])) end++;
    return tag.slice(j, end);
  }
}

/** <a href> links in HTML as { text, url }, scanned without regex backtracking. */
export function htmlLinks(html) {
  const s = String(html || "").slice(0, MAX_HTML_CHARS);
  const lower = s.toLowerCase();
  const links = [];
  let pos = 0;
  while (links.length < MAIL_LINKS_MAX) {
    const open = lower.indexOf("<a", pos);
    if (open < 0) break;
    pos = open + 2;
    if (!/[\s>]/.test(s[open + 2] || "")) continue;
    let tagEnd = open + 2;
    let quote = null;
    for (; tagEnd < s.length; tagEnd++) {
      const c = s[tagEnd];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
    if (tagEnd >= s.length) break;
    const close = lower.indexOf("</a", tagEnd);
    const nextOpen = lower.indexOf("<a", tagEnd);
    // An unclosed anchor's text runs to the next anchor (or the end).
    const textEnd = close >= 0 && (nextOpen < 0 || close < nextOpen) ? close : nextOpen >= 0 ? nextOpen : s.length;
    const inner = s.slice(tagEnd + 1, textEnd);
    pos = textEnd === close ? close + 3 : textEnd;
    const href = attrValue(s.slice(open, tagEnd), "href");
    const url = href == null ? "" : decodeHtmlEntities(href.trim());
    if (!isHttpUrl(url)) continue;
    links.push({ text: decodeHtmlEntities(stripHtmlTags(inner)).replace(/\s+/g, " ").trim(), url });
  }
  return links;
}

/** Bare http(s) URLs in plain text. */
export function textLinks(text) {
  const found = String(text || "").slice(0, MAX_HTML_CHARS).match(/https?:\/\/[^\s<>"'`)\]]+/g) || [];
  return found.slice(0, MAIL_LINKS_MAX).map((url) => ({ text: "", url: url.replace(/[.,;:!?]+$/, "") }));
}

/** Links from a decoded message: HTML anchors first, then plain-text URLs not already listed. */
export function messageLinks(rfc822) {
  const parts = mimeTextParts(rfc822);
  const links = [];
  const seen = new Set();
  const add = (l) => {
    if (links.length >= MAIL_LINKS_MAX || seen.has(`${l.text}\n${l.url}`)) return;
    seen.add(`${l.text}\n${l.url}`);
    links.push(l);
  };
  for (const p of parts) if (p.type === "text/html") htmlLinks(p.text).forEach(add);
  const urls = new Set(links.map((l) => l.url));
  for (const p of parts) if (p.type === "text/plain") textLinks(p.text).filter((l) => !urls.has(l.url)).forEach(add);
  return links;
}

/** Mail's sharded folder for a message id: 73690 → Data/3/7/Messages (digits of id/1000, reversed). */
export function messageDataDir(id) {
  const thousands = Math.floor(id / 1000);
  const shards = thousands > 0 ? String(thousands).split("").reverse() : [];
  return path.join("Data", ...shards, "Messages");
}

/**
 * Where Mail keeps `id`'s message file for mailbox `mailboxUrl`.
 * `file` is the .emlx (or .partial.emlx) path, or null. `mailboxFound` says
 * whether the mailbox folder itself was found, so a caller can tell "not
 * saved yet" (worth retrying) from "cannot locate this mailbox" (not).
 * Account mailboxes live under V<n>/<account id>/; On My Mac mailboxes
 * without an account id live under V<n>/Mailboxes/.
 */
export function locateEmlx(id, mailboxUrl, { indexPath } = {}) {
  const box = parseMailboxUrl(mailboxUrl);
  const db = indexPath || envelopeIndexPath();
  if (!box || !db) return { file: null, mailboxFound: false };
  const versionDir = path.dirname(path.dirname(db));
  const base = box.accountId ? path.join(versionDir, box.accountId) : path.join(versionDir, "Mailboxes");
  const segments = box.mailboxPath.split("/").filter(Boolean);
  if (!segments.length || segments.some((p) => p === "." || p === "..")) return { file: null, mailboxFound: false };
  const mboxDir = path.join(base, ...segments.map((p) => `${p}.mbox`));
  let stores;
  try {
    stores = fs.readdirSync(mboxDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.endsWith(".mbox"));
  } catch {
    return { file: null, mailboxFound: false };
  }
  const rel = messageDataDir(id);
  for (const store of stores) {
    for (const name of [`${id}.emlx`, `${id}.partial.emlx`]) {
      const file = path.join(mboxDir, store.name, rel, name);
      if (fs.existsSync(file)) return { file, mailboxFound: true };
    }
  }
  return { file: null, mailboxFound: true };
}

export function validateLinksArgs(args = {}) {
  const id = Number(args.id);
  if (!Number.isInteger(id) || id <= 0 || id > 1e12) return { error: "id must be a positive integer (the id from mail_find)" };
  return { id };
}

/** mail_links tool entry point. Returns JSON text; throws on invalid args or an unreadable index. */
export function mailLinks(args = {}, { query = safeSqlite3Json, indexPath, readFile = fs.readFileSync, locate = locateEmlx } = {}) {
  const { id, error } = validateLinksArgs(args);
  if (error) throw new Error(`mail_links: ${error}`);
  const db = indexPath || envelopeIndexPath();
  if (!db) throw new Error(ENVELOPE_INDEX_ACCESS_GUIDANCE);
  let rows;
  try {
    rows = query(db, `SELECT m.ROWID AS id, mb.url AS mailbox_url FROM messages m JOIN mailboxes mb ON mb.ROWID = m.mailbox WHERE m.ROWID = ${id}`, {
      readonly: true,
      timeout: 20000
    });
  } catch (e) {
    if (/unable to open|authoriz|not permitted|denied/i.test(String((e && e.message) || e))) throw new Error(ENVELOPE_INDEX_ACCESS_GUIDANCE);
    throw e;
  }
  if (!rows.length) return JSON.stringify({ id, found: false, note: "No message with that id in Mail's database." }, null, 2);
  const { file, mailboxFound } = locate(id, rows[0].mailbox_url, { indexPath: db });
  if (!file && !mailboxFound) {
    return JSON.stringify({ id, found: true, located: false, note: "Could not find this message's mailbox folder in Mail's data; retrying will not help." }, null, 2);
  }
  if (!file) {
    return JSON.stringify({ id, found: true, downloaded: false, note: "Mail has not saved this message's file yet; try again shortly." }, null, 2);
  }
  const buf = readFile(file);
  if (buf.length > MAX_MESSAGE_BYTES) throw new Error("mail_links: message file is too large to read");
  const links = messageLinks(emlxMessageBytes(buf));
  return JSON.stringify({ id, found: true, downloaded: true, count: links.length, links }, null, 2);
}
