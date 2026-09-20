/**
 * Long-lived EventKit JXA worker.
 *
 * writeOnly (EKAuthorizationStatus = 4) can create an EKEvent and read
 * identifiers off that in-memory object, but cannot re-query via
 * eventWithIdentifier / calendarItemsWithExternalIdentifier — Mini 2cdf44d
 * failed add on a post-save lookup even though create returned ids.
 *
 * The indexer daemon therefore keeps one osascript process around and
 * caches the EKEvent objects from create so edit/remove can call
 * saveEvent / removeEvent without a fetch.
 *
 * stdin/stdout: one JSON object per line. Never interpolates commands
 * into a shell (`spawn`, `shell: false`).
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

let singleton = null;

export function setEventKitSession(session) {
  singleton = session || null;
}

export function getEventKitSession() {
  return singleton;
}

export function shouldStartEventKitSession({
  platform = process.platform,
  env = process.env
} = {}) {
  if (platform !== "darwin") return false;
  if (env.VITEST) return false;
  if (env.APPLE_TOOLS_EVENTKIT_SESSION === "0") return false;
  return true;
}

/**
 * JXA worker: create caches the EKEvent; update/remove use the cache.
 * create does not call findEventByIds.
 */
export function sessionPaths(home = process.env.HOME || "") {
  const root = home ? path.join(home, ".apple-tools-mcp") : path.join(os.tmpdir(), "atm-eventkit");
  const dir = path.join(root, "eventkit-session");
  return {
    root,
    dir,
    scriptPath: path.join(root, "eventkit-worker.jxa"),
    cmdPath: path.join(dir, "cmd.json"),
    rspPath: path.join(dir, "rsp.json")
  };
}

export function buildEventKitWorkerScript(helpers, paths = {}) {
  const cmdPath = JSON.stringify(paths.cmdPath || "");
  const rspPath = JSON.stringify(paths.rspPath || "");
  return `ObjC.import("EventKit");
ObjC.import("Foundation");
${helpers}

var store = $.EKEventStore.alloc.init;
var cache = {};

function remember(ev) {
  if (!ev) return;
  var keys = [
    jsString(ev.eventIdentifier),
    jsString(ev.calendarItemIdentifier),
    jsString(ev.calendarItemExternalIdentifier)
  ];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i]) cache[keys[i]] = ev;
  }
}

function forget(ev) {
  var keys = [];
  for (var k in cache) keys.push(k);
  for (var i = 0; i < keys.length; i++) {
    if (cache[keys[i]] === ev) delete cache[keys[i]];
  }
}

function resolve(ids) {
  if (!ids) return null;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (id && cache[id]) return cache[id];
  }
  return findEventByIds(store, ids);
}

var cmdPath = ${cmdPath};
var rspPath = ${rspPath};

function writeReply(s) {
  $.NSString.stringWithString(String(s) + "\\n").writeToFileAtomicallyEncodingError(rspPath, true, $.NSUTF8StringEncoding, null);
}

function fileExists(p) {
  try { return !!$.NSFileManager.defaultManager.fileExistsAtPath(p); } catch (e) { return false; }
}

function readCmd() {
  var str = $.NSString.stringWithContentsOfFileEncodingError(cmdPath, $.NSUTF8StringEncoding, null);
  return jsString(str);
}

function removeCmd() {
  try { $.NSFileManager.defaultManager.removeItemAtPathError(cmdPath, null); } catch (e) {}
}

function pickCalendar(calendarName) {
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
  if (!target && defaultCal && matchesWanted(defaultCal)) target = defaultCal;
  if (!target && writables.length === 1) target = writables[0];
  if (!target && defaultCal) target = defaultCal;
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  if (!target) {
    throw new Error("CALENDAR_NOT_FOUND status=" + status + " eventKitCalendars=" + count + " default=" + titleOf(defaultCal) + " defaultId=" + identifierOf(defaultCal));
  }
  return target;
}

function createEvent(cmd) {
  var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
  if (status === 1 || status === 2) throw new Error("EVENTKIT_DENIED status=" + status);
  var target = pickCalendar(cmd.calendarName);
  var event = null;
  try { event = $.EKEvent.eventWithEventStore(store); } catch (e) {}
  if (!event) {
    try { event = $.EKEvent.alloc.initWithEventStore(store); } catch (e2) {}
  }
  if (!event) throw new Error("EVENTKIT_NO_EVENT status=" + status);
  event.title = String(cmd.title || "");
  event.startDate = $.NSDate.dateWithTimeIntervalSince1970(Number(cmd.startSec));
  event.endDate = $.NSDate.dateWithTimeIntervalSince1970(Number(cmd.endSec));
  event.allDay = !!cmd.allDay;
  try { event.calendar = target; } catch (e) {}
  try { if (event.setCalendar) event.setCalendar(target); } catch (e) {}
  if (cmd.location) event.location = String(cmd.location);
  if (cmd.notes) event.notes = String(cmd.notes);
  var alerts = cmd.alerts || [];
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
  remember(event);
  var externalId = "";
  var localId = "";
  var itemId = "";
  try { externalId = jsString(event.calendarItemExternalIdentifier); } catch (e) {}
  try { localId = jsString(event.eventIdentifier); } catch (e) {}
  try { itemId = jsString(event.calendarItemIdentifier); } catch (e) {}
  if (!externalId && !localId && !itemId) throw new Error("EVENTKIT_NO_ID status=" + status);
  return externalId + "<<>>" + localId + "<<>>" + titleOf(target) + "<<>>" + itemId;
}

function updateEvent(cmd) {
  var event = resolve(cmd.ids);
  if (!event) {
    var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
    throw new Error("EVENTKIT_NOT_FOUND status=" + status + (status === 4 ? " writeOnly" : "") + " sessionMiss tried=" + (cmd.ids || []).join(","));
  }
  if (cmd.title !== undefined && cmd.title !== null) event.title = String(cmd.title);
  if (cmd.location !== undefined && cmd.location !== null) event.location = String(cmd.location);
  if (cmd.notes !== undefined && cmd.notes !== null) event.notes = String(cmd.notes);
  if (cmd.startSec !== undefined && cmd.startSec !== null) {
    event.startDate = $.NSDate.dateWithTimeIntervalSince1970(Number(cmd.startSec));
  }
  if (cmd.endSec !== undefined && cmd.endSec !== null) {
    event.endDate = $.NSDate.dateWithTimeIntervalSince1970(Number(cmd.endSec));
  }
  if (cmd.clearAlerts) {
    try { event.alarms = $.NSMutableArray.array; } catch (e) {}
  }
  var alerts = cmd.alerts || [];
  if (alerts && alerts.length) {
    var alarms = $.NSMutableArray.array;
    for (var a = 0; a < alerts.length; a++) {
      alarms.addObject($.EKAlarm.alarmWithRelativeOffset(-Number(alerts[a]) * 60));
    }
    event.alarms = alarms;
  }
  var err = Ref();
  var ok = store.saveEventSpanCommitError(event, $.EKSpanThisEvent, true, err);
  if (!ok) {
    var desc = "unknown";
    try { desc = String(err[0]); } catch (e) {}
    throw new Error("EVENTKIT_SAVE_FAILED: " + desc);
  }
  remember(event);
  return jsString(event.eventIdentifier) || jsString(event.calendarItemExternalIdentifier) || "1";
}

function removeEvent(cmd) {
  var event = resolve(cmd.ids);
  if (!event) {
    var status = $.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent);
    throw new Error("EVENTKIT_NOT_FOUND status=" + status + (status === 4 ? " writeOnly" : "") + " sessionMiss tried=" + (cmd.ids || []).join(","));
  }
  var err = Ref();
  var ok = store.removeEventSpanCommitError(event, $.EKSpanThisEvent, true, err);
  if (!ok) {
    var desc = "unknown";
    try { desc = String(err[0]); } catch (e) {}
    throw new Error("EVENTKIT_REMOVE_FAILED: " + desc);
  }
  forget(event);
  return "1";
}

function handle(cmd) {
  if (!cmd || !cmd.op) throw new Error("EVENTKIT_BAD_CMD");
  if (cmd.op === "ping") return "pong";
  if (cmd.op === "create") return createEvent(cmd);
  if (cmd.op === "update") return updateEvent(cmd);
  if (cmd.op === "remove") return removeEvent(cmd);
  if (cmd.op === "quit") return "bye";
  throw new Error("EVENTKIT_BAD_OP");
}

while (true) {
  if (!fileExists(cmdPath)) {
    delay(0.05);
    continue;
  }
  var line = readCmd();
  removeCmd();
  line = String(line || "").replace(/^\\s+|\\s+$/g, "");
  if (!line) continue;
  try {
    var cmd = JSON.parse(line);
    var output = handle(cmd);
    writeReply(JSON.stringify({ ok: true, output: String(output == null ? "" : output) }));
    if (cmd.op === "quit") break;
  } catch (e) {
    writeReply(JSON.stringify({ ok: false, error: String(e) }));
  }
}
`;
}

export function workerScriptPath(home = process.env.HOME || "") {
  return sessionPaths(home).scriptPath;
}

export function startEventKitSession({
  helpers,
  spawnImpl = spawn,
  home = process.env.HOME || "",
  timeoutMs = 30000,
  sleep = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
} = {}) {
  if (!helpers) throw new Error("EventKit worker helpers are required");
  const paths = sessionPaths(home);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(paths.cmdPath); } catch { /* ignore */ }
  try { fs.unlinkSync(paths.rspPath); } catch { /* ignore */ }
  fs.writeFileSync(paths.scriptPath, buildEventKitWorkerScript(helpers, paths), { mode: 0o600 });

  const child = spawnImpl("osascript", ["-l", "JavaScript", paths.scriptPath], {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false
  });

  let dead = false;
  if (child.on) {
    child.on("exit", () => {
      dead = true;
    });
  }

  function request(cmd, waitMs = timeoutMs) {
    if (dead) throw new Error("EVENTKIT_SESSION_DEAD");
    try { fs.unlinkSync(paths.rspPath); } catch { /* ignore */ }
    fs.writeFileSync(paths.cmdPath, JSON.stringify(cmd), { mode: 0o600 });
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (fs.existsSync(paths.rspPath)) {
        const text = fs.readFileSync(paths.rspPath, "utf8").trim();
        try { fs.unlinkSync(paths.rspPath); } catch { /* ignore */ }
        return JSON.parse(text);
      }
      sleep(20);
    }
    throw new Error("EVENTKIT_SESSION_TIMEOUT");
  }

  const pong = request({ op: "ping" });
  if (!pong || pong.ok !== true || pong.output !== "pong") {
    try { child.kill(); } catch { /* ignore */ }
    throw new Error("EVENTKIT_SESSION_HANDSHAKE");
  }

  return {
    request,
    close() {
      try { request({ op: "quit" }, 2000); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      dead = true;
    }
  };
}

export function ensureEventKitSession(opts = {}) {
  if (singleton) return singleton;
  if (!shouldStartEventKitSession(opts)) return null;
  try {
    singleton = startEventKitSession(opts);
    return singleton;
  } catch {
    singleton = null;
    return null;
  }
}

export function closeEventKitSession() {
  if (!singleton) return;
  try { singleton.close(); } catch { /* ignore */ }
  singleton = null;
}
