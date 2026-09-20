/**
 * Apple Mail write operations: send, reply, forward, draft, mark read/unread,
 * archive, trash.
 *
 * Messages are addressed by their RFC822 Message-ID (Mail's `message id`
 * property). `file_path` from mail_search / mail_recent is also accepted and
 * is resolved to a Message-ID by reading the .emlx headers, so callers never
 * have to invent an identifier.
 *
 * After a send/reply/forward hang, Sent (and Outbox) is checked before the
 * tool reports failure. A message already in Sent is success — never a TCC
 * fail. ETIMEDOUT / -1712 is a timeout (find/reply/open before send too);
 * -1743 / -10004 is a hard deny.
 */

import fs from "fs";
import path from "path";
import { validateEmailPath, unfoldRfc822Headers, safeMatch, stripHtmlTags } from "./validators.js";
import {
  runAppleScript,
  asString,
  MAIL_TCC_GUIDANCE,
  MAIL_SEND_TIMEOUT_GUIDANCE,
  ATTRIBUTION_GUIDANCE,
  isHardTccDenial
} from "./appleScript.js";
import {
  planWrite,
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

/**
 * Build the outgoing-message script shared by send and draft.
 *
 * Mail renders `html content` when it is set; `content` stays populated as
 * the plain-text alternative for clients that do not display HTML.
 */
export function buildComposeScript({ to, cc, bcc, subject, body, send, html = false }) {
  const recipients = [
    recipientLines(to, "to recipient"),
    recipientLines(cc, "cc recipient"),
    recipientLines(bcc, "bcc recipient")
  ].filter((block) => block.length > 0).join("\n");

  const htmlLine = html
    ? `  try
    set html content of newMessage to ${asString(body)}
  end try\n`
    : "";

  return `tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:${asString(subject)}, content:${asString(html ? stripHtmlTags(body) : body)}, visible:false}
${htmlLine}  tell newMessage
${recipients}
  end tell
  ${send ? "send newMessage" : "save newMessage"}
end tell
return "OK"`;
}

function summarizeRecipients(to, cc, bcc) {
  const parts = [];
  if (to.length) parts.push(`to ${to.join(", ")}`);
  if (cc.length) parts.push(`cc ${cc.join(", ")}`);
  if (bcc.length) parts.push(`bcc ${bcc.length} recipient${bcc.length === 1 ? "" : "s"}`);
  return parts.join("; ");
}

export const SENT_VERIFY_FOUND = "FOUND";
export const SENT_VERIFY_TIMEOUT_MS = 15000;

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
    set end of boxes to sent mailbox
  end try
  try
    set end of boxes to outgoing mailbox
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
      set recentMsgs to (messages of boxRef whose date sent > cutoff)
      repeat with msg in recentMsgs
        try
          set candId to message id of msg
          if candId is ${needleBare} then
            -- The original, not the reply we just sent.
          else
            try
              set src to source of msg
              if src contains ("In-Reply-To: " & ${needleAngle}) then return "${SENT_VERIFY_FOUND}"
              if src contains ("In-Reply-To: " & ${needleBare}) then return "${SENT_VERIFY_FOUND}"
            end try
            if origSubject is not "" then
              set subj to subject of msg
              if subj is ("Re: " & origSubject) then return "${SENT_VERIFY_FOUND}"
            end if
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "NOT_FOUND"`;
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
      set recentMsgs to (messages of boxRef whose date sent > cutoff)
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
              set hitTo to false
              try
                repeat with recip in (to recipients of msg)
                  set recipAddr to address of recip as string
                  repeat with wanted in wantedTos
                    if recipAddr is (wanted as string) then set hitTo to true
                  end repeat
                end repeat
              end try
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
                if exactFwd then return "${SENT_VERIFY_FOUND}"
                if looksForward and mentionsOrigId then return "${SENT_VERIFY_FOUND}"
              end if
            end if
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "NOT_FOUND"`;
}

/**
 * Look in Sent / Outbox for a compose whose subject matches exactly and
 * was sent in the last 10 minutes.
 */
export function buildFindSentBySubjectScript(subject) {
  const subj = asString(subject);
  return `tell application "Mail"
${mailBoxesPreamble()}
  repeat with boxRef in boxes
    try
      set hits to (messages of boxRef whose subject is ${subj} and date sent > cutoff)
      if (count of hits) > 0 then return "${SENT_VERIFY_FOUND}"
    end try
  end repeat
end tell
return "NOT_FOUND"`;
}

/**
 * After a send hang, ask Mail whether the message is already in Sent.
 * Returns a hit object or null. Verify failure / timeout is not success.
 */
export function recoverIfInSent({ inReplyTo = null, subject = null, forwardTo = null } = {}) {
  const script = forwardTo && inReplyTo
    ? buildFindSentForwardScript(inReplyTo, forwardTo)
    : inReplyTo
      ? buildFindSentByInReplyToScript(inReplyTo)
      : subject
        ? buildFindSentBySubjectScript(subject)
        : null;
  if (!script) return null;
  const result = runAppleScript(script, { timeout: SENT_VERIFY_TIMEOUT_MS, appName: "Mail" });
  if (!result.ok) return null;
  const out = String(result.output || "").trim();
  if (out === SENT_VERIFY_FOUND) return { found: true };
  return null;
}

function failure(action, summary, result, secrets) {
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
  if (result.kind === "attribution") {
    return `${action} failed — attempted to ${summary}. ${ATTRIBUTION_GUIDANCE}`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Mail.app could not be reached on this host.`;
  }
  return writeErrorMessage(action, summary, new Error(result.error || "unknown error"), secrets);
}

/**
 * Finish a compose/reply/forward. A send hang is not labeled TCC; if Mail
 * already delivered, return success. Hard -1743/-10004 stays a deny.
 */
function finalizeMailWrite({
  action,
  summary,
  result,
  secrets,
  sendNow,
  inReplyTo = null,
  subject = null,
  forwardTo = null,
  successSummary,
  details
}) {
  if (result.ok) {
    return { ok: true, message: writeSuccessMessage(action, successSummary, details) };
  }

  if (sendNow && isMailSendTimeout(result)) {
    const recovered = recoverIfInSent({ inReplyTo, subject, forwardTo });
    if (recovered) {
      return {
        ok: true,
        recovered: true,
        message: writeSuccessMessage(
          action,
          `${successSummary} (verified in Sent after AppleScript hang)`,
          details
        )
      };
    }
    return { ok: false, message: failure(action, summary, result, secrets) };
  }

  return { ok: false, message: failure(action, summary, result, secrets) };
}

/**
 * Compose and send (or save as draft) a new email.
 */
export function mailCompose(args = {}, { draft = false } = {}) {
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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const script = buildComposeScript({
    to: to.addresses,
    cc: cc.addresses,
    bcc: bcc.addresses,
    subject: subject.text,
    body: body.text,
    send: !draft,
    html: bodyFormat === "html"
  });

  const result = runAppleScript(script, { timeout: 60000, appName: "Mail" });
  return finalizeMailWrite({
    action,
    summary,
    result,
    secrets: [body.text, subject.text],
    sendNow: !draft,
    subject: draft ? null : subject.text,
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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

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
