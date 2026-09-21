/**
 * Apple Mail write operations: send, reply, forward, draft, mark read/unread,
 * archive, trash.
 *
 * Messages are addressed by their RFC822 Message-ID (Mail's `message id`
 * property). `file_path` from mail_search / mail_recent is also accepted and
 * is resolved to a Message-ID by reading the .emlx headers, so callers never
 * have to invent an identifier.
 *
 * After a real send (and after a send/reply/forward hang), Sent and Outbox
 * are checked before the tool reports success. AppleScript `send` returning
 * without throw is not enough. A message already in Sent or still in Outbox
 * is success — never a TCC fail. Hang recover matches To + subject (and
 * Message-ID when available), never subject alone. ETIMEDOUT / -1712 is a
 * timeout (find/reply/open before send too); -1743 / -10004 is a hard deny.
 */

import fs from "fs";
import path from "path";
import { validateEmailPath, unfoldRfc822Headers, safeMatch, stripHtmlTags } from "./validators.js";
import {
  runAppleScript,
  asString,
  asInteger,
  MAIL_TCC_GUIDANCE,
  MAIL_SEND_TIMEOUT_GUIDANCE,
  MAIL_ACCESSIBILITY_GUIDANCE,
  MAIL_GUI_SCRIPTING_GUIDANCE,
  MAIL_APP_NOT_RUNNING_GUIDANCE,
  ATTRIBUTION_GUIDANCE,
  isHardTccDenial
} from "./appleScript.js";
import { isIndexerMode } from "./processMode.js";
import {
  planWrite,
  plannedWriteResult,
  validateEmailList,
  validateBody,
  validateSubject,
  validateMessageId,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  truncate
} from "./writeGuards.js";

const MAIL_DIR = path.join(process.env.HOME || "", "Library", "Mail");

/**
 * Resolve the Mail message id from either an explicit id or an .emlx path.
 * @returns {{ messageId: string|null, error: string|null }}
 */
export function resolveMailMessageId({ messageId, filePath } = {}) {
  if (messageId) {
    const valid = validateMessageId(messageId);
    if (!valid) return { messageId: null, error: "message_id is not a valid RFC822 Message-ID" };
    return { messageId: valid, error: null };
  }

  if (!filePath) {
    return {
      messageId: null,
      error: "message_id is required (or file_path from mail_search / mail_recent). This tool will not guess which message you meant."
    };
  }

  let resolvedPath;
  try {
    resolvedPath = validateEmailPath(filePath, MAIL_DIR);
  } catch (e) {
    return { messageId: null, error: `file_path rejected: ${e.message}` };
  }

  let raw;
  try {
    raw = fs.readFileSync(resolvedPath, "utf-8");
  } catch (e) {
    return { messageId: null, error: `Could not read the email file (${e.code || "read error"})` };
  }

  const headerMatch = safeMatch(unfoldRfc822Headers(raw), /^Message-ID:\s*(.+)$/im, 200000);
  const found = headerMatch && headerMatch[1] ? validateMessageId(headerMatch[1].trim()) : null;
  if (!found) {
    return { messageId: null, error: "That email has no usable Message-ID header; pass message_id explicitly." };
  }
  return { messageId: found, error: null };
}

/**
 * AppleScript handler that locates a message by Message-ID. Checks inbox
 * first, then every mailbox of every account.
 */
function findMessageHandler() {
  return `on atmFindMessage(msgId)
  tell application "Mail"
    try
      set quickHits to (messages of inbox whose message id is msgId)
      if (count of quickHits) > 0 then return item 1 of quickHits
    end try
    repeat with acct in accounts
      try
        repeat with mb in (every mailbox of acct)
          try
            set hits to (messages of mb whose message id is msgId)
            if (count of hits) > 0 then return item 1 of hits
          end try
        end repeat
      end try
    end repeat
  end tell
  error "MESSAGE_NOT_FOUND"
end atmFindMessage`;
}

function recipientLines(addresses, kind) {
  return addresses
    .map((address) => `    make new ${kind} at end of ${kind}s with properties {address:${asString(address)}}`)
    .join("\n");
}

/**
 * Ship-gate / first-run probe: the compose verb that hangs when node → Mail
 * Automation is denied. `tell Mail to get name` is not enough — Mini
 * diagnosis showed that returns while `make new outgoing message` blocks.
 * Nothing is sent; the outgoing message is deleted immediately.
 */
export const MAIL_AUTOMATION_PROBE_SUBJECT = "ATM Mail Automation probe";

export function buildMailAutomationProbeScript() {
  return `tell application "Mail"
  set probe to make new outgoing message with properties {subject:${asString(MAIL_AUTOMATION_PROBE_SUBJECT)}, content:"", visible:false}
  delete probe
end tell
return "OK"`;
}

/**
 * Live Mail Apple Events check. Not a dry_run: that path never talks to Mail.
 * @returns {{ ok: boolean, message: string }}
 */
export function probeMailAutomation() {
  const action = "mail_automation_probe";
  const summary = "compose a temporary outgoing message in Mail (Automation / Apple Events check; nothing is sent)";
  const result = runAppleScript(buildMailAutomationProbeScript(), { timeout: 30000, appName: "Mail" });
  if (!result.ok) {
    return { ok: false, message: failure(action, summary, result, []), kind: result.kind };
  }
  return {
    ok: true,
    kind: null,
    message: writeSuccessMessage(
      action,
      "Mail Automation allowed (composed and discarded a temporary outgoing message; nothing was sent)"
    )
  };
}

export const ACCESSIBILITY_DENIED_SENTINEL = "ACCESSIBILITY_DENIED";
export const BODY_PASTE_MISDIRECTED_SENTINEL = "BODY_PASTE_MISDIRECTED";
export const BODY_FOCUS_FAILED_SENTINEL = "BODY_FOCUS_FAILED";
export const GUI_SCRIPTING_UNAVAILABLE_SENTINEL = "GUI_SCRIPTING_UNAVAILABLE";
export const SYSTEM_EVENTS_PROBE_MARKER = "ATM_SYSTEM_EVENTS_PROBE";
/** Compose body AX height vs To/Subject/Cc fields (those are ~22px). Used to reject short header AXTextAreas after Tab; does not walk windows. */
export const MAIL_BODY_MIN_AX_HEIGHT = 50;
/** Mini-proven Tab count from default compose focus into the body. */
export const MAIL_BODY_TAB_MAX = 6;
/** Cheap System Events Automation probe used before compose; SIGKILL if it still hangs. */
export const MAIL_SE_PROBE_TIMEOUT_MS = 4000;
/** First-run / upgrade permissions probe: long enough for the Allow click. */
export const SYSTEM_EVENTS_AUTOMATION_PROBE_TIMEOUT_MS = 30000;
/** Compose osascript budget (make + keystroke + send). Far below the ~60s SE wedge. */
export const MAIL_COMPOSE_TIMEOUT_MS = 25000;
export const MAIL_SE_APPLEEVENT_TIMEOUT_SEC = 8;
export const MAIL_APPLEEVENT_TIMEOUT_SEC = 15;
export const MAIL_SE_PROBE_APPLEEVENT_TIMEOUT_SEC = 3;

/**
 * AppleScript ordinal/keyword tokens that fail compile in `set {a, b}`
 * lists on macOS 26.x (MacBook 26.1 + Mini 26.6.2: `th` → -2741).
 * Paste-focus handlers must not destructure into these names.
 */
export const ATM_APPLESCRIPT_RESERVED_SHORTS = Object.freeze([
  "th",
  "st",
  "nd",
  "rd",
  "to",
  "by",
  "id"
]);

/**
 * macOS 26.x System Events rejects the compound `focused UI element`
 * (MacBook 26.1 compile -2741; Mini 26.6.2 compile -2740). Hosts compile
 * these instead — same class of dictionary break as bare `web area`.
 */
export const ATM_FOCUSED_WHOSE_QUERY = "first UI element whose focused is true";
export const ATM_FOCUSED_AX_QUERY = 'value of attribute "AXFocusedUIElement"';

/**
 * Resolve the focused System Events element without `focused UI element`.
 * AXFocusedUIElement is tried first (nested caret); `whose focused is true`
 * is the compile-proven fallback. A process-level whose match can be the
 * key window — callers must still reject header roles / AXWindow.
 */
export function buildAtmFocusedElementHandler() {
  return `on atmFocusedElement()
  tell application "System Events"
    tell process "Mail"
      try
        set fe to ${ATM_FOCUSED_AX_QUERY}
        if fe is not missing value then return fe
      end try
      try
        return ${ATM_FOCUSED_WHOSE_QUERY}
      end try
    end tell
  end tell
  return missing value
end atmFocusedElement`;
}

/**
 * Body text for native Mail compose (keystroke / paste, not AppleScript content).
 *
 * HTML is tag-stripped so a plain-looking HTML body (`<p>…</p>`) becomes
 * typed text. Never prefixes lines with `>` and never emits
 * `<blockquote>` — AppleScript `content` / `html content` cite-wrap
 * (FB11734014). Mail's `mailto` command is not used: on current Mini/MacBook
 * Mail it does not return an outgoing message (`newMessage` stays undefined,
 * AppleScript -2753).
 */
export function composeNativeBody(body, { html = false } = {}) {
  if (html) return stripHtmlTags(body);
  return body === undefined || body === null ? "" : String(body);
}

/**
 * Distinctive first line used to prove the native editor received the body.
 * Full multiline `contains` can miss when Mail stores an HTML alternative.
 */
export function composeBodyNeedle(body) {
  const text = body === undefined || body === null ? "" : String(body);
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) || text;
  const needle = line.trim();
  return needle.length > 120 ? needle.slice(0, 120) : needle;
}

export function isSystemEventsProbeScript(script) {
  return String(script || "").includes(SYSTEM_EVENTS_PROBE_MARKER);
}

export function buildSystemEventsProbeScript() {
  const secs = asInteger(MAIL_SE_PROBE_APPLEEVENT_TIMEOUT_SEC, {
    min: 1,
    max: 15,
    field: "seProbeTimeout"
  });
  return `-- ${SYSTEM_EVENTS_PROBE_MARKER}
with timeout of ${secs} seconds
  tell application "System Events"
    set atmName to name
    if atmName is "" then error "${GUI_SCRIPTING_UNAVAILABLE_SENTINEL}"
    set atmUi to UI elements enabled
  end tell
end timeout
if atmUi is false then error "${ACCESSIBILITY_DENIED_SENTINEL}"
return "OK"`;
}

export function probeSystemEventsGui({ timeout = MAIL_SE_PROBE_TIMEOUT_MS } = {}) {
  return runAppleScript(buildSystemEventsProbeScript(), {
    timeout
  });
}

/**
 * First-run / upgrade probe: a live System Events Apple Event that pops
 * Automation → System Events. Does not type into the focused UI.
 * Timeout is long enough for the operator to click Allow.
 * @returns {{ ok: boolean, message: string, kind: string|null }}
 */
export function probeSystemEventsAutomation() {
  const action = "system_events_automation_probe";
  const summary = "ask System Events for its name (Automation / Apple Events check; nothing is typed)";
  const result = probeSystemEventsGui({ timeout: SYSTEM_EVENTS_AUTOMATION_PROBE_TIMEOUT_MS });
  if (!result.ok) {
    const kind = systemEventsGrantKind(result);
    const guidance = isMailAccessibilityDenial(result)
      ? MAIL_ACCESSIBILITY_GUIDANCE
      : MAIL_GUI_SCRIPTING_GUIDANCE;
    return {
      ok: false,
      kind,
      message: `${action} failed — attempted to ${summary}. ${guidance}`
    };
  }
  return {
    ok: true,
    kind: null,
    message: writeSuccessMessage(
      action,
      "System Events Automation allowed (process name read; nothing was typed)"
    )
  };
}

function systemEventsGrantKind(result) {
  if (!result) return "unknown";
  if (result.kind === "timeout" || result.kind === "tcc" || result.kind === "attribution") {
    return result.kind;
  }
  if (isMailGuiScriptingUnavailable(result) || isMailAccessibilityDenial(result)) {
    return "tcc";
  }
  return result.kind || "unknown";
}

/**
 * AppleScript handlers: Tab into the compose body and type it (typed Returns
 * preserve newlines). Does not walk System Events `windows of process Mail`
 * (macOS 26 reports 0). Calibration / verify uses the focused AX role (and
 * AX value when it is readable) — never live Mail `content of` the outgoing
 * message. Dual-host Mail 16 / macOS 26: `set content` reads back via
 * `content of`, but Tab + keystroke/paste into the UI body never appears in
 * `content of` (`typedSeen=false`, bodyLen 0) even when typing still produces
 * a plain Sent `.emlx`. Never `set content` / `html content` (FB11734014).
 *
 * Tab count is unchanged (MAIL_BODY_TAB_MAX, Mini-proven 6). Fail-closed if
 * AX focus is not a body role after Tab. Cmd-V only if AX value is readable
 * and the needle is still missing. Header checks stay. System Events Apple
 * events are wrapped in `with timeout`.
 */
export function buildMailBodyPasteHandler() {
  const tabMax = asInteger(MAIL_BODY_TAB_MAX, { min: 1, max: 12, field: "tabMax" });
  const seSecs = asInteger(MAIL_SE_APPLEEVENT_TIMEOUT_SEC, { min: 1, max: 30, field: "seTimeout" });
  const bodyMinH = asInteger(MAIL_BODY_MIN_AX_HEIGHT, { min: 1, max: 500, field: "bodyMinHeight" });
  return `${buildAtmFocusedElementHandler()}

on atmSafeToPaste()
  tell application "System Events"
    tell process "Mail"
      try
        set fe to my atmFocusedElement()
        if fe is missing value then return false
        set r to (role of fe) as string
        if r is "AXWindow" then return false
        if r is "AXTextField" then return false
        if r is "AXComboBox" then return false
        if r is "AXButton" then return false
        if r is "AXMenuButton" then return false
        if r is "AXPopUpButton" then return false
        set atmH to 0
        try
          set {atmW, atmH} to size of fe
        end try
        if r is "AXTextArea" and atmH > 0 and atmH < ${bodyMinH} then return false
        ignoring case
          set bits to ""
          try
            set bits to bits & (description of fe as string) & " "
          end try
          try
            set bits to bits & (name of fe as string) & " "
          end try
          if bits contains "To:" then return false
          if bits contains "Cc:" then return false
          if bits contains "Bcc:" then return false
          if bits contains "Subject" then return false
        end ignoring
        if r is "AXWebArea" then return true
        if r is "AXTextArea" then return true
        if atmH >= ${bodyMinH} then return true
      end try
      return false
    end tell
  end tell
end atmSafeToPaste

on atmAxFocusedValue()
  tell application "System Events"
    try
      set fe to my atmFocusedElement()
      if fe is missing value then return ""
      return value of fe as string
    end try
  end tell
  return ""
end atmAxFocusedValue

on atmSplitParagraphs(bodyText)
  set atmSavedDelim to AppleScript's text item delimiters
  set AppleScript's text item delimiters to return
  set atmCrParts to text items of bodyText
  set AppleScript's text item delimiters to linefeed
  set atmNorm to atmCrParts as string
  set atmLines to text items of atmNorm
  set AppleScript's text item delimiters to atmSavedDelim
  return atmLines
end atmSplitParagraphs

on atmSpacesForTabs(atmLine)
  set atmSavedDelim to AppleScript's text item delimiters
  set AppleScript's text item delimiters to tab
  set atmTabParts to text items of atmLine
  set AppleScript's text item delimiters to " "
  set atmOut to atmTabParts as string
  set AppleScript's text item delimiters to atmSavedDelim
  return atmOut
end atmSpacesForTabs

on atmKeystrokeText(atmText)
  set atmSafe to my atmSpacesForTabs(atmText)
  set atmLen to length of atmSafe
  if atmLen is 0 then return
  set atmPos to 1
  tell application "System Events"
    tell process "Mail"
      repeat while atmPos is less than or equal to atmLen
        set atmEndPos to atmPos + 31
        if atmEndPos > atmLen then set atmEndPos to atmLen
        keystroke (text atmPos thru atmEndPos of atmSafe)
        set atmPos to atmEndPos + 1
      end repeat
    end tell
  end tell
end atmKeystrokeText

on atmTabIntoMailBody(msg)
  tell application "Mail" to activate
  delay 0.25
  with timeout of ${seSecs} seconds
    tell application "System Events"
      tell process "Mail" to set frontmost to true
    end tell
  end timeout
  delay 0.08
  repeat with atmN from 0 to ${tabMax}
    if my atmSafeToPaste() then return
    if atmN is ${tabMax} then error "${BODY_FOCUS_FAILED_SENTINEL}"
    with timeout of ${seSecs} seconds
      tell application "System Events"
        tell process "Mail"
          key code 48
        end tell
      end tell
    end timeout
    delay 0.08
  end repeat
  error "${BODY_FOCUS_FAILED_SENTINEL}"
end atmTabIntoMailBody

on atmTypeMailBody(bodyText)
  set atmLines to my atmSplitParagraphs(bodyText)
  set atmLast to count of atmLines
  if atmLast is 0 then return
  with timeout of ${seSecs} seconds
    repeat with atmI from 1 to atmLast
      set atmLine to item atmI of atmLines as string
      my atmKeystrokeText(atmLine)
      if atmI < atmLast then
        tell application "System Events"
          tell process "Mail"
            key code 36
          end tell
        end tell
      end if
    end repeat
  end timeout
end atmTypeMailBody

on atmPasteMailBodyFallback(bodyText)
  set savedClip to ""
  set hadClip to false
  try
    set savedClip to the clipboard as text
    set hadClip to true
  end try
  set the clipboard to bodyText
  try
    with timeout of ${seSecs} seconds
      tell application "System Events"
        tell process "Mail"
          keystroke "v" using command down
        end tell
      end tell
    end timeout
    delay 0.15
  on error errMsg number errNum
    if hadClip then set the clipboard to savedClip
    if errMsg contains "assistive access" or errNum is -25211 then error "${ACCESSIBILITY_DENIED_SENTINEL}"
    error errMsg number errNum
  end try
  if hadClip then set the clipboard to savedClip
end atmPasteMailBodyFallback

on atmFillMailBody(bodyText, needle, msg)
  try
    atmTabIntoMailBody(msg)
    if my atmSafeToPaste() is false then error "${BODY_FOCUS_FAILED_SENTINEL}"
    atmTypeMailBody(bodyText)
    delay 0.12
    if needle is not "" then
      set atmAxVal to my atmAxFocusedValue()
      if atmAxVal is not "" then
        if atmAxVal does not contain needle then
          atmPasteMailBodyFallback(bodyText)
        end if
      end if
    end if
  on error errMsg number errNum
    if errMsg contains "assistive access" or errNum is -25211 then error "${ACCESSIBILITY_DENIED_SENTINEL}"
    if errMsg contains "${GUI_SCRIPTING_UNAVAILABLE_SENTINEL}" then error "${GUI_SCRIPTING_UNAVAILABLE_SENTINEL}"
    error errMsg number errNum
  end try
end atmFillMailBody`;
}

export const buildMailBodyFillHandler = buildMailBodyPasteHandler;

function composeMisdirectChecks({ to, cc = [], bcc = [], subject, body }) {
  const toCount = asInteger(to.length, { min: 1, max: 99, field: "toCount" });
  const ccCount = asInteger(cc.length, { min: 0, max: 99, field: "ccCount" });
  const bccCount = asInteger(bcc.length, { min: 0, max: 99, field: "bccCount" });
  const needle = composeBodyNeedle(body);
  const stillThere = to
    .map((address, i) => {
      const n = asInteger(i, { min: 0, max: 99, field: "recipientIndex" });
      return `    set atmWanted${n} to ${asString(address)}
    set atmFound${n} to false
    repeat with r in to recipients of newMessage
      if (address of r as string) is atmWanted${n} then set atmFound${n} to true
    end repeat
    if atmFound${n} is false then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"`;
    })
    .join("\n");
  const bodyCheck = needle
    ? `    set atmAxVal to my atmAxFocusedValue()
    if atmAxVal is not "" then
      if atmAxVal does not contain ${asString(needle)} then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"
    end if`
    : "";
  return `    if (count of to recipients of newMessage) is not ${toCount} then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"
    if (count of cc recipients of newMessage) is not ${ccCount} then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"
    if (count of bcc recipients of newMessage) is not ${bccCount} then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"
${stillThere}
    if (subject of newMessage as string) is not ${asString(subject)} then error "${BODY_PASTE_MISDIRECTED_SENTINEL}"
${bodyCheck}`;
}

/**
 * Build the outgoing-message script shared by send and draft.
 *
 * Always `make new outgoing message` (no `content:`) so `newMessage` is a
 * real Mail object — Mail's `mailto` command is a no-op / non-returning
 * on Mini+MacBook and left `newMessage` undefined (-2753).
 *
 * Do not set AppleScript `content` or `html content`: Ventura+ FB11734014
 * cite-wraps those setters (`>` prefixes + `<blockquote type="cite">`).
 * Recipients and subject are AppleScript properties (never paste). The body
 * is typed into the native compose editor via System Events (Tab into body
 * until AX focused role is a body field, typed Returns for newlines, Cmd-V
 * only if AX value is readable and the needle is still missing). Do not walk
 * `windows of process Mail`. Do not use Mail `content of` as the oracle that
 * typed/pasted text landed (Mail 16 / macOS 26: that property stays empty).
 * If AX body focus cannot be established, or headers change, abort + delete
 * (nothing sent). Ship prove that the body landed is Sent `.emlx` after send.
 */
export function buildComposeScript({ to, cc, bcc, subject, body, send, html = false }) {
  const recipients = [
    recipientLines(to, "to recipient"),
    recipientLines(cc, "cc recipient"),
    recipientLines(bcc, "bcc recipient")
  ].filter((block) => block.length > 0).join("\n");

  const mailSecs = asInteger(MAIL_APPLEEVENT_TIMEOUT_SEC, { min: 1, max: 60, field: "mailTimeout" });
  const plainBody = composeNativeBody(body, { html });
  const needle = composeBodyNeedle(plainBody);
  const pasteAndVerify = plainBody
    ? `  atmFillMailBody(${asString(plainBody)}, ${asString(needle)}, newMessage)
  tell application "Mail"
${composeMisdirectChecks({ to, cc, bcc, subject, body: plainBody })}
  end tell`
    : "";

  return `${buildMailBodyPasteHandler()}

tell application "Mail"
  with timeout of ${mailSecs} seconds
    set newMessage to make new outgoing message with properties {subject:${asString(subject)}, visible:true}
    tell newMessage
${recipients}
    end tell
    activate
  end timeout
end tell
try
${pasteAndVerify}
on error errMsg number errNum
  try
    tell application "Mail" to delete newMessage
  end try
  error errMsg number errNum
end try
set atmOutgoingId to ""
tell application "Mail"
  with timeout of ${mailSecs} seconds
    try
      set atmOutgoingId to message id of newMessage as string
    end try
    ${send ? "send newMessage" : "save newMessage"}
  end timeout
end tell
if atmOutgoingId is not "" then return atmOutgoingId
return "OK"`;
}

function summarizeRecipients(to, cc, bcc) {
  const parts = [];
  if (to.length) parts.push(`to ${to.join(", ")}`);
  if (cc.length) parts.push(`cc ${cc.join(", ")}`);
  if (bcc.length) parts.push(`bcc ${bcc.length} recipient${bcc.length === 1 ? "" : "s"}`);
  return parts.join("; ");
}

export const SENT_VERIFY_SENT = "SENT";
export const SENT_VERIFY_OUTBOX = "OUTBOX";
export const SENT_VERIFY_NOT_FOUND = "NOT_FOUND";
/** Older hang-recovery scripts returned FOUND to mean Sent. Still accepted. */
export const SENT_VERIFY_FOUND = "FOUND";
export const SENT_VERIFY_TIMEOUT_MS = 15000;
export const SENT_VERIFY_ATTEMPTS = 3;
export const SENT_VERIFY_RETRY_MS = 400;

export const MAIL_VERIFY_MISS_GUIDANCE =
  "Mail reported the send call succeeded, but the message was not found in Sent or Outbox. Do not assume it was delivered.";

function defaultSentVerifySleep(ms) {
  if (!ms || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Test hook: skip the retry delay without changing attempt count. */
export const sentVerifyClock = {
  sleep: defaultSentVerifySleep
};

export function resetSentVerifyClock() {
  sentVerifyClock.sleep = defaultSentVerifySleep;
}

/**
 * Hard Mail Automation deny: -1743 / -10004 / "not authorized…", or
 * classify kind `tcc`. A spawnSync hang is `timeout`, not this.
 */
export function isMailHardTcc(result) {
  if (!result) return false;
  if (result.kind === "tcc") return true;
  return isHardTccDenial(result.error);
}

/**
 * Find/reply/send hang (ETIMEDOUT / -1712). Not a hard TCC deny.
 */
export function isMailSendTimeout(result) {
  if (!result) return false;
  if (result.kind !== "timeout") return false;
  return !isHardTccDenial(result.error);
}

function mailBoxesPreamble() {
  return `  set cutoff to (current date) - (10 * minutes)
  set boxes to {}
  try
    set end of boxes to outgoing mailbox
  end try
  try
    set end of boxes to sent mailbox
  end try
  repeat with acct in accounts
    try
      set end of boxes to sent mailbox of acct
    end try
  end repeat`;
}

function appleScriptToList(addresses = []) {
  return `{${addresses.map((address) => asString(address)).join(", ")}}`;
}

function loadMailboxMessagesSnippet() {
  return `      set recentMsgs to {}
      set scanAll to false
      try
        if boxRef is outgoing mailbox then set scanAll to true
      end try
      try
        set nm to name of boxRef as string
        if nm contains "Outbox" then set scanAll to true
        if nm contains "Outgoing" then set scanAll to true
      end try
      if scanAll then
        set recentMsgs to messages of boxRef
      else
        set recentMsgs to (messages of boxRef whose date sent > cutoff)
      end if`;
}

function verifyHitReturn() {
  return `              try
                if boxRef is outgoing mailbox then return "${SENT_VERIFY_OUTBOX}"
              end try
              try
                set nm to name of boxRef as string
                if nm contains "Outbox" then return "${SENT_VERIFY_OUTBOX}"
                if nm contains "Outgoing" then return "${SENT_VERIFY_OUTBOX}"
              end try
              return "${SENT_VERIFY_SENT}"`;
}

function recipientHitSnippet() {
  return `            set hitTo to false
            try
              repeat with recip in (to recipients of msg)
                set recipAddr to address of recip as string
                repeat with wanted in wantedTos
                  if recipAddr is (wanted as string) then set hitTo to true
                end repeat
              end repeat
            end try`;
}

/**
 * Look in Sent / Outbox for a reply of `messageId`.
 * Proper Mail replies set In-Reply-To. The fallback `make new outgoing
 * message` path does not, so also match exact "Re: " & original subject.
 * Never treat the original itself (or a Re: that merely contains the
 * original subject) as this send.
 */
export function buildFindSentByInReplyToScript(messageId) {
  const idLit = asString(messageId);
  const needleBare = asString(messageId);
  const needleAngle = asString(`<${messageId}>`);
  return `${findMessageHandler()}

set origSubject to ""
try
  set origMsg to atmFindMessage(${idLit})
  tell application "Mail" to set origSubject to subject of origMsg
end try
tell application "Mail"
${mailBoxesPreamble()}
  repeat with boxRef in boxes
    try
${loadMailboxMessagesSnippet()}
      repeat with msg in recentMsgs
        try
          set candId to message id of msg
          if candId is ${needleBare} then
            -- The original, not the reply we just sent.
          else
            try
              set src to source of msg
              if src contains ("In-Reply-To: " & ${needleAngle}) then
${verifyHitReturn()}
              end if
              if src contains ("In-Reply-To: " & ${needleBare}) then
${verifyHitReturn()}
              end if
            end try
            if origSubject is not "" then
              set subj to subject of msg
              if subj is ("Re: " & origSubject) then
${verifyHitReturn()}
              end if
            end if
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "${SENT_VERIFY_NOT_FOUND}"`;
}

/**
 * Look in Sent / Outbox for a forward of `messageId` to `toAddresses`.
 * Mail.app forwards do not set In-Reply-To / References — those headers are
 * replies. Require the intended recipient plus either an exact Fwd:/Fw:
 * subject or the original Message-ID in a forwarded body. Skip the original
 * itself, In-Reply-To hits, and unrelated Fwd: mail that only shares a To.
 */
export function buildFindSentForwardScript(messageId, toAddresses = []) {
  const idLit = asString(messageId);
  const needleBare = asString(messageId);
  const needleAngle = asString(`<${messageId}>`);
  const toList = appleScriptToList(toAddresses);
  return `${findMessageHandler()}

set origSubject to ""
try
  set origMsg to atmFindMessage(${idLit})
  tell application "Mail" to set origSubject to subject of origMsg
end try
tell application "Mail"
${mailBoxesPreamble()}
  set wantedTos to ${toList}
  repeat with boxRef in boxes
    try
${loadMailboxMessagesSnippet()}
      repeat with msg in recentMsgs
        try
          set candId to message id of msg
          if candId is ${needleBare} then
            -- The original, not the forward we just sent.
          else
            set src to source of msg
            if src contains ("In-Reply-To: " & ${needleAngle}) or src contains ("In-Reply-To: " & ${needleBare}) then
              -- A reply to the original is not this forward.
            else
${recipientHitSnippet()}
              if hitTo then
                set subj to subject of msg
                set exactFwd to false
                if origSubject is not "" then
                  if subj is ("Fwd: " & origSubject) then set exactFwd to true
                  if subj is ("Fw: " & origSubject) then set exactFwd to true
                  if subj is ("FW: " & origSubject) then set exactFwd to true
                  if subj is ("Forward: " & origSubject) then set exactFwd to true
                end if
                set looksForward to exactFwd
                if subj starts with "Fwd:" or subj starts with "Fw:" or subj starts with "FW:" or subj starts with "Forward:" then set looksForward to true
                if src contains "Begin forwarded message" then set looksForward to true
                set mentionsOrigId to false
                if src contains ${needleAngle} then set mentionsOrigId to true
                if src contains ${needleBare} then set mentionsOrigId to true
                if exactFwd then
${verifyHitReturn()}
                end if
                if looksForward and mentionsOrigId then
${verifyHitReturn()}
                end if
              end if
            end if
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "${SENT_VERIFY_NOT_FOUND}"`;
}

/**
 * Look in Sent / Outbox for a compose matching To + subject.
 * Never matches subject alone — short subjects like "test" are unsafe.
 * When `messageId` is present, prefer that id together with To.
 */
export function buildFindSentByRecipientAndSubjectScript(subject, toAddresses = [], messageId = null) {
  const toList = appleScriptToList(toAddresses);
  const subj = asString(subject || "");
  const idLit = messageId ? asString(messageId) : null;
  const matchBody = idLit
    ? `${recipientHitSnippet()}
            set candId to message id of msg
            set hitId to false
            try
              if candId is ${idLit} then set hitId to true
            end try
            if hitId and hitTo then
${verifyHitReturn()}
            end if
            if hitTo then
              set subj to subject of msg
              if subj is ${subj} then
${verifyHitReturn()}
              end if
            end if`
    : `${recipientHitSnippet()}
            if hitTo then
              set subj to subject of msg
              if subj is ${subj} then
${verifyHitReturn()}
              end if
            end if`;

  return `tell application "Mail"
${mailBoxesPreamble()}
  set wantedTos to ${toList}
  repeat with boxRef in boxes
    try
${loadMailboxMessagesSnippet()}
      repeat with msg in recentMsgs
        try
${matchBody}
        end try
      end repeat
    end try
  end repeat
end tell
return "${SENT_VERIFY_NOT_FOUND}"`;
}

/**
 * @deprecated Subject-only matching is unsafe. Requires To as the second
 * argument; without recipients the scan cannot hit.
 */
export function buildFindSentBySubjectScript(subject, toAddresses = []) {
  return buildFindSentByRecipientAndSubjectScript(subject, toAddresses);
}

export function parseSentVerifyOutput(output) {
  const out = String(output || "").trim();
  if (out === SENT_VERIFY_SENT || out === SENT_VERIFY_FOUND) {
    return { found: true, mailbox: "sent" };
  }
  if (out === SENT_VERIFY_OUTBOX) {
    return { found: true, mailbox: "outbox" };
  }
  return null;
}

export function parseOutgoingMessageId(output) {
  const raw = String(output || "").trim();
  if (!raw || raw === "OK") return null;
  return validateMessageId(raw);
}

function pickSentVerifyScript({
  inReplyTo = null,
  subject = null,
  forwardTo = null,
  to = null,
  messageId = null
} = {}) {
  if (forwardTo && inReplyTo) return buildFindSentForwardScript(inReplyTo, forwardTo);
  if (inReplyTo) return buildFindSentByInReplyToScript(inReplyTo);
  const toList = Array.isArray(to) ? to : [];
  if (toList.length > 0 && (subject || messageId)) {
    return buildFindSentByRecipientAndSubjectScript(subject || "", toList, messageId);
  }
  return null;
}

/**
 * After a send hang, ask Mail whether the message is already in Sent/Outbox.
 * Compose matches require To + subject (Message-ID when available) — never
 * subject alone. Returns a hit object or null. Verify failure is not success.
 */
export function recoverIfInSent(match = {}) {
  const script = pickSentVerifyScript(match);
  if (!script) return null;
  const result = runAppleScript(script, { timeout: SENT_VERIFY_TIMEOUT_MS, appName: "Mail" });
  if (!result.ok) return null;
  return parseSentVerifyOutput(result.output);
}

/**
 * Poll Sent/Outbox after a send that returned without throw.
 */
export function verifyQueuedMessage(match = {}, { attempts = SENT_VERIFY_ATTEMPTS, retryMs = SENT_VERIFY_RETRY_MS } = {}) {
  let last = null;
  const n = Math.max(1, attempts);
  for (let i = 0; i < n; i++) {
    last = recoverIfInSent(match);
    if (last) return last;
    if (i < n - 1) sentVerifyClock.sleep(retryMs);
  }
  return last;
}

export function isMailGuiScriptingUnavailable(result) {
  if (!result) return false;
  const text = String(result.error || "").toLowerCase();
  if (text.includes("gui_scripting_unavailable")) return true;
  if (result.kind === "timeout" && text.includes("system events")) return true;
  return false;
}

export function isMailAccessibilityDenial(result) {
  if (!result) return false;
  const text = String(result.error || "").toLowerCase();
  return text.includes("accessibility_denied") || text.includes("assistive access");
}

export function isMailBodyFocusFailed(result) {
  if (!result) return false;
  return String(result.error || "").toLowerCase().includes("body_focus_failed");
}

export function isMailBodyPasteMisdirected(result) {
  if (!result) return false;
  const text = String(result.error || "").toLowerCase();
  return text.includes("body_paste_misdirected") || text.includes("body_focus_failed");
}

function failure(action, summary, result, secrets) {
  const err = String((result && result.error) || "").toLowerCase();
  if (err.includes("gui_scripting_unavailable")) {
    return `${action} failed — attempted to ${summary}. ${MAIL_GUI_SCRIPTING_GUIDANCE}`;
  }
  if (err.includes("body_focus_failed")) {
    return `${action} failed — attempted to ${summary}. The compose caret could not be moved into the message body; nothing was sent.`;
  }
  if (err.includes("body_paste_misdirected")) {
    return `${action} failed — attempted to ${summary}. The body was pasted into a header field instead of the message body; nothing was sent.`;
  }
  if (isMailAccessibilityDenial(result)) {
    return `${action} failed — attempted to ${summary}. ${MAIL_ACCESSIBILITY_GUIDANCE}`;
  }
  if (result.kind === "tcc" || isHardTccDenial(result && result.error)) {
    return `${action} failed — attempted to ${summary}. ${MAIL_TCC_GUIDANCE}`;
  }
  if (result.kind === "timeout") {
    // Allowed hang / ETIMEDOUT / -1712 is never TCC — including pre-send find/reply/open.
    return `${action} failed — attempted to ${summary}. ${MAIL_SEND_TIMEOUT_GUIDANCE}`;
  }
  if (result.kind === "not_found") {
    return `${action} failed — attempted to ${summary}. The message could not be found in Mail. Pass a message_id from a current mail_search result.`;
  }
  if (result.kind === "app_not_running") {
    return `${action} failed — attempted to ${summary}. ${MAIL_APP_NOT_RUNNING_GUIDANCE}`;
  }
  if (result.kind === "attribution") {
    return `${action} failed — attempted to ${summary}. ${ATTRIBUTION_GUIDANCE}`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Mail.app could not be reached on this host.`;
  }
  return writeErrorMessage(action, summary, new Error(result.error || "unknown error"), secrets);
}

/**
 * Finish a compose/reply/forward. A real send is not success until Sent or
 * Outbox verify hits. A send hang is not labeled TCC; if Mail already
 * delivered, return success. Hard -1743/-10004 stays a deny.
 */
function deliverySummary(successSummary, mailbox, recovered) {
  if (mailbox === "outbox") {
    return recovered
      ? "queued in Outbox (still sending; verified after AppleScript hang)"
      : "queued in Outbox (still sending)";
  }
  return recovered
    ? `${successSummary} (verified in Sent after AppleScript hang)`
    : `${successSummary} (verified in Sent)`;
}

function sendVerifiedSuccess({ action, successSummary, details, verified, recovered }) {
  const mailbox = verified.mailbox;
  const delivered = mailbox === "sent";
  return {
    ok: true,
    delivered,
    mailbox,
    recovered: recovered || undefined,
    message: writeSuccessMessage(action, deliverySummary(successSummary, mailbox, recovered), {
      ...details,
      mailbox,
      delivery: delivered ? "sent" : "outbox"
    })
  };
}

function verifyMissMessage(action, summary) {
  return `${action} failed — attempted to ${summary}. ${MAIL_VERIFY_MISS_GUIDANCE}`;
}

function finalizeMailWrite({
  action,
  summary,
  result,
  secrets,
  sendNow,
  inReplyTo = null,
  subject = null,
  forwardTo = null,
  to = null,
  messageId = null,
  successSummary,
  details
}) {
  const match = { inReplyTo, subject, forwardTo, to, messageId };

  if (result.ok) {
    if (!sendNow) {
      return { ok: true, delivered: false, mailbox: null, message: writeSuccessMessage(action, successSummary, details) };
    }
    const verified = verifyQueuedMessage(match);
    if (!verified) {
      return { ok: false, delivered: false, mailbox: null, message: verifyMissMessage(action, summary) };
    }
    return sendVerifiedSuccess({ action, successSummary, details, verified, recovered: false });
  }

  if (sendNow && isMailSendTimeout(result)) {
    const recovered = recoverIfInSent(match);
    if (recovered) {
      return sendVerifiedSuccess({ action, successSummary, details, verified: recovered, recovered: true });
    }
    return { ok: false, delivered: false, mailbox: null, message: failure(action, summary, result, secrets) };
  }

  return { ok: false, delivered: false, mailbox: null, message: failure(action, summary, result, secrets) };
}

function guiScriptingUnavailableResult(action, summary, result, { indexerMode } = {}) {
  const unsupported = Boolean(indexerMode);
  const message = isMailAccessibilityDenial(result)
    ? `${action} failed — attempted to ${summary}. ${MAIL_ACCESSIBILITY_GUIDANCE}`
    : `${action} failed — attempted to ${summary}. ${MAIL_GUI_SCRIPTING_GUIDANCE}`;
  return {
    ok: false,
    delivered: false,
    mailbox: null,
    ...(unsupported ? { unsupported: true } : {}),
    message
  };
}

/**
 * Compose and send (or save as draft) a new email.
 */
export function mailCompose(args = {}, { draft = false, indexerMode = isIndexerMode() } = {}) {
  const action = draft ? "mail_draft" : "mail_send";

  const to = validateEmailList(args.to, "to");
  if (to.error) return { ok: false, message: `${action} refused: ${to.error}` };
  const cc = validateEmailList(args.cc, "cc");
  if (cc.error) return { ok: false, message: `${action} refused: ${cc.error}` };
  const bcc = validateEmailList(args.bcc, "bcc");
  if (bcc.error) return { ok: false, message: `${action} refused: ${bcc.error}` };

  if (to.addresses.length === 0) {
    return { ok: false, message: `${action} refused: at least one valid address in "to" is required. This tool never invents recipients.` };
  }

  const subject = validateSubject(args.subject, { required: !draft });
  if (subject.error) return { ok: false, message: `${action} refused: ${subject.error}` };
  const body = validateBody(args.body, { required: !draft });
  if (body.error) return { ok: false, message: `${action} refused: ${body.error}` };

  const bodyFormat = args.body_format === undefined ? "plain" : String(args.body_format).toLowerCase();
  if (bodyFormat !== "plain" && bodyFormat !== "html") {
    return { ok: false, message: `${action} refused: body_format must be "plain" or "html"` };
  }

  const recipientCount = to.addresses.length + cc.addresses.length + bcc.addresses.length;
  const summary = draft
    ? `save a draft ${summarizeRecipients(to.addresses, cc.addresses, bcc.addresses)} with subject "${truncate(subject.text, 120)}"`
    : `send mail ${summarizeRecipients(to.addresses, cc.addresses, bcc.addresses)} with subject "${truncate(subject.text, 120)}"`;

  // A draft is not delivery, so it does not need multi-recipient confirmation.
  const plan = planWrite({
    action,
    summary,
    recipientCount: draft ? 0 : recipientCount,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const plainBody = composeNativeBody(body.text, { html: bodyFormat === "html" });
  if (plainBody) {
    const se = probeSystemEventsGui();
    if (!se.ok) {
      return guiScriptingUnavailableResult(action, summary, se, { indexerMode });
    }
  }

  const script = buildComposeScript({
    to: to.addresses,
    cc: cc.addresses,
    bcc: bcc.addresses,
    subject: subject.text,
    body: body.text,
    send: !draft,
    html: bodyFormat === "html"
  });

  const result = runAppleScript(script, { timeout: MAIL_COMPOSE_TIMEOUT_MS, appName: "Mail" });
  if (
    !result.ok &&
    indexerMode &&
    (isMailGuiScriptingUnavailable(result) || isMailAccessibilityDenial(result))
  ) {
    return guiScriptingUnavailableResult(action, summary, result, { indexerMode });
  }
  return finalizeMailWrite({
    action,
    summary,
    result,
    secrets: [body.text, subject.text],
    sendNow: !draft,
    subject: draft ? null : subject.text,
    to: draft ? null : to.addresses,
    messageId: draft ? null : parseOutgoingMessageId(result.output),
    successSummary: draft ? "draft saved to Drafts" : "sent",
    details: {
      to: to.addresses.join(", "),
      cc: cc.addresses.join(", ") || undefined,
      bcc: bcc.addresses.length ? `${bcc.addresses.length} recipient(s)` : undefined,
      subject: truncate(subject.text, 150)
    }
  });
}

export function buildReplyScript({ messageId, body, replyAll, sendNow }) {
  return `${findMessageHandler()}

set theMessage to atmFindMessage(${asString(messageId)})
tell application "Mail"
  set theReply to missing value
  try
    set theReply to reply theMessage without opening window ${replyAll ? "with reply to all" : "without reply to all"}
  end try
  if theReply is missing value then
    -- Some Mail versions do not return the outgoing message from a reply.
    -- Fall back to a new message addressed to the original sender.
    set origSubject to subject of theMessage
    set origSender to extract address from (sender of theMessage)
    set theReply to make new outgoing message with properties {subject:("Re: " & origSubject), content:${asString(body)}, visible:false}
    tell theReply
      make new to recipient at end of to recipients with properties {address:origSender}
    end tell
  else
    tell theReply
      set content to ${asString(body)} & return & content
    end tell
  end if
  ${sendNow ? "send theReply" : "save theReply"}
end tell
return "OK"`;
}

export function mailReply(args = {}) {
  const action = "mail_reply";
  const resolved = resolveMailMessageId({ messageId: args.message_id, filePath: args.file_path });
  if (resolved.error) return { ok: false, message: `${action} refused: ${resolved.error}` };

  const body = validateBody(args.body, { required: true });
  if (body.error) return { ok: false, message: `${action} refused: ${body.error}` };

  const replyAll = isFlagTrue(args.reply_all);
  const sendNow = !isFlagTrue(args.save_as_draft);
  const summary = `${sendNow ? "send" : "draft"} a ${replyAll ? "reply-all" : "reply"} to message ${truncate(resolved.messageId, 120)}`;

  // reply-all fans out to every original recipient, so treat it like a
  // multi-recipient send and require confirmation.
  const plan = planWrite({
    action,
    summary,
    recipientCount: replyAll && sendNow ? 2 : 0,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(
    buildReplyScript({ messageId: resolved.messageId, body: body.text, replyAll, sendNow }),
    { timeout: 60000, appName: "Mail" }
  );
  return finalizeMailWrite({
    action,
    summary,
    result,
    secrets: [body.text],
    sendNow,
    inReplyTo: sendNow ? resolved.messageId : null,
    successSummary: sendNow ? "reply sent" : "reply saved to Drafts",
    details: {
      message_id: resolved.messageId,
      reply_all: String(replyAll)
    }
  });
}

export function buildForwardScript({ messageId, to, body, sendNow }) {
  return `${findMessageHandler()}

set theMessage to atmFindMessage(${asString(messageId)})
tell application "Mail"
  set theForward to missing value
  try
    set theForward to forward theMessage without opening window
  end try
  if theForward is missing value then error "FORWARD_UNSUPPORTED"
  tell theForward
    set content to ${asString(body)} & return & content
${to.map((address) => `    make new to recipient at end of to recipients with properties {address:${asString(address)}}`).join("\n")}
  end tell
  ${sendNow ? "send theForward" : "save theForward"}
end tell
return "OK"`;
}

export function mailForward(args = {}) {
  const action = "mail_forward";
  const resolved = resolveMailMessageId({ messageId: args.message_id, filePath: args.file_path });
  if (resolved.error) return { ok: false, message: `${action} refused: ${resolved.error}` };

  const to = validateEmailList(args.to, "to");
  if (to.error) return { ok: false, message: `${action} refused: ${to.error}` };
  if (to.addresses.length === 0) {
    return { ok: false, message: `${action} refused: at least one valid address in "to" is required.` };
  }
  const body = validateBody(args.body, { required: false });
  if (body.error) return { ok: false, message: `${action} refused: ${body.error}` };

  const sendNow = !isFlagTrue(args.save_as_draft);
  const summary = `${sendNow ? "forward" : "draft a forward of"} message ${truncate(resolved.messageId, 120)} to ${to.addresses.join(", ")}`;

  const plan = planWrite({
    action,
    summary,
    recipientCount: sendNow ? to.addresses.length : 0,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(
    buildForwardScript({ messageId: resolved.messageId, to: to.addresses, body: body.text, sendNow }),
    { timeout: 60000, appName: "Mail" }
  );
  return finalizeMailWrite({
    action,
    summary,
    result,
    secrets: [body.text],
    sendNow,
    inReplyTo: sendNow ? resolved.messageId : null,
    forwardTo: sendNow ? to.addresses : null,
    successSummary: sendNow ? "forwarded" : "forward saved to Drafts",
    details: {
      message_id: resolved.messageId,
      to: to.addresses.join(", ")
    }
  });
}

export function buildMarkScript({ messageId, read }) {
  return `${findMessageHandler()}

set theMessage to atmFindMessage(${asString(messageId)})
tell application "Mail"
  set read status of theMessage to ${read ? "true" : "false"}
end tell
return "OK"`;
}

export function mailMark(args = {}) {
  const action = "mail_mark";
  const status = args.status === undefined ? "read" : String(args.status).toLowerCase();
  if (status !== "read" && status !== "unread") {
    return { ok: false, message: `${action} refused: status must be "read" or "unread"` };
  }
  const resolved = resolveMailMessageId({ messageId: args.message_id, filePath: args.file_path });
  if (resolved.error) return { ok: false, message: `${action} refused: ${resolved.error}` };

  const summary = `mark message ${truncate(resolved.messageId, 120)} as ${status}`;
  const plan = planWrite({
    action,
    summary,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(buildMarkScript({ messageId: resolved.messageId, read: status === "read" }), { appName: "Mail" });
  if (!result.ok) return { ok: false, message: failure(action, summary, result, []) };

  return { ok: true, message: writeSuccessMessage(action, `marked as ${status}`, { message_id: resolved.messageId }) };
}

export function buildMoveScript({ messageId, mailboxNames, allowDeleteFallback }) {
  const candidates = mailboxNames
    .map((name) => `  if targetBox is missing value then
    try
      set targetBox to mailbox ${asString(name)} of acct
    end try
  end if`)
    .join("\n");

  return `${findMessageHandler()}

set theMessage to atmFindMessage(${asString(messageId)})
tell application "Mail"
  set acct to account of (mailbox of theMessage)
  set targetBox to missing value
${candidates}
  if targetBox is missing value then
    ${allowDeleteFallback ? "delete theMessage" : 'error "ARCHIVE_MAILBOX_NOT_FOUND"'}
  else
    set mailbox of theMessage to targetBox
  end if
end tell
return "OK"`;
}

export function mailArchive(args = {}) {
  const action = "mail_archive";
  const resolved = resolveMailMessageId({ messageId: args.message_id, filePath: args.file_path });
  if (resolved.error) return { ok: false, message: `${action} refused: ${resolved.error}` };

  const summary = `archive message ${truncate(resolved.messageId, 120)}`;
  const plan = planWrite({
    action,
    summary,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(
    buildMoveScript({
      messageId: resolved.messageId,
      mailboxNames: ["Archive", "All Mail", "Archived"],
      allowDeleteFallback: false
    }),
    { appName: "Mail" }
  );
  if (!result.ok) {
    if (result.kind === "not_found" && String(result.error).includes("ARCHIVE_MAILBOX_NOT_FOUND")) {
      return { ok: false, message: `${action} failed — attempted to ${summary}. That account has no Archive mailbox.` };
    }
    return { ok: false, message: failure(action, summary, result, []) };
  }

  return { ok: true, message: writeSuccessMessage(action, "moved to Archive", { message_id: resolved.messageId }) };
}

export function mailTrash(args = {}) {
  const action = "mail_trash";
  const resolved = resolveMailMessageId({ messageId: args.message_id, filePath: args.file_path });
  if (resolved.error) return { ok: false, message: `${action} refused: ${resolved.error}` };

  const summary = `move message ${truncate(resolved.messageId, 120)} to Trash`;
  const plan = planWrite({
    action,
    summary,
    destructive: true,
    dryRun: isFlagTrue(args.dry_run),
    confirm: isFlagTrue(args.confirm)
  });
  if (!plan.proceed) return plannedWriteResult(plan);

  const result = runAppleScript(
    buildMoveScript({
      messageId: resolved.messageId,
      mailboxNames: ["Trash", "Deleted Messages", "Bin"],
      allowDeleteFallback: true
    }),
    { appName: "Mail" }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result, []) };

  return { ok: true, message: writeSuccessMessage(action, "moved to Trash", { message_id: resolved.messageId }) };
}
