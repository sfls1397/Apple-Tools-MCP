
import fs from "fs";
import { safeOsascript } from "./shell.js";
import { escapeAppleScript } from "./validators.js";

export const DEFAULT_SCRIPT_TIMEOUT_MS = 30000;

export const NOT_FOUND_SENTINELS = [
  "MESSAGE_NOT_FOUND",
  "EVENT_NOT_FOUND",
  "EVENTKIT_NOT_FOUND",
  "CONTACT_NOT_FOUND",
  "CALENDAR_NOT_FOUND",
  "CHAT_NOT_FOUND",
  "ARCHIVE_MAILBOX_NOT_FOUND",
  "ATTENDEE_NOT_FOUND",
  "RSVP_NOT_SUPPORTED"
];

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

const APP_NOT_RUNNING_SIGNATURES = [
  "application isn't running",
  "application is not running",
  "-600",
  "contacts_not_running"
];

const APP_MISSING_SIGNATURES = [
  "can't get application",
  "can't get every application",
  "-1728",
  "-10810"
];

const OSASCRIPT_MISSING_SIGNATURES = [
  "spawnsync osascript enoent",
  "enoent"
];

const TIMEOUT_SIGNATURES = [
  "etimedout",
  "timed out after",
  "-1712",
  "appleevent timed out",
  "apple event timed out"
];

const APP_SEARCH_DIRS = [
  "/System/Applications",
  "/Applications",
  "/System/Applications/Utilities"
];

export function appBundleInstalled(appName, existsFn = fs.existsSync) {
  if (!appName || typeof appName !== "string") return null;
  if (!/^[A-Za-z ]{1,40}$/.test(appName)) return null;
  return APP_SEARCH_DIRS.some((dir) => existsFn(`${dir}/${appName}.app`));
}

export function classifyAppleScriptError(message, context = {}) {
  const text = String(message || "").toLowerCase();
  for (const sentinel of NOT_FOUND_SENTINELS) {
    if (text.includes(sentinel.toLowerCase())) return "not_found";
  }
  if (OSASCRIPT_MISSING_SIGNATURES.some((sig) => text.includes(sig))) return "app_unavailable";
  if (TIMEOUT_SIGNATURES.some((sig) => text.includes(sig))) return "timeout";
  if (TCC_SIGNATURES.some((sig) => text.includes(sig))) return "tcc";
  if (
    text.includes("can't get event") ||
    text.includes("can't get calendar") ||
    text.includes("can't get theevent")
  ) {
    return "not_found";
  }
  if (APP_NOT_RUNNING_SIGNATURES.some((sig) => text.includes(sig))) {
    return context.appInstalled === true ? "app_not_running" : "app_unavailable";
  }
  if (APP_MISSING_SIGNATURES.some((sig) => text.includes(sig))) {
    return context.appInstalled === true ? "attribution" : "app_unavailable";
  }
  return "unknown";
}

export function isTccDenial(message) {
  return classifyAppleScriptError(message) === "tcc";
}

export function needsHostTccAdvice(message) {
  const text = String(message || "");
  if (!text) return false;
  if (text.includes(MAIL_SEND_TIMEOUT_GUIDANCE)) return false;
  if (text.includes(MAIL_GUI_SCRIPTING_GUIDANCE)) return false;
  if (text.includes(CONTACTS_APP_NOT_RUNNING_GUIDANCE)) return false;
  if (text.includes(MAIL_APP_NOT_RUNNING_GUIDANCE)) return false;
  if (text.includes(MESSAGES_APP_NOT_RUNNING_GUIDANCE)) return false;
  if (text.includes(CALENDAR_APP_NOT_RUNNING_GUIDANCE)) return false;
  if (
    text.includes(CONTACTS_TCC_GUIDANCE) ||
    text.includes(CALENDAR_TCC_GUIDANCE) ||
    text.includes(MESSAGES_TCC_GUIDANCE) ||
    text.includes(MAIL_TCC_GUIDANCE) ||
    text.includes(MAIL_ACCESSIBILITY_GUIDANCE) ||
    text.includes(ATTRIBUTION_GUIDANCE) ||
    text.includes(TCC_GUIDANCE)
  ) {
    return true;
  }
  return isTccDenial(text);
}

const HARD_TCC_SIGNATURES = [
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

export function isHardTccDenial(message) {
  const text = String(message || "").toLowerCase();
  return HARD_TCC_SIGNATURES.some((sig) => text.includes(sig));
}

const APPLEEVENT_CODES = [
  "-1743",
  "-10004",
  "-25211",
  "-1712",
  "-1728",
  "-600",
  "-10810",
  "-1708",
  "-1719",
  "-10025",
  "-2700"
];

export function extractAppleEventCodes(message) {
  const text = String(message || "");
  const found = [];
  for (const code of APPLEEVENT_CODES) {
    if (text.includes(code) && !found.includes(code)) found.push(code);
  }
  if (/etimedout/i.test(text) && !found.includes("ETIMEDOUT")) found.push("ETIMEDOUT");
  return found;
}

export function formatOsascriptDiagnostic(result, source = "osascript") {
  const raw = String(result && result.error ? result.error : "").replace(/\s+/g, " ").trim();
  const clipped = raw.length > 360 ? `${raw.slice(0, 360)}...` : raw;
  const kind = (result && result.kind) || "unknown";
  const codes = extractAppleEventCodes(raw);
  return `${source} kind=${kind} error=${clipped || "(empty)"}${codes.length ? ` codes=${codes.join(",")}` : ""}`;
}

export const TCC_GUIDANCE =
  "macOS denied this automation. TCC attributes Apple events to the process responsible for the MCP server, " +
  "so a host app without the matching automation grant blocks the write even when node has Full Disk Access.";

export const CONTACTS_TCC_GUIDANCE =
  "macOS denied Contacts access for this write. Contacts writes go through Contacts.app (CNContactStore), which is gated by the AddressBook privacy class " +
  "and attributed to the process responsible for this MCP server - not to node. A host app that was built without the AddressBook entitlement " +
  "(com.apple.security.personal-information.addressbook) is denied with no prompt, and that cannot be fixed with Full Disk Access or tccutil. " +
  "Contacts *reads* are unaffected: they query the AddressBook database directly and only need Full Disk Access.";

export const CONTACTS_APP_NOT_RUNNING_GUIDANCE =
  "Contacts.app was not running and did not become ready after launch. This is not a TCC / Automation deny (-1743 / -10004) " +
  "and not an attribution / responsible-process failure. The write path launches Contacts.app; if this persists, open Contacts.app and retry.";

export const MAIL_APP_NOT_RUNNING_GUIDANCE =
  "Mail.app was not running. Keep Mail, Messages, and Contacts running for write reliability. " +
  "This is not a TCC / Automation deny (-1743 / -10004) and not an attribution / responsible-process failure.";

export const MESSAGES_APP_NOT_RUNNING_GUIDANCE =
  "Messages.app was not running. Keep Mail, Messages, and Contacts running for write reliability. " +
  "This is not a TCC / Automation deny (-1743 / -10004) and not an attribution / responsible-process failure.";

export const CALENDAR_APP_NOT_RUNNING_GUIDANCE =
  "Calendar.app was not running. Calendar writes use EventKit and do not require Calendar.app to stay open. " +
  "This is not a TCC / Automation deny (-1743 / -10004).";

export const CALENDAR_TCC_GUIDANCE =
  "macOS denied Calendar access for this write. Calendar writes go through Calendar.app (EventKit), which is gated by the calendars privacy class " +
  "(com.apple.security.personal-information.calendars) and attributed to the process responsible for this MCP server - not to node. " +
  "A host app built without that entitlement is denied with no prompt, and Full Disk Access or tccutil cannot change it. " +
  "Calendar *reads* are unaffected: they query Calendar.sqlitedb directly and only need Full Disk Access.";

export const ATTRIBUTION_GUIDANCE =
  "The app is installed, so this is an Automation / responsible-process problem rather than a missing app: macOS refused to let the process " +
  "responsible for this server drive it.";

export const MAIL_TCC_GUIDANCE =
  "macOS denied Mail automation (Apple Events to Mail.app). Real denials report -1743, -10004, or \"not authorized to send Apple events\" — a TCC / Automation deny for node → Mail, " +
  "not Mail.app missing or unavailable. dry_run never talks to Mail, so it cannot detect this grant. " +
  "Allow node in System Settings → Privacy & Security → Automation for Mail (same Allow-via-prompt as Contacts and Calendar — do not add node via + in a privacy list). " +
  "A Contacts or Calendar grant does not include Mail.";

export const MAIL_ACCESSIBILITY_GUIDANCE =
  "macOS denied Accessibility (System Events could not drive Mail's compose window). " +
  "mail_send / mail_draft / mail_reply / mail_forward fill the body via System Events so Mail does not cite-wrap it (FB11734014); Mail's mailto command does not return an outgoing message on current Mini/MacBook Mail (-2753). " +
  "Allow node in System Settings → Privacy & Security → Accessibility, and keep Automation → Mail allowed. " +
  "This is not a Mail Automation deny (-1743 / -10004).";

export const SYSTEM_EVENTS_STICKY_DENY_GUIDANCE =
  "A prior Don't Allow for node → System Events is a sticky Deny: the Allow dialog will not appear again. " +
  "Turn System Events on for this node in System Settings → Privacy & Security → Automation, then re-run apple-tools-mcp permissions after Allow.";

export const MAIL_GUI_SCRIPTING_GUIDANCE =
  "System Events GUI scripting is unavailable for this process, so the body cannot be typed into Mail. " +
  "mail_send / mail_draft / mail_reply / mail_forward locate the compose body via System Events (title-marker + AX hit-test) so Mail does not cite-wrap the Sent body (FB11734014). " +
  "Allow node → System Events in System Settings → Privacy & Security → Automation (run apple-tools-mcp permissions after install/upgrade) in addition to node → Mail, and keep Accessibility allowed. " +
  SYSTEM_EVENTS_STICKY_DENY_GUIDANCE + " " +
  "This is not a Mail send timeout and not a Mail Automation deny (-1743 / -10004).";

export const MAIL_SEND_TIMEOUT_GUIDANCE =
  "Mail AppleScript timed out (ETIMEDOUT / -1712 / AppleEvent timed out) — this is a find/reply/send hang (including find/reply/open before send), not a TCC / Automation deny. " +
  "Real Mail Automation denials report -1743, -10004, or \"not authorized to send Apple events\". " +
  "A timeout can happen after Mail already delivered the message. Check Sent (and Outbox) for this send before retrying; a retry after a successful delivery sends a second copy. " +
  "This tool verifies Sent/Outbox when a send hangs (To + subject, Message-ID when available — never subject alone); if nothing is there yet, wait and look again rather than immediately resending.";

export const MESSAGES_TCC_GUIDANCE =
  "macOS denied Messages automation (Apple Events to Messages.app). A hang or timeout on send is a TCC / Automation deny for node → Messages, " +
  "not Messages.app missing or unavailable. dry_run never talks to Messages, so it cannot detect this grant. " +
  "Allow node in System Settings → Privacy & Security → Automation for Messages (same Allow-via-prompt as Mail, Contacts, and Calendar — do not add node via + in a privacy list). " +
  "A Contacts or Calendar grant does not include Messages.";

export function tccGuidanceFor(source) {
  if (source === "contacts") return CONTACTS_TCC_GUIDANCE;
  if (source === "calendar") return CALENDAR_TCC_GUIDANCE;
  if (source === "mail") return MAIL_TCC_GUIDANCE;
  if (source === "messages") return MESSAGES_TCC_GUIDANCE;
  return TCC_GUIDANCE;
}

export function runAppleScript(script, options = {}) {
  const { timeout = DEFAULT_SCRIPT_TIMEOUT_MS, appName = null, language = null } = options;
  try {
    const output = safeOsascript(script, { timeout, language, killSignal: "SIGKILL" });
    return { ok: true, output: (output || "").trim(), error: null, kind: null };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    return {
      ok: false,
      output: "",
      error: message,
      kind: classifyAppleScriptError(message, { appInstalled: appBundleInstalled(appName) })
    };
  }
}

export function asString(value) {
  return `"${escapeAppleScript(value === undefined || value === null ? "" : String(value))}"`;
}

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

export function dateCall(parts) {
  return `atmMakeDate(${asInteger(parts.year, { min: 1970, max: 2200, field: "year" })}, ` +
    `${asInteger(parts.month, { min: 1, max: 12, field: "month" })}, ` +
    `${asInteger(parts.day, { min: 1, max: 31, field: "day" })}, ` +
    `${asInteger(parts.hour, { min: 0, max: 23, field: "hour" })}, ` +
    `${asInteger(parts.minute, { min: 0, max: 59, field: "minute" })})`;
}

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
  const probe = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return { parts: null, error: `${field} is not a valid calendar date: ${trimmed}`, dateOnly };
  }

  return { parts: { year, month, day, hour, minute, iso: trimmed }, error: null, dateOnly };
}
