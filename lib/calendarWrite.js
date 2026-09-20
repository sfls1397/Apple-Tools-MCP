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
  ATTRIBUTION_GUIDANCE
} from "./appleScript.js";
import {
  planWrite,
  validateEventId,
  validateCalendarName,
  validateBody,
  validateSubject,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  normalizeList,
  truncate
} from "./writeGuards.js";

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

function findEventHandler() {
  return `on atmFindEvent(theUid)
  tell application "Calendar"
    repeat with cal in calendars
      try
        set hits to (every event of cal whose uid is theUid)
        if (count of hits) > 0 then return item 1 of hits
      end try
    end repeat
  end tell
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
  if (result.kind === "tcc") {
    return `${action} failed — attempted to ${summary}. ${CALENDAR_TCC_GUIDANCE}`;
  }
  const raw = String(result.error || "");
  if (raw.includes("CALENDAR_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. That calendar does not exist; call calendar_list_calendars first.`;
  }
  if (raw.includes("EVENT_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. No event with that id was found; use the Event ID from calendar_date.`;
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
  if (!result.ok) {
    return { ok: false, message: failure(action, "list calendars", result) };
  }

  const calendars = result.output
    .split("|||")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name, writable] = entry.split("<<>>");
      return { name: name || "", writable: writable !== "no" };
    });

  if (calendars.length === 0) {
    return { ok: true, message: "No calendars found in Calendar.app." };
  }

  const lines = calendars.map((c) => `• ${c.name}${c.writable ? "" : " (read-only)"}`);
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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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

export function buildRemoveEventScript(eventId) {
  return `${findEventHandler()}

set theEvent to atmFindEvent(${asString(eventId)})
tell application "Calendar"
  set removedTitle to summary of theEvent
  delete theEvent
end tell
return removedTitle`;
}

export function calendarRemove(args = {}) {
  const action = "calendar_remove";

  const eventId = validateEventId(args.event_id);
  if (!eventId) {
    return { ok: false, message: `${action} refused: event_id is required (the "Event ID" from calendar_date). Deletes never run on a guessed id.` };
  }

  const summary = `delete calendar event ${eventId}`;
  const plan = planWrite({
    action,
    summary,
    destructive: true,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const result = runAppleScript(buildRemoveEventScript(eventId), { timeout: 60000, appName: "Calendar" });
  if (!result.ok) return { ok: false, message: failure(action, summary, result) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "event deleted", {
      event_id: eventId,
      title: truncate(result.output, 150) || undefined
    })
  };
}

export function buildRsvpScript({ eventId, status, attendeeEmail }) {
  const match = attendeeEmail
    ? `    if (email of att) is ${asString(attendeeEmail)} then set theAttendee to att`
    : `    try
      if (participation status of att) is needs action then set theAttendee to att
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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
