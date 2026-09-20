/**
 * Apple Mail write operations: send, reply, forward, draft, mark read/unread,
 * archive, trash.
 *
 * Messages are addressed by their RFC822 Message-ID (Mail's `message id`
 * property). `file_path` from mail_search / mail_recent is also accepted and
 * is resolved to a Message-ID by reading the .emlx headers, so callers never
 * have to invent an identifier.
 */

import fs from "fs";
import path from "path";
import { validateEmailPath, unfoldRfc822Headers, safeMatch, stripHtmlTags } from "./validators.js";
import { runAppleScript, asString, TCC_GUIDANCE } from "./appleScript.js";
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

function failure(action, summary, result, secrets) {
  if (result.kind === "tcc") {
    return `${action} failed — attempted to ${summary}. ${TCC_GUIDANCE}`;
  }
  if (result.kind === "not_found") {
    return `${action} failed — attempted to ${summary}. The message could not be found in Mail. Pass a message_id from a current mail_search result.`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Mail.app is not available on this host.`;
  }
  return writeErrorMessage(action, summary, new Error(result.error || "unknown error"), secrets);
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

  const result = runAppleScript(script, { timeout: 60000 });
  if (!result.ok) {
    return { ok: false, message: failure(action, summary, result, [body.text, subject.text]) };
  }

  return {
    ok: true,
    message: writeSuccessMessage(action, draft ? `draft saved to Drafts` : `sent`, {
      to: to.addresses.join(", "),
      cc: cc.addresses.join(", ") || undefined,
      bcc: bcc.addresses.length ? `${bcc.addresses.length} recipient(s)` : undefined,
      subject: truncate(subject.text, 150)
    })
  };
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
    { timeout: 60000 }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result, [body.text]) };

  return {
    ok: true,
    message: writeSuccessMessage(action, sendNow ? "reply sent" : "reply saved to Drafts", {
      message_id: resolved.messageId,
      reply_all: String(replyAll)
    })
  };
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
    { timeout: 60000 }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result, [body.text]) };

  return {
    ok: true,
    message: writeSuccessMessage(action, sendNow ? "forwarded" : "forward saved to Drafts", {
      message_id: resolved.messageId,
      to: to.addresses.join(", ")
    })
  };
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

  const result = runAppleScript(buildMarkScript({ messageId: resolved.messageId, read: status === "read" }));
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
    })
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
    })
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result, []) };

  return { ok: true, message: writeSuccessMessage(action, "moved to Trash", { message_id: resolved.messageId }) };
}
