/**
 * AppleScript execution helpers for the write tools.
 *
 * Scripts are always built from escaped literals (never string-concatenated
 * shell) and run through `safeOsascript` (`spawnSync`, `shell: false`).
 *
 * This module also classifies macOS TCC (privacy) denials. TCC attributes an
 * Apple event to the *responsible process*, which for a stdio MCP server is
 * the app that launched node - not node itself. A host app without the
 * Contacts/Calendars entitlements therefore makes the child's Apple events
 * fail no matter what permissions node has. `lib/writeRouting.js` uses this
 * classification to hand the work to the launchd-started indexer daemon,
 * where node is the responsible process.
 */

import { safeOsascript } from "./shell.js";
import { escapeAppleScript } from "./validators.js";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;

// Sentinels raised by our scripts so callers can map them to clean errors
// instead of surfacing raw AppleScript text.
export const NOT_FOUND_SENTINELS = [
  "MESSAGE_NOT_FOUND",
  "EVENT_NOT_FOUND",
  "CONTACT_NOT_FOUND",
  "CALENDAR_NOT_FOUND",
  "CHAT_NOT_FOUND",
  "ARCHIVE_MAILBOX_NOT_FOUND",
  "ATTENDEE_NOT_FOUND",
  "RSVP_NOT_SUPPORTED"
];

// osascript / TCC denial signatures. Apple reports these as Apple event
// errors (-1743, -10004) or as "not permitted" / "not authorized" text.
const TCC_SIGNATURES = [
  "-1743",
  "-10004",
  "-25211",
  "not authorized to send apple events",
  "not allowed to send apple events",
  "is not allowed assistive access",
  "operation not permitted",
  "not permitted to access",
  "access to contacts",
  "access to calendars",
  "privacy settings",
  "errae eventnotpermitted",
  "errAEEventNotPermitted".toLowerCase()
];

const APP_MISSING_SIGNATURES = [
  "application isn't running",
  "can't get application",
  "application is not running",
  "-600",
  "-1728"
];

/**
 * @param {string} message
 * @returns {"tcc"|"not_found"|"app_unavailable"|"unknown"}
 */
export function classifyAppleScriptError(message) {
  const text = String(message || "").toLowerCase();
  for (const sentinel of NOT_FOUND_SENTINELS) {
    if (text.includes(sentinel.toLowerCase())) return "not_found";
  }
  if (TCC_SIGNATURES.some((sig) => text.includes(sig))) return "tcc";
  if (APP_MISSING_SIGNATURES.some((sig) => text.includes(sig))) return "app_unavailable";
  return "unknown";
}

export function isTccDenial(message) {
  return classifyAppleScriptError(message) === "tcc";
}

/**
 * Guidance attached to TCC denials. Names the host constraint without
 * claiming the package can grant another app's entitlements.
 */
export const TCC_GUIDANCE =
  "macOS denied this automation. TCC attributes Apple events to the process responsible for the MCP server, " +
  "so a host app without the Contacts/Calendar automation entitlement blocks the write even when node has Full Disk Access. " +
  "Run the indexer daemon (apple-tools-indexer / the LaunchAgent) so writes execute under node, or run this server from a host that can be granted Automation access.";

/**
 * Run a script and normalize the result.
 * @returns {{ ok: boolean, output: string, error: string|null, kind: string|null }}
 */
export function runAppleScript(script, options = {}) {
  const { timeout = DEFAULT_SCRIPT_TIMEOUT_MS } = options;
  try {
    const output = safeOsascript(script, { timeout });
    return { ok: true, output: (output || "").trim(), error: null, kind: null };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    return { ok: false, output: "", error: message, kind: classifyAppleScriptError(message) };
  }
}

/**
 * Quote a value as an AppleScript string literal.
 */
export function asString(value) {
  return `"${escapeAppleScript(value === undefined || value === null ? "" : String(value))}"`;
}

/**
 * Emit a validated integer. Throws rather than interpolating unchecked input.
 */
export function asInteger(value, { min = -2147483648, max = 2147483647, field = "value" } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return String(n);
}

export function asBoolean(value) {
  return value ? "true" : "false";
}

/**
 * AppleScript handler that builds a local `date` from validated integers.
 * Day is reset to 1 first so setting month never rolls the date forward
 * (e.g. Jan 31 -> "Feb 31").
 */
export const DATE_HANDLER = `on atmMakeDate(y, mo, d, hh, mi)
  set dt to current date
  set day of dt to 1
  set year of dt to y
  set month of dt to mo
  set day of dt to d
  set hours of dt to hh
  set minutes of dt to mi
  set seconds of dt to 0
  return dt
end atmMakeDate`;

/**
 * Build the `atmMakeDate(...)` call for a parsed date.
 * @param {{year:number,month:number,day:number,hour:number,minute:number}} parts
 */
export function dateCall(parts) {
  return `atmMakeDate(${asInteger(parts.year, { min: 1970, max: 2200, field: "year" })}, ` +
    `${asInteger(parts.month, { min: 1, max: 12, field: "month" })}, ` +
    `${asInteger(parts.day, { min: 1, max: 31, field: "day" })}, ` +
    `${asInteger(parts.hour, { min: 0, max: 23, field: "hour" })}, ` +
    `${asInteger(parts.minute, { min: 0, max: 59, field: "minute" })})`;
}

/**
 * Strict datetime parsing for writes.
 *
 * Writes never guess: only explicit local datetimes are accepted, so an agent
 * cannot silently schedule "next tuesday" against the wrong day.
 * Accepted: "YYYY-MM-DD", "YYYY-MM-DD HH:MM", "YYYY-MM-DDTHH:MM[:SS]".
 *
 * @returns {{ parts: object|null, error: string|null, dateOnly: boolean }}
 */
export function parseWriteDateTime(value, field = "start") {
  if (typeof value !== "string" || value.trim() === "") {
    return { parts: null, error: `${field} is required (use YYYY-MM-DD HH:MM local time)`, dateOnly: false };
  }
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (!match) {
    return {
      parts: null,
      error: `${field} must be an explicit local datetime such as 2026-09-20 14:30 (YYYY-MM-DD or YYYY-MM-DD HH:MM). Natural language is not accepted for writes.`,
      dateOnly: false
    };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dateOnly = match[4] === undefined;
  const hour = dateOnly ? 0 : Number(match[4]);
  const minute = dateOnly ? 0 : Number(match[5]);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { parts: null, error: `${field} is not a valid date/time: ${trimmed}`, dateOnly };
  }
  // Reject impossible calendar days (e.g. 2026-02-31).
  const probe = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return { parts: null, error: `${field} is not a valid calendar date: ${trimmed}`, dateOnly };
  }

  return { parts: { year, month, day, hour, minute, iso: trimmed }, error: null, dateOnly };
}
