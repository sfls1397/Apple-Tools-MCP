/**
 * Calendar write operations: list calendars, add / edit / remove events,
 * RSVP to invitations, plus recurrence rules and alerts.
 *
 * Events are addressed by their iCalendar UID (Calendar.app's `uid`
 * property), which `calendar_date` reports as "Event ID" and `calendar_add`
 * returns for new events.
 */

import {
  runAppleScript,
  asString,
  asInteger,
  dateCall,
  parseWriteDateTime,
  DATE_HANDLER,
  CALENDAR_TCC_GUIDANCE,
  CALENDAR_APP_NOT_RUNNING_GUIDANCE,
  ATTRIBUTION_GUIDANCE,
  formatOsascriptDiagnostic,
  isHardTccDenial
} from "./appleScript.js";
import {
  planWrite,
  plannedWriteResult,
  validateEventId,
  validateEventKitId,
  validateCalendarName,
  validateBody,
  validateSubject,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  normalizeList,
  truncate
} from "./writeGuards.js";
import {
  ensureEventKitSession,
  getEventKitSession,
  setEventKitSession
} from "./eventKitSession.js";

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];
export const RECURRENCE_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
export const RSVP_RESPONSES = ["accept", "decline", "tentative"];

const RSVP_STATUS = {
  accept: "accepted",
  decline: "declined",
  tentative: "tentative"
};

// Alerts are minutes before the event start; capped at four weeks.
const MAX_ALERT_MINUTES = 40320;

/**
 * Build an RFC 5545 RRULE from structured arguments, or validate a raw rule.
 *
 * Supported patterns:
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL, COUNT or UNTIL,
 *   and BYDAY (weekly).
 *
 * @returns {{ rule: string|null, error: string|null }}
 */
export function buildRecurrenceRule(options = {}) {
  const { recurrence, frequency, interval, count, until, by_day: byDay } = options;

  if (recurrence) {
    if (typeof recurrence !== "string") return { rule: null, error: "recurrence must be a string" };
    const raw = recurrence.trim().toUpperCase().replace(/^RRULE:/, "");
    if (!/^FREQ=[A-Z0-9=;,:+-]{1,290}$/.test(raw)) {
      return { rule: null, error: 'recurrence must be an RRULE starting with FREQ= (for example "FREQ=WEEKLY;INTERVAL=1;COUNT=10")' };
    }
    return { rule: raw, error: null };
  }

  if (!frequency) return { rule: null, error: null };

  const freq = String(frequency).toLowerCase();
  if (!RECURRENCE_FREQUENCIES.includes(freq)) {
    return { rule: null, error: `frequency must be one of: ${RECURRENCE_FREQUENCIES.join(", ")}` };
  }

  const parts = [`FREQ=${freq.toUpperCase()}`];

  if (interval !== undefined && interval !== null && interval !== "") {
    const n = Number(interval);
    if (!Number.isInteger(n) || n < 1 || n > 366) {
      return { rule: null, error: "interval must be an integer between 1 and 366" };
    }
    parts.push(`INTERVAL=${n}`);
  }

  if (byDay !== undefined && byDay !== null && byDay !== "") {
    const days = normalizeList(byDay).map((d) => d.toUpperCase());
    const bad = days.filter((d) => !RECURRENCE_DAYS.includes(d));
    if (bad.length > 0) {
      return { rule: null, error: `by_day accepts ${RECURRENCE_DAYS.join(", ")}; got ${bad.join(", ")}` };
    }
    if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
  }

  if (count !== undefined && count !== null && count !== "") {
    if (until) return { rule: null, error: "use either count or until, not both" };
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      return { rule: null, error: "count must be an integer between 1 and 1000" };
    }
    parts.push(`COUNT=${n}`);
  }

  if (until) {
    const parsed = parseWriteDateTime(until, "until");
    if (parsed.error) return { rule: null, error: parsed.error };
    const p = parsed.parts;
    const pad = (v) => String(v).padStart(2, "0");
    // UNTIL is expressed in UTC per RFC 5545.
    const utc = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0));
    parts.push(
      `UNTIL=${utc.getUTCFullYear()}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}T` +
      `${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}00Z`
    );
  }

  return { rule: parts.join(";"), error: null };
}

/**
 * Validate the alerts list (minutes before start).
 * @returns {{ minutes: number[], error: string|null }}
 */
export function validateAlerts(value) {
  if (value === undefined || value === null || value === "") return { minutes: [], error: null };
  const entries = normalizeList(value);
  const minutes = [];
  for (const entry of entries) {
    const n = Number(entry);
    if (!Number.isInteger(n) || n < 0 || n > MAX_ALERT_MINUTES) {
      return { minutes: [], error: `alerts_minutes_before accepts whole minutes from 0 to ${MAX_ALERT_MINUTES}; got ${truncate(entry, 40)}` };
    }
    minutes.push(n);
  }
  if (minutes.length > 5) return { minutes: [], error: "at most 5 alerts per event" };
  return { minutes, error: null };
}

/**
 * End time when the caller gave only a start: an all-day event runs to the
 * end of that day, a timed event runs an hour (rolling into the next day
 * when the start is late in the evening).
 */
export function defaultEndParts(start, allDay) {
  if (allDay) {
    return { ...start, hour: 23, minute: 59 };
  }
  const end = new Date(start.year, start.month - 1, start.day, start.hour + 1, start.minute, 0, 0);
  return {
    year: end.getFullYear(),
    month: end.getMonth() + 1,
    day: end.getDate(),
    hour: end.getHours(),
    minute: end.getMinutes()
  };
}

/**
 * calendar_edit / calendar_rsvp's classic-AppleScript fallback both resolve
 * an event by uid through this handler. Regression (2026-09-23): RSVPing to
 * an event created moments earlier through the daemon's separate EventKit
 * session ("no event with that id was found") failed on the first lookup
 * even though the event genuinely existed -- Calendar.app's classic
 * AppleScript object model can lag behind a write made through EventKit.
 * An EventKit-based fix isn't available here: writeOnly EventKit can only
 * re-query an event via the exact in-memory EKEvent object from the
 * session that created it (see describeEventKitWriteFailure below), which
 * doesn't exist for a real invitation synced in from elsewhere. Retrying
 * the classic lookup a few times gives Calendar.app's own model a chance
 * to catch up, well inside callers' existing 60s budget.
 */
function findEventHandler() {
  return `on atmFindEvent(theUid)
  set attemptsLeft to 5
  repeat
    tell application "Calendar"
      repeat with cal in calendars
        try
          set hits to (every event of cal whose uid is theUid)
          if (count of hits) > 0 then return item 1 of hits
        end try
      end repeat
    end tell
    set attemptsLeft to attemptsLeft - 1
    if attemptsLeft is 0 then exit repeat
    delay 2
  end repeat
  error "EVENT_NOT_FOUND"
end atmFindEvent`;
}

function alarmLines(minutes, eventVar) {
  return minutes
    .map((m) => `  tell ${eventVar}
    make new display alarm at end of display alarms with properties {trigger interval:-${asInteger(m, { min: 0, max: MAX_ALERT_MINUTES, field: "alert" })}}
  end tell`)
    .join("\n");
}

function failure(action, summary, result, secrets = []) {
  if (result.kind === "tcc" || result.kind === "timeout") {
    return `${action} failed — attempted to ${summary}. ${CALENDAR_TCC_GUIDANCE}`;
  }
  const raw = String(result.error || "");
  if (raw.includes("CALENDAR_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. That calendar does not exist; call calendar_list_calendars first.`;
  }
  if (result.kind === "not_found" || raw.includes("EVENT_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. No event with that id was found; use the Event ID from calendar_date.`;
  }
  if (result.kind === "app_not_running") {
    return `${action} failed — attempted to ${summary}. ${CALENDAR_APP_NOT_RUNNING_GUIDANCE}`;
  }
  if (result.kind === "attribution") {
    return `${action} failed — attempted to ${summary}. ${ATTRIBUTION_GUIDANCE}`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Calendar.app could not be reached on this host.`;
  }
  return writeErrorMessage(action, summary, new Error(raw || "unknown error"), secrets);
}

/**
 * calendar_remove must never hide the AppleEvent code behind TCC copy.
 * Mini --apply: add/edit PASS then remove FAIL looked like a TCC deny
 * because failure() dropped stderr when classify mapped ETIMEDOUT/-1712
 * to tcc. Same write-bridge RPC as add/edit; not a different calendar
 * account. Calendar.app has no `remove` / `move to trash` — only `delete`.
 */
export function describeCalendarRemoveFailure(action, summary, appleResult, eventKitResult = null) {
  const parts = [`AppleScript ${formatOsascriptDiagnostic(appleResult, "osascript")}`];
  if (eventKitResult) {
    parts.push(`EventKit ${formatOsascriptDiagnostic(eventKitResult, "osascript")}`);
  }
  const diagnostics = parts.join(" ");
  const raw = String(appleResult.error || "");
  const hardTcc = isHardTccDenial(raw);
  const timedOut =
    appleResult.kind === "timeout" ||
    /delete_timeout|etimedout|-1712|appleevent timed out|timed out after/i.test(raw);

  let head;
  if (raw.includes("CALENDAR_NOT_FOUND")) {
    head = `${action} failed — attempted to ${summary}. That calendar does not exist; call calendar_list_calendars first.`;
  } else if (hardTcc) {
    head = `${action} failed — attempted to ${summary}. ${CALENDAR_TCC_GUIDANCE}`;
  } else if (timedOut) {
    head = `${action} failed — attempted to ${summary}. Calendar.app delete timed out. That is not a TCC / Automation deny when calendar_add/calendar_edit succeed on this host — Calendar.app has no remove or move-to-trash; iCloud/CalDAV delete can hang or wait on a confirmation dialog.`;
  } else if (appleResult.kind === "not_found" || raw.includes("EVENT_NOT_FOUND")) {
    head = `${action} failed — attempted to ${summary}. No event with that id was found; use the Event ID from calendar_date.`;
  } else if (appleResult.kind === "app_not_running") {
    head = `${action} failed — attempted to ${summary}. ${CALENDAR_APP_NOT_RUNNING_GUIDANCE}`;
  } else if (appleResult.kind === "attribution") {
    head = `${action} failed — attempted to ${summary}. ${ATTRIBUTION_GUIDANCE}`;
  } else if (appleResult.kind === "app_unavailable") {
    head = `${action} failed — attempted to ${summary}. Calendar.app could not be reached on this host.`;
  } else {
    head = writeErrorMessage(action, summary, new Error(raw || "unknown error"));
  }

  return {
    ok: false,
    message: `${head} ${diagnostics}`,
    suppressTccAdvice: !hardTcc,
    diagnostics
  };
}

/**
 * Non-recurring add must not fall through to Calendar.app: Mini writeOnly
 * EventKit cannot delete AppleScript-created events, and Calendar.app
 * delete hangs (ETIMEDOUT). Fail closed with the EventKit code.
 */
export function describeCalendarAddFailure(action, summary, eventKitResult) {
  const diagnostics = `EventKit ${formatOsascriptDiagnostic(eventKitResult)}`;
  const raw = String(eventKitResult && eventKitResult.error ? eventKitResult.error : "");
  const hardTcc = isHardTccDenial(raw) || /eventkit_denied/i.test(raw);
  let head;
  if (raw.includes("CALENDAR_NOT_FOUND")) {
    head = `${action} failed — attempted to ${summary}. EventKit could not target that calendar (writeOnly often cannot list calendars; we use defaultCalendarForNewEvents). Call calendar_list_calendars first.`;
  } else if (hardTcc) {
    head = `${action} failed — attempted to ${summary}. ${CALENDAR_TCC_GUIDANCE}`;
  } else {
    head = `${action} failed — attempted to ${summary}. EventKit create failed; non-recurring add does not fall back to Calendar.app because writeOnly EventKit cannot see AppleScript-created events and Calendar.app delete hangs.`;
  }
  return {
    ok: false,
    message: `${head} ${diagnostics}`,
    suppressTccAdvice: !hardTcc,
    diagnostics
  };
}

export function describeEventKitWriteFailure(action, summary, eventKitResult) {
  const diagnostics = `EventKit ${formatOsascriptDiagnostic(eventKitResult)}`;
  const raw = String(eventKitResult && eventKitResult.error ? eventKitResult.error : "");
  const hardTcc = isHardTccDenial(raw) || /eventkit_denied/i.test(raw);
  const head = raw.includes("EVENTKIT_NOT_FOUND")
    ? `${action} failed — attempted to ${summary}. writeOnly EventKit cannot re-query by id; edit/remove need the in-memory EKEvent from the same EventKit session that created it. Calendar.app uid lookup was skipped to avoid an iCloud hang.`
    : `${action} failed — attempted to ${summary}. EventKit write failed; Calendar.app was not used because eventkit_id was provided.`;
  return {
    ok: false,
    message: `${head} ${diagnostics}`,
    suppressTccAdvice: !hardTcc,
    diagnostics
  };
}

/**
 * Mini 74d304e: EventKit status=4 is writeOnly. That grant can create and
 * delete events *this process* saved, but calendarItemsWithExternalIdentifier
 * cannot see an event Calendar.app created via AppleScript. Align add→remove
 * by creating through EventKit and deleting with the same identifiers
 * (calendarItemExternalIdentifier and eventIdentifier).
 */
export function localUnixSeconds(parts) {
  return Math.floor(new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0).getTime() / 1000);
}

export function parseEventKitAddOutput(output) {
  const text = String(output || "").trim();
  if (!text) return { eventId: null, eventKitId: null, calendar: null };
  const [externalId, eventKitId, calendar, calendarItemId] = text.split("<<>>");
  const ext = String(externalId || "").trim();
  const local = String(eventKitId || "").trim();
  const item = String(calendarItemId || "").trim();
  return {
    eventId: ext || local || item || null,
    eventKitId: local || item || null,
    calendar: String(calendar || "").trim() || null
  };
}

export function parseEventKitCalendarList(output) {
  return String(output || "")
    .split("|||")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const parts = entry.split("<<>>");
      if (parts.length < 3) return null;
      const [name, writable, local, sourceType, source] = parts;
      return {
        name: name || "",
        writable: writable !== "no",
        local: local === "yes",
        sourceType: sourceType === undefined || sourceType === "" ? null : Number(sourceType),
        source: source || ""
      };
    })
    .filter(Boolean);
}

/**
 * JXA prints NSString as `[id NSTaggedPointerString]` if you `String(title)`.
 * Mini cd74071: default=[id NSTaggedPointerString] so title match failed
 * even though eventKitCalendars=1. Always ObjC.unwrap / .js.
 */
export const EVENTKIT_JXA_HELPERS = `function jsString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    if (value.indexOf("[id ") === 0 || value === "[object Object]") return "";
    return value;
  }
  try {
    if (typeof value.js === "string") return value.js;
  } catch (e) {}
  try {
    var unwrapped = ObjC.unwrap(value);
    if (typeof unwrapped === "string") return unwrapped;
  } catch (e) {}
  return "";
}
function titleOf(c) {
  try { return c ? jsString(c.title) : ""; } catch (e) { return ""; }
}
function identifierOf(c) {
  try { return c ? jsString(c.calendarIdentifier) : ""; } catch (e) { return ""; }
}
function asEvent(item) {
  if (item === undefined || item === null) return false;
  try { if (item.isKindOfClass && item.isKindOfClass($.EKEvent)) return true; } catch (e) {}
  try { if (jsString(item.eventIdentifier)) return true; } catch (e) {}
  try { if (jsString(item.calendarItemExternalIdentifier)) return true; } catch (e) {}
  try { if (jsString(item.calendarItemIdentifier)) return true; } catch (e) {}
  return false;
}
function nsId(id) {
  return $.NSString.stringWithString(String(id));
}
function firstMatching(items) {
  if (!items) return null;
  var n = 0;
  try { n = Number(items.count); } catch (e) { n = 0; }
  for (var j = 0; j < n; j++) {
    var hit = null;
    try { hit = items.objectAtIndex(j); } catch (e) {}
    if (asEvent(hit)) return hit;
  }
  return null;
}
function lookupOne(store, raw) {
  if (!raw) return null;
  var bridged = nsId(raw);
  var candidates = [bridged, raw];
  for (var k = 0; k < candidates.length; k++) {
    var id = candidates[k];
    var ev = null;
    try { ev = store.eventWithIdentifier(id); } catch (e) {}
    if (!asEvent(ev)) {
      try { ev = store.eventWithIdentifier_(id); } catch (e) {}
    }
    if (asEvent(ev)) return ev;
    try {
      var item = store.calendarItemWithIdentifier(id);
      if (asEvent(item)) return item;
    } catch (e) {}
    try {
      var item2 = store.calendarItemWithIdentifier_(id);
      if (asEvent(item2)) return item2;
    } catch (e) {}
    try {
      var found = firstMatching(store.calendarItemsWithExternalIdentifier(id));
      if (found) return found;
    } catch (e) {}
    try {
      var found2 = firstMatching(store.calendarItemsWithExternalIdentifier_(id));
      if (found2) return found2;
    } catch (e) {}
  }
  return null;
}
function findEventByIds(store, ids) {
  try { store.refreshSourcesIfNecessary(); } catch (e) {}
  for (var i = 0; i < ids.length; i++) {
    var found = lookupOne(store, ids[i]);
    if (found) return found;
  }
  return null;
}
`;

/**
 * Mini ed6d834: eventkit_id is `calendarUUID:eventUUID`. Look up the
 * compound id and each half so eventWithIdentifier / externalIdentifier
 * both get a usable string.
 */
export function eventKitLookupIds(eventId, eventKitId) {
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  add(eventKitId);
  add(eventId);
  for (const value of [...out]) {
    if (value.includes(":")) {
      for (const part of value.split(":")) add(part);
    }
    if (value.includes("/")) add(value.split("/")[0]);
  }
  return out;
}

function eventKitSessionRequest(cmd) {
  const session = getEventKitSession() || ensureEventKitSession({ helpers: EVENTKIT_JXA_HELPERS });
  if (!session) return null;
  try {
    return session.request(cmd);
  } catch (e) {
    try { session.close(); } catch { /* ignore */ }
    setEventKitSession(null);
    return { ok: false, error: e && e.message ? e.message : String(e), sessionDead: true };
  }
}

export function mergeCalendarSources(appleCalendars, eventKitCalendars) {
  if (!eventKitCalendars || eventKitCalendars.length === 0) return appleCalendars || [];
  const byName = new Map(eventKitCalendars.map((c) => [c.name, c]));
  return (appleCalendars || []).map((c) => {
    const ek = byName.get(c.name);
    return {
      ...c,
      local: ek ? ek.local : false,
      sourceType: ek ? ek.sourceType : null,
      source: ek ? ek.source : null
    };
  });
}

export function buildEventKitListCalendarsScript() {
  return `ObjC.import("EventKit");
ObjC.import("Foundation");
${EVENTKIT_JXA_HELPERS}
var store = $.EKEventStore.alloc.init;
var rows = [];
var seen = {};
function addRow(c) {
  if (!c) return;
  var name = titleOf(c);
  if (!name || seen[name]) return;
  seen[name] = true;
  var src = null;
  try { src = c.source; } catch (e) {}
  var type = -1;
  try { if (src) type = Number(src.sourceType); } catch (e) {}
  var srcName = "";
  try { if (src) srcName = jsString(src.title); } catch (e) {}
  var writable = "yes";
  try { if (c.allowsContentModifications === false) writable = "no"; } catch (e) {}
  var local = type === 0 ? "yes" : "no";
  rows.push(name + "<<>>" + writable + "<<>>" + local + "<<>>" + type + "<<>>" + srcName);
}
try {
  var cals = store.calendarsForEntityType($.EKEntityTypeEvent);
  for (var i = 0; i < cals.count; i++) addRow(cals.objectAtIndex(i));
} catch (e) {}
try { addRow(store.defaultCalendarForNewEvents); } catch (e) {}
rows.join("|||");`;
}

export function buildEventKitAddScript({ calendarName, title, start, end, allDay, location, notes, alerts }) {
  const startSec = localUnixSeconds(start);
  const endSec = localUnixSeconds(end);
  return `ObjC.import("EventKit");
ObjC.import("Foundation");
${EVENTKIT_JXA_HELPERS}
var calendarName = ${JSON.stringify(calendarName)};
var title = ${JSON.stringify(title)};
var startSec = ${asInteger(startSec, { field: "start" })};
var endSec = ${asInteger(endSec, { field: "end" })};
var allDay = ${allDay ? "true" : "false"};
var location = ${JSON.stringify(location || "")};
var notes = ${JSON.stringify(notes || "")};
var alerts = ${JSON.stringify(alerts || [])};
var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
if (status === 1 || status === 2) {
  throw new Error("EVENTKIT_DENIED status=" + status);
}
var store = $.EKEventStore.alloc.init;
var defaultCal = null;
try { defaultCal = store.defaultCalendarForNewEvents; } catch (e) {}
var cals = null;
var count = 0;
try {
  cals = store.calendarsForEntityType($.EKEntityTypeEvent);
  count = cals ? Number(cals.count) : 0;
} catch (e) {}
var target = null;
var writables = [];
var wanted = String(calendarName || "").toLowerCase();
function matchesWanted(c) {
  var t = titleOf(c).toLowerCase();
  var id = identifierOf(c);
  return (t && t === wanted) || (id && (id === calendarName || id.toLowerCase() === wanted));
}
for (var i = 0; i < count; i++) {
  var c = cals.objectAtIndex(i);
  var writable = true;
  try { writable = !!c.allowsContentModifications; } catch (e) {}
  if (!writable) continue;
  writables.push(c);
  if (matchesWanted(c)) {
    target = c;
    break;
  }
}
if (!target && defaultCal && matchesWanted(defaultCal)) {
  target = defaultCal;
}
if (!target && writables.length === 1) {
  target = writables[0];
}
if (!target && defaultCal) {
  target = defaultCal;
}
if (!target) {
  throw new Error("CALENDAR_NOT_FOUND status=" + status + " eventKitCalendars=" + count + " default=" + titleOf(defaultCal) + " defaultId=" + identifierOf(defaultCal));
}
var event = null;
try { event = $.EKEvent.eventWithEventStore(store); } catch (e) {}
if (!event) {
  try { event = $.EKEvent.alloc.initWithEventStore(store); } catch (e2) {}
}
if (!event) throw new Error("EVENTKIT_NO_EVENT status=" + status);
event.title = title;
event.startDate = $.NSDate.dateWithTimeIntervalSince1970(startSec);
event.endDate = $.NSDate.dateWithTimeIntervalSince1970(endSec);
event.allDay = allDay;
try { event.calendar = target; } catch (e) {}
try { if (event.setCalendar) event.setCalendar(target); } catch (e) {}
if (location) event.location = location;
if (notes) event.notes = notes;
if (alerts && alerts.length) {
  var alarms = $.NSMutableArray.array;
  for (var a = 0; a < alerts.length; a++) {
    alarms.addObject($.EKAlarm.alarmWithRelativeOffset(-Number(alerts[a]) * 60));
  }
  event.alarms = alarms;
}
var err = Ref();
var ok = false;
try {
  ok = store.saveEventSpanCommitError(event, $.EKSpanThisEvent, true, err);
} catch (e) {
  throw new Error("EVENTKIT_SAVE_FAILED: " + String(e));
}
if (!ok) {
  var desc = "unknown";
  try { desc = String(err[0]); } catch (e) {}
  throw new Error("EVENTKIT_SAVE_FAILED: " + desc + " status=" + status);
}
var externalId = "";
var localId = "";
var itemId = "";
try { externalId = jsString(event.calendarItemExternalIdentifier); } catch (e) {}
try { localId = jsString(event.eventIdentifier); } catch (e) {}
try { itemId = jsString(event.calendarItemIdentifier); } catch (e) {}
if (!externalId && !localId && !itemId) throw new Error("EVENTKIT_NO_ID status=" + status);
externalId + "<<>>" + localId + "<<>>" + titleOf(target) + "<<>>" + itemId;`;
}

export function buildEventKitRemoveScript(eventId, { eventKitId = null } = {}) {
  const ids = eventKitLookupIds(eventId, eventKitId);
  return `ObjC.import("EventKit");
ObjC.import("Foundation");
${EVENTKIT_JXA_HELPERS}
var ids = ${JSON.stringify(ids)};
var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
if (status === 1 || status === 2) {
  throw new Error("EVENTKIT_DENIED status=" + status);
}
var store = $.EKEventStore.alloc.init;
var found = findEventByIds(store, ids);
if (!found) {
  throw new Error("EVENTKIT_NOT_FOUND status=" + status + (status === 4 ? " writeOnly" : "") + " tried=" + ids.join(","));
}
var err = Ref();
var ok = store.removeEventSpanCommitError(found, $.EKSpanThisEvent, true, err);
if (!ok) {
  var desc = "unknown";
  try { desc = String(err[0]); } catch (e) {}
  throw new Error("EVENTKIT_REMOVE_FAILED: " + desc);
}
1;`;
}

/**
 * List calendars so a caller can pick a target instead of defaulting.
 */
export function calendarListCalendars() {
  const action = "calendar_list_calendars";
  const script = `set outputList to {}
tell application "Calendar"
  repeat with cal in calendars
    try
      set calName to name of cal
      set calWritable to "yes"
      try
        if writable of cal is false then set calWritable to "no"
      end try
      set end of outputList to calName & "<<>>" & calWritable
    end try
  end repeat
end tell
set AppleScript's text item delimiters to "|||"
return outputList as string`;

  const result = runAppleScript(script, { timeout: 30000, appName: "Calendar" });

  // EventKit does not require Calendar.app to be running (same as
  // calendar_add / calendar_edit / calendar_remove / calendar_rsvp), so it
  // can stand in for the classic Calendar.app listing when Calendar.app
  // happens to be closed. Only fail if both sources come back empty.
  const ekList = runAppleScript(buildEventKitListCalendarsScript(), {
    timeout: 15000,
    appName: "Calendar",
    language: "JavaScript"
  });

  if (!result.ok && !ekList.ok) {
    return { ok: false, message: failure(action, "list calendars", result) };
  }

  let calendars = result.ok
    ? result.output
        .split("|||")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [name, writable] = entry.split("<<>>");
          return { name: name || "", writable: writable !== "no" };
        })
    : [];

  if (ekList.ok) {
    calendars = result.ok
      ? mergeCalendarSources(calendars, parseEventKitCalendarList(ekList.output))
      : parseEventKitCalendarList(ekList.output);
  }

  if (calendars.length === 0) {
    return { ok: true, message: "No calendars found in Calendar.app." };
  }

  const lines = calendars.map((c) => {
    const tags = [];
    if (!c.writable) tags.push("read-only");
    if (c.local) tags.push("On My Mac");
    else if (c.source) tags.push(c.source);
    return `• ${c.name}${tags.length ? ` (${tags.join(", ")})` : ""}`;
  });
  return {
    ok: true,
    message: `Calendars (${calendars.length}):\n${lines.join("\n")}\n\nPass one of these names as calendar_name when creating events.`,
    calendars
  };
}

export function buildAddEventScript({ calendarName, title, start, end, allDay, location, notes, rule, alerts }) {
  const props = [
    `summary:${asString(title)}`,
    `start date:startDate`,
    `end date:endDate`,
    `allday event:${allDay ? "true" : "false"}`
  ];
  if (location) props.push(`location:${asString(location)}`);
  if (notes) props.push(`description:${asString(notes)}`);

  return `${DATE_HANDLER}

set startDate to ${dateCall(start)}
set endDate to ${dateCall(end)}
tell application "Calendar"
  set targetCal to missing value
  repeat with cal in calendars
    try
      if (name of cal) is ${asString(calendarName)} then
        set targetCal to cal
        exit repeat
      end if
    end try
  end repeat
  if targetCal is missing value then error "CALENDAR_NOT_FOUND"
  tell targetCal
    set newEvent to make new event with properties {${props.join(", ")}}
  end tell
${rule ? `  set recurrence of newEvent to ${asString(rule)}\n` : ""}${alerts.length ? `${alarmLines(alerts, "newEvent")}\n` : ""}  set newUid to uid of newEvent
end tell
return newUid`;
}

export function calendarAdd(args = {}) {
  const action = "calendar_add";

  const calendarName = validateCalendarName(args.calendar_name);
  if (!calendarName) {
    return { ok: false, message: `${action} refused: calendar_name is required and must match a calendar from calendar_list_calendars.` };
  }

  const title = validateSubject(args.title, { required: true });
  if (title.error) return { ok: false, message: `${action} refused: ${title.error.replace("subject", "title")}` };

  const start = parseWriteDateTime(args.start, "start");
  if (start.error) return { ok: false, message: `${action} refused: ${start.error}` };

  const allDay = isFlagTrue(args.all_day) || (start.dateOnly && !args.end);
  const end = args.end
    ? parseWriteDateTime(args.end, "end")
    : { parts: defaultEndParts(start.parts, allDay), error: null };
  if (end.error) return { ok: false, message: `${action} refused: ${end.error}` };

  const startMs = Date.UTC(start.parts.year, start.parts.month - 1, start.parts.day, start.parts.hour, start.parts.minute);
  const endMs = Date.UTC(end.parts.year, end.parts.month - 1, end.parts.day, end.parts.hour, end.parts.minute);
  if (endMs < startMs) {
    return { ok: false, message: `${action} refused: end is before start` };
  }

  const location = validateSubject(args.location);
  if (location.error) return { ok: false, message: `${action} refused: ${location.error.replace("subject", "location")}` };
  const notes = validateBody(args.notes, { field: "notes" });
  if (notes.error) return { ok: false, message: `${action} refused: ${notes.error}` };

  const recurrence = buildRecurrenceRule(args);
  if (recurrence.error) return { ok: false, message: `${action} refused: ${recurrence.error}` };
  const alerts = validateAlerts(args.alerts_minutes_before);
  if (alerts.error) return { ok: false, message: `${action} refused: ${alerts.error}` };

  const summary = `create "${truncate(title.text, 120)}" on calendar "${calendarName}" from ${args.start} to ${args.end || "start + 1h"}` +
    `${recurrence.rule ? ` repeating (${recurrence.rule})` : ""}` +
    `${alerts.minutes.length ? ` with alerts ${alerts.minutes.join(", ")} min before` : ""}`;

  const plan = planWrite({ action, summary, dryRun: isFlagTrue(args.dry_run), confirm: isFlagTrue(args.confirm) });
  if (!plan.proceed) return plannedWriteResult(plan);

  // Non-recurring creates MUST go through EventKit. Mini 8be6cd5: EventKit
  // add failed (likely writeOnly cannot list calendars) and we silently
  // created via Calendar.app — remove then EVENTKIT_NOT_FOUND status=4 and
  // Calendar.app delete ETIMEDOUT. No AppleScript fallback here.
  if (!recurrence.rule) {
    const sessionReply = eventKitSessionRequest({
      op: "create",
      calendarName,
      title: title.text,
      startSec: localUnixSeconds(start.parts),
      endSec: localUnixSeconds(end.parts),
      allDay,
      location: location.text || "",
      notes: notes.text || "",
      alerts: alerts.minutes
    });
    if (sessionReply && sessionReply.ok) {
      const ids = parseEventKitAddOutput(sessionReply.output);
      if (ids.eventId) {
        return {
          ok: true,
          message: writeSuccessMessage(action, "event created", {
            event_id: ids.eventId,
            eventkit_id: ids.eventKitId || ids.eventId,
            calendar: ids.calendar || calendarName,
            via: "EventKit",
            title: truncate(title.text, 150),
            start: args.start,
            alerts: alerts.minutes.length ? alerts.minutes.join(", ") : undefined
          })
        };
      }
    }
    if (sessionReply && !sessionReply.ok && !sessionReply.sessionDead) {
      return describeCalendarAddFailure(action, summary, {
        ok: false,
        error: sessionReply.error || "EVENTKIT_SESSION_CREATE_FAILED",
        kind: "unknown"
      });
    }

    // One-shot: return identifiers from the saved EKEvent. Do not re-query —
    // writeOnly status=4 cannot eventWithIdentifier after save (Mini 2cdf44d).
    let ek;
    try {
      ek = runAppleScript(
        buildEventKitAddScript({
          calendarName,
          title: title.text,
          start: start.parts,
          end: end.parts,
          allDay,
          location: location.text,
          notes: notes.text,
          alerts: alerts.minutes
        }),
        { timeout: 30000, appName: "Calendar", language: "JavaScript" }
      );
    } catch (e) {
      ek = { ok: false, error: e && e.message ? e.message : String(e), kind: "unknown" };
    }
    if (ek.ok) {
      const ids = parseEventKitAddOutput(ek.output);
      if (ids.eventId) {
        return {
          ok: true,
          message: writeSuccessMessage(action, "event created", {
            event_id: ids.eventId,
            eventkit_id: ids.eventKitId || ids.eventId,
            calendar: ids.calendar || calendarName,
            via: "EventKit",
            title: truncate(title.text, 150),
            start: args.start,
            alerts: alerts.minutes.length ? alerts.minutes.join(", ") : undefined
          })
        };
      }
      return describeCalendarAddFailure(
        action,
        summary,
        { ok: false, error: `EVENTKIT_NO_ID output=${truncate(ek.output, 120)}`, kind: "unknown" }
      );
    }
    return describeCalendarAddFailure(action, summary, ek);
  }

  let script;
  try {
    script = buildAddEventScript({
      calendarName,
      title: title.text,
      start: start.parts,
      end: end.parts,
      allDay,
      location: location.text,
      notes: notes.text,
      rule: recurrence.rule,
      alerts: alerts.minutes
    });
  } catch (e) {
    return { ok: false, message: `${action} refused: ${e.message}` };
  }

  const result = runAppleScript(script, { timeout: 60000, appName: "Calendar" });
  if (!result.ok) return { ok: false, message: failure(action, summary, result, [notes.text]) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "event created", {
      event_id: result.output,
      calendar: calendarName,
      title: truncate(title.text, 150),
      start: args.start,
      recurrence: recurrence.rule || undefined,
      alerts: alerts.minutes.length ? alerts.minutes.join(", ") : undefined
    })
  };
}

export function buildEventKitEditScript({
  eventId,
  eventKitId = null,
  updates = {},
  start = null,
  end = null,
  alerts = [],
  clearAlerts = false
}) {
  const ids = eventKitLookupIds(eventId, eventKitId);
  const title = updates.summary ? JSON.stringify(updates.summary) : "null";
  const location = updates.location !== undefined ? JSON.stringify(updates.location) : "null";
  const notes = updates.description !== undefined ? JSON.stringify(updates.description) : "null";
  const startSec = start ? localUnixSeconds(start) : null;
  const endSec = end ? localUnixSeconds(end) : null;
  return `ObjC.import("EventKit");
ObjC.import("Foundation");
${EVENTKIT_JXA_HELPERS}
var ids = ${JSON.stringify(ids)};
var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
if (status === 1 || status === 2) {
  throw new Error("EVENTKIT_DENIED status=" + status);
}
var store = $.EKEventStore.alloc.init;
var event = findEventByIds(store, ids);
if (!event) {
  throw new Error("EVENTKIT_NOT_FOUND status=" + status + (status === 4 ? " writeOnly" : "") + " tried=" + ids.join(","));
}
var newTitle = ${title};
var newLocation = ${location};
var newNotes = ${notes};
if (newTitle !== null) event.title = newTitle;
if (newLocation !== null) event.location = newLocation;
if (newNotes !== null) event.notes = newNotes;
${startSec !== null ? `event.startDate = $.NSDate.dateWithTimeIntervalSince1970(${asInteger(startSec, { field: "start" })});` : ""}
${endSec !== null ? `event.endDate = $.NSDate.dateWithTimeIntervalSince1970(${asInteger(endSec, { field: "end" })});` : ""}
${clearAlerts ? `try { event.alarms = $.NSMutableArray.array; } catch (e) {}` : ""}
${alerts.length ? `var alarms = $.NSMutableArray.array;
for (var a = 0; a < ${JSON.stringify(alerts)}.length; a++) {
  alarms.addObject($.EKAlarm.alarmWithRelativeOffset(-Number(${JSON.stringify(alerts)}[a]) * 60));
}
event.alarms = alarms;` : ""}
var err = Ref();
var ok = store.saveEventSpanCommitError(event, $.EKSpanThisEvent, true, err);
if (!ok) {
  var desc = "unknown";
  try { desc = String(err[0]); } catch (e) {}
  throw new Error("EVENTKIT_SAVE_FAILED: " + desc);
}
jsString(event.eventIdentifier) || jsString(event.calendarItemExternalIdentifier) || "1";`;
}

export function buildEditEventScript({ eventId, updates, start, end, rule, alerts, clearAlerts }) {
  const lines = [];
  for (const [prop, value] of Object.entries(updates)) {
    lines.push(`  set ${prop} of theEvent to ${asString(value)}`);
  }
  if (start) lines.push(`  set start date of theEvent to ${dateCall(start)}`);
  if (end) lines.push(`  set end date of theEvent to ${dateCall(end)}`);
  if (rule) lines.push(`  set recurrence of theEvent to ${asString(rule)}`);
  if (clearAlerts) {
    lines.push(`  try
    delete every display alarm of theEvent
  end try`);
  }

  return `${DATE_HANDLER}
${findEventHandler()}

set theEvent to atmFindEvent(${asString(eventId)})
tell application "Calendar"
${lines.join("\n")}
${alerts.length ? `${alarmLines(alerts, "theEvent")}\n` : ""}  set editedUid to uid of theEvent
end tell
return editedUid`;
}

export function calendarEdit(args = {}) {
  const action = "calendar_edit";

  const eventId = validateEventId(args.event_id);
  if (!eventId) {
    return { ok: false, message: `${action} refused: event_id is required (the "Event ID" from calendar_date or calendar_add). This tool will not guess which event you meant.` };
  }

  const eventKitId = args.eventkit_id === undefined || args.eventkit_id === null || args.eventkit_id === ""
    ? null
    : validateEventKitId(args.eventkit_id);
  if (args.eventkit_id && !eventKitId) {
    return { ok: false, message: `${action} refused: eventkit_id is not a valid EventKit eventIdentifier.` };
  }

  const updates = {};
  const changed = [];

  if (args.title !== undefined) {
    const title = validateSubject(args.title, { required: true });
    if (title.error) return { ok: false, message: `${action} refused: ${title.error.replace("subject", "title")}` };
    updates.summary = title.text;
    changed.push(`title "${truncate(title.text, 80)}"`);
  }
  if (args.location !== undefined) {
    const location = validateSubject(args.location);
    if (location.error) return { ok: false, message: `${action} refused: ${location.error.replace("subject", "location")}` };
    updates.location = location.text;
    changed.push("location");
  }
  if (args.notes !== undefined) {
    const notes = validateBody(args.notes, { field: "notes" });
    if (notes.error) return { ok: false, message: `${action} refused: ${notes.error}` };
    updates.description = notes.text;
    changed.push("notes");
  }

  let start = null;
  if (args.start !== undefined) {
    const parsed = parseWriteDateTime(args.start, "start");
    if (parsed.error) return { ok: false, message: `${action} refused: ${parsed.error}` };
    start = parsed.parts;
    changed.push(`start ${args.start}`);
  }
  let end = null;
  if (args.end !== undefined) {
    const parsed = parseWriteDateTime(args.end, "end");
    if (parsed.error) return { ok: false, message: `${action} refused: ${parsed.error}` };
    end = parsed.parts;
    changed.push(`end ${args.end}`);
  }

  const recurrence = buildRecurrenceRule(args);
  if (recurrence.error) return { ok: false, message: `${action} refused: ${recurrence.error}` };
  if (recurrence.rule) changed.push(`recurrence (${recurrence.rule})`);

  const alerts = validateAlerts(args.alerts_minutes_before);
  if (alerts.error) return { ok: false, message: `${action} refused: ${alerts.error}` };
  const clearAlerts = isFlagTrue(args.replace_alerts) || alerts.minutes.length > 0;
  if (alerts.minutes.length) changed.push(`alerts ${alerts.minutes.join(", ")} min before`);

  if (changed.length === 0) {
    return { ok: false, message: `${action} refused: nothing to change. Pass at least one of title, start, end, location, notes, recurrence/frequency, alerts_minutes_before.` };
  }

  const summary = `update event ${eventId}: ${changed.join(", ")}`;
  const plan = planWrite({ action, summary, dryRun: isFlagTrue(args.dry_run), confirm: isFlagTrue(args.confirm) });
  if (!plan.proceed) return plannedWriteResult(plan);

  const preferEventKit = Boolean(eventKitId) || eventId.includes(":");
  if (preferEventKit && !recurrence.rule) {
    const sessionReply = eventKitSessionRequest({
      op: "update",
      ids: eventKitLookupIds(eventId, eventKitId),
      title: updates.summary,
      location: updates.location,
      notes: updates.description,
      startSec: start ? localUnixSeconds(start) : null,
      endSec: end ? localUnixSeconds(end) : null,
      alerts: alerts.minutes,
      clearAlerts
    });
    if (sessionReply && sessionReply.ok) {
      return {
        ok: true,
        message: writeSuccessMessage(action, "event updated", {
          event_id: eventId,
          eventkit_id: eventKitId || undefined,
          via: "EventKit",
          changed: changed.join(", ")
        })
      };
    }
    if (sessionReply && !sessionReply.ok && !sessionReply.sessionDead && eventKitId) {
      return describeEventKitWriteFailure(action, summary, {
        ok: false,
        error: sessionReply.error || "EVENTKIT_SESSION_UPDATE_FAILED",
        kind: "not_found"
      });
    }

    const ek = runAppleScript(
      buildEventKitEditScript({
        eventId,
        eventKitId,
        updates,
        start,
        end,
        alerts: alerts.minutes,
        clearAlerts
      }),
      { timeout: 30000, appName: "Calendar", language: "JavaScript" }
    );
    if (ek.ok) {
      return {
        ok: true,
        message: writeSuccessMessage(action, "event updated", {
          event_id: eventId,
          eventkit_id: eventKitId || undefined,
          via: "EventKit",
          changed: changed.join(", ")
        })
      };
    }
    if (eventKitId) {
      return describeEventKitWriteFailure(action, summary, ek);
    }
  }

  let script;
  try {
    script = buildEditEventScript({
      eventId,
      updates,
      start,
      end,
      rule: recurrence.rule,
      alerts: alerts.minutes,
      clearAlerts
    });
  } catch (e) {
    return { ok: false, message: `${action} refused: ${e.message}` };
  }

  const result = runAppleScript(script, { timeout: 60000, appName: "Calendar" });
  if (!result.ok) return { ok: false, message: failure(action, summary, result, [updates.description || ""]) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "event updated", { event_id: eventId, changed: changed.join(", ") })
  };
}

/**
 * Delete via Calendar.app `delete` (the dictionary has no `remove` or
 * `move to trash`) using the AppleScript event `id` inside the owning
 * calendar. Do not `delete (every event whose uid …)` — that specifier
 * hangs on iCloud/CalDAV and Mini's 60s spawnSync timeout was then
 * classified as TCC. A detached `delete theEvent` after atmFindEvent
 * is also wrong (-1728). Lookup errors are not swallowed: a failed
 * delete must surface, then EventKit can run.
 */
export function buildRemoveEventScript(eventId, { calendarName = null } = {}) {
  const uidLit = asString(eventId);
  const scoped = calendarName
    ? `  set targetCals to {}
  repeat with calRef in calendars
    try
      set cal to contents of calRef
      if (name of cal) is ${asString(calendarName)} then
        set end of targetCals to cal
        exit repeat
      end if
    end try
  end repeat
  if (count of targetCals) is 0 then error "CALENDAR_NOT_FOUND"`
    : `  set targetCals to calendars`;

  return `tell application "Calendar"
${scoped}
  repeat with calRef in targetCals
    set cal to contents of calRef
    set hits to {}
    try
      set hits to (every event of cal whose uid is ${uidLit})
    end try
    if (count of hits) > 0 then
      set theEvent to item 1 of hits
      set removedTitle to summary of theEvent
      set evId to id of theEvent
      try
        with timeout of 20 seconds
          delete (event id evId of cal)
        end timeout
      on error err1 number n1
        if n1 is -1712 then error "DELETE_TIMEOUT: " & err1
        try
          with timeout of 20 seconds
            tell cal
              delete theEvent
            end tell
          end timeout
        on error err2 number n2
          if n2 is -1712 then error "DELETE_TIMEOUT: " & err2
          error "DELETE_FAILED: " & err2 number n2
        end try
      end try
      try
        reload calendars
      end try
      return removedTitle
    end if
  end repeat
end tell
error "EVENT_NOT_FOUND"`;
}

export function calendarRemove(args = {}) {
  const action = "calendar_remove";

  const eventId = validateEventId(args.event_id);
  if (!eventId) {
    return { ok: false, message: `${action} refused: event_id is required (the "Event ID" from calendar_date). Deletes never run on a guessed id.` };
  }

  const calendarName = args.calendar_name === undefined || args.calendar_name === null || args.calendar_name === ""
    ? null
    : validateCalendarName(args.calendar_name);
  if (args.calendar_name && !calendarName) {
    return { ok: false, message: `${action} refused: calendar_name must match a calendar from calendar_list_calendars.` };
  }

  const eventKitId = args.eventkit_id === undefined || args.eventkit_id === null || args.eventkit_id === ""
    ? null
    : validateEventKitId(args.eventkit_id);
  if (args.eventkit_id && !eventKitId) {
    return { ok: false, message: `${action} refused: eventkit_id is not a valid EventKit eventIdentifier.` };
  }

  const summary = calendarName
    ? `delete calendar event ${eventId} from "${calendarName}"`
    : `delete calendar event ${eventId}`;
  const plan = planWrite({
    action,
    summary,
    destructive: true,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  // writeOnly cannot re-query; prefer the EventKit session that cached
  // the EKEvent from create. One-shot lookup is a full-access fallback.
  const sessionReply = eventKitSessionRequest({
    op: "remove",
    ids: eventKitLookupIds(eventId, eventKitId)
  });
  if (sessionReply && sessionReply.ok) {
    return {
      ok: true,
      message: writeSuccessMessage(action, "event deleted", {
        event_id: eventId,
        via: "EventKit",
        eventkit_id: eventKitId || undefined
      })
    };
  }
  if (sessionReply && !sessionReply.ok && !sessionReply.sessionDead && eventKitId) {
    return describeEventKitWriteFailure(action, summary, {
      ok: false,
      error: sessionReply.error || "EVENTKIT_SESSION_REMOVE_FAILED",
      kind: "not_found"
    });
  }

  const eventKitResult = runAppleScript(buildEventKitRemoveScript(eventId, { eventKitId }), {
    timeout: 20000,
    appName: "Calendar",
    language: "JavaScript"
  });
  if (eventKitResult.ok) {
    return {
      ok: true,
      message: writeSuccessMessage(action, "event deleted", {
        event_id: eventId,
        via: "EventKit",
        eventkit_id: eventKitId || undefined
      })
    };
  }

  if (eventKitId) {
    return describeEventKitWriteFailure(action, summary, eventKitResult);
  }

  const result = runAppleScript(buildRemoveEventScript(eventId, { calendarName }), {
    timeout: 25000,
    appName: "Calendar"
  });
  if (result.ok) {
    return {
      ok: true,
      message: writeSuccessMessage(action, "event deleted", {
        event_id: eventId,
        title: truncate(result.output, 150) || undefined
      })
    };
  }

  return describeCalendarRemoveFailure(action, summary, result, eventKitResult);
}

export function buildRsvpScript({ eventId, status, attendeeEmail }) {
  // Calendar.app's AppleScript dictionary defines `participation status` as
  // one of unknown/accepted/declined/tentative (confirmed via `sdef`/aete
  // dump) -- there is no "needs action" term, so that bare two-word phrase
  // was a syntax error (AppleScript parsed "needs" as an identifier and
  // choked on "action" where it expected "then"). `unknown` is the correct
  // term for "no answer yet".
  const match = attendeeEmail
    ? `    if (email of att) is ${asString(attendeeEmail)} then set theAttendee to att`
    : `    try
      if (participation status of att) is unknown then set theAttendee to att
    end try`;

  return `${findEventHandler()}

set theEvent to atmFindEvent(${asString(eventId)})
tell application "Calendar"
  set theAttendee to missing value
  repeat with att in attendees of theEvent
${match}
  end repeat
  if theAttendee is missing value then error "ATTENDEE_NOT_FOUND"
  try
    set participation status of theAttendee to ${status}
  on error errText
    error "RSVP_NOT_SUPPORTED: " & errText
  end try
  set rsvpTitle to summary of theEvent
end tell
return rsvpTitle`;
}

/**
 * RSVP to an invitation.
 *
 * Calendar.app exposes `participation status` on attendees but some macOS
 * versions refuse to write it from AppleScript. When that happens the tool
 * reports the refusal instead of silently doing nothing.
 */
export function calendarRsvp(args = {}) {
  const action = "calendar_rsvp";

  const eventId = validateEventId(args.event_id);
  if (!eventId) {
    return { ok: false, message: `${action} refused: event_id is required (the "Event ID" from calendar_date).` };
  }

  const responseRaw = args.response === undefined ? "" : String(args.response).toLowerCase();
  if (!RSVP_RESPONSES.includes(responseRaw)) {
    return { ok: false, message: `${action} refused: response must be one of: ${RSVP_RESPONSES.join(", ")}` };
  }

  let attendeeEmail = null;
  if (args.attendee_email) {
    const list = normalizeList(args.attendee_email);
    attendeeEmail = list[0] || null;
    if (attendeeEmail && !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(attendeeEmail)) {
      return { ok: false, message: `${action} refused: attendee_email is not a valid address` };
    }
  }

  const summary = `RSVP ${responseRaw} to event ${eventId}`;
  const plan = planWrite({ action, summary, dryRun: isFlagTrue(args.dry_run), confirm: isFlagTrue(args.confirm) });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(
    buildRsvpScript({ eventId, status: RSVP_STATUS[responseRaw], attendeeEmail }),
    { timeout: 60000, appName: "Calendar" }
  );

  if (!result.ok) {
    const raw = String(result.error || "");
    if (raw.includes("ATTENDEE_NOT_FOUND")) {
      return {
        ok: false,
        message: `${action} failed — attempted to ${summary}. No matching attendee was found on that event; pass attendee_email for the invited address.`
      };
    }
    if (raw.includes("RSVP_NOT_SUPPORTED")) {
      return {
        ok: false,
        message: `${action} failed — attempted to ${summary}. Calendar.app refused to change the participation status on this macOS version; answer the invitation in Calendar directly.`
      };
    }
    return { ok: false, message: failure(action, summary, result) };
  }

  return {
    ok: true,
    message: writeSuccessMessage(action, `RSVP ${responseRaw} recorded`, {
      event_id: eventId,
      title: truncate(result.output, 150) || undefined
    })
  };
}

/**
 * First-run / upgrade probe: a live Calendar.app Apple Event that pops
 * Automation → Calendar. Listing only — no events are created, so nothing
 * is left behind.
 */
export function buildCalendarAutomationProbeScript() {
  return `tell application "Calendar"
  get name of every calendar
end tell
return "OK"`;
}

/**
 * Live Calendar Apple Events check. Not a dry_run. Does not create events.
 * @returns {{ ok: boolean, message: string, kind: string|null }}
 */
export function probeCalendarAutomation() {
  const action = "calendar_automation_probe";
  const summary = "list calendars in Calendar.app (Automation / Apple Events check; no events created)";
  const result = runAppleScript(buildCalendarAutomationProbeScript(), { timeout: 30000, appName: "Calendar" });
  if (!result.ok) {
    return { ok: false, message: failure(action, summary, result), kind: result.kind };
  }
  return {
    ok: true,
    kind: null,
    message: writeSuccessMessage(
      action,
      "Calendar Automation allowed (listed calendars; no events created)"
    )
  };
}
