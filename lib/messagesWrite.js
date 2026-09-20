/**
 * Messages (iMessage / SMS) write operations.
 *
 * Supported identifiers:
 * - `to`: a phone number in E.164 form (+15551234567) or an Apple ID email.
 *   One or more; more than one requires confirmation.
 * - `chat_id`: an existing chat GUID from chat.db (for example
 *   "iMessage;-;+15551234567" for a 1:1 chat or "iMessage;+;chat123456789"
 *   for a group). The GUID is verified against chat.db before sending, so a
 *   made-up chat id is refused rather than silently delivered elsewhere.
 */

import fs from "fs";
import path from "path";
import { safeSqlite3Json } from "./shell.js";
import { escapeSQL } from "./validators.js";
import { runAppleScript, asString, TCC_GUIDANCE } from "./appleScript.js";
import {
  planWrite,
  normalizeList,
  isMessagesHandle,
  validateChatGuid,
  validateBody,
  writeErrorMessage,
  writeSuccessMessage,
  isFlagTrue,
  truncate,
  MAX_RECIPIENTS
} from "./writeGuards.js";

const CHAT_DB = path.join(process.env.HOME || "", "Library", "Messages", "chat.db");

export const SERVICE_IMESSAGE = "imessage";
export const SERVICE_SMS = "sms";
export const SERVICE_AUTO = "auto";

/**
 * Look up a chat GUID in chat.db and count its participants.
 * @returns {{ found: boolean, participantCount: number, displayName: string, error: string|null }}
 */
export function lookupChat(guid, { queryFn = safeSqlite3Json, dbPath = CHAT_DB } = {}) {
  try {
    if (!fs.existsSync(dbPath)) {
      return { found: false, participantCount: 0, displayName: "", error: "Messages database not found" };
    }
  } catch {
    return { found: false, participantCount: 0, displayName: "", error: "Messages database not readable" };
  }

  const query = `
    SELECT c.guid AS guid,
           COALESCE(c.display_name, '') AS displayName,
           COUNT(chj.handle_id) AS participantCount
    FROM chat c
    LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    WHERE c.guid = '${escapeSQL(guid)}'
    GROUP BY c.ROWID
    LIMIT 1
  `;

  try {
    const rows = queryFn(dbPath, query, { timeout: 15000 });
    if (!rows || rows.length === 0) {
      return { found: false, participantCount: 0, displayName: "", error: null };
    }
    return {
      found: true,
      participantCount: Number(rows[0].participantCount) || 1,
      displayName: rows[0].displayName || "",
      error: null
    };
  } catch (e) {
    return { found: false, participantCount: 0, displayName: "", error: e.message };
  }
}

/**
 * Validate an attachment path supplied by the caller.
 * The file must already exist on this host; the tool never creates files.
 */
export function validateAttachmentPath(value) {
  if (value === undefined || value === null || value === "") return { filePath: null, error: null };
  if (typeof value !== "string") return { filePath: null, error: "attachment_path must be a string" };
  if (!path.isAbsolute(value)) return { filePath: null, error: "attachment_path must be an absolute path on this Mac" };
  if (value.includes("\u0000")) return { filePath: null, error: "attachment_path contains invalid characters" };

  let resolved;
  try {
    resolved = fs.realpathSync(value);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { filePath: null, error: "attachment_path must point to a file" };
  } catch {
    return { filePath: null, error: "attachment_path does not exist on this Mac" };
  }
  return { filePath: resolved, error: null };
}

function serviceHandler() {
  return `on atmService(kind)
  tell application "Messages"
    repeat with acc in accounts
      try
        if kind is "sms" then
          if (service type of acc) is SMS then return acc
        else
          if (service type of acc) is iMessage then return acc
        end if
      end try
    end repeat
  end tell
  if kind is "sms" then
    error "SMS_SERVICE_NOT_FOUND"
  else
    error "IMESSAGE_SERVICE_NOT_FOUND"
  end if
end atmService`;
}

export function buildSendToHandlesScript({ handles, text, service, attachmentPath }) {
  const sends = handles
    .map((handle) => {
      const lines = [`  set theTarget to participant ${asString(handle)} of targetService`];
      if (text) lines.push(`  send ${asString(text)} to theTarget`);
      if (attachmentPath) lines.push(`  send (POSIX file ${asString(attachmentPath)}) to theTarget`);
      return lines.join("\n");
    })
    .join("\n");

  const primary = service === SERVICE_SMS ? "sms" : "imessage";
  const fallback = service === SERVICE_AUTO
    ? `if targetService is missing value then
  set targetService to atmService("sms")
end if`
    : "";

  return `${serviceHandler()}

set targetService to missing value
try
  set targetService to atmService(${asString(primary)})
end try
${fallback}
if targetService is missing value then error "IMESSAGE_SERVICE_NOT_FOUND"
tell application "Messages"
${sends}
end tell
return "OK"`;
}

export function buildSendToChatScript({ chatGuid, text, attachmentPath }) {
  const lines = [`  set theChat to chat id ${asString(chatGuid)}`];
  if (text) lines.push(`  send ${asString(text)} to theChat`);
  if (attachmentPath) lines.push(`  send (POSIX file ${asString(attachmentPath)}) to theChat`);

  return `tell application "Messages"
${lines.join("\n")}
end tell
return "OK"`;
}

function failure(action, summary, result, secrets) {
  if (result.kind === "tcc") {
    return `${action} failed — attempted to ${summary}. ${TCC_GUIDANCE}`;
  }
  if (result.kind === "app_unavailable") {
    return `${action} failed — attempted to ${summary}. Messages.app is not available on this host.`;
  }
  const raw = String(result.error || "");
  if (raw.includes("SMS_SERVICE_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. No SMS relay service is configured in Messages (Text Message Forwarding).`;
  }
  if (raw.includes("IMESSAGE_SERVICE_NOT_FOUND")) {
    return `${action} failed — attempted to ${summary}. No enabled iMessage account was found in Messages.`;
  }
  return writeErrorMessage(action, summary, new Error(raw || "unknown error"), secrets);
}

/**
 * Send an iMessage/SMS to one or more handles, or into an existing chat.
 */
export function messagesSend(args = {}, deps = {}) {
  const action = "messages_send";

  const body = validateBody(args.text, { required: false, field: "text" });
  if (body.error) return { ok: false, message: `${action} refused: ${body.error}` };

  const attachment = validateAttachmentPath(args.attachment_path);
  if (attachment.error) return { ok: false, message: `${action} refused: ${attachment.error}` };

  if (!body.text && !attachment.filePath) {
    return { ok: false, message: `${action} refused: provide text, attachment_path, or both.` };
  }

  const serviceRaw = args.service === undefined ? SERVICE_AUTO : String(args.service).toLowerCase();
  if (![SERVICE_AUTO, SERVICE_IMESSAGE, SERVICE_SMS].includes(serviceRaw)) {
    return { ok: false, message: `${action} refused: service must be "auto", "imessage", or "sms"` };
  }

  const dryRun = isFlagTrue(args.dry_run);
  const confirm = isFlagTrue(args.confirm);

  if (args.chat_id) {
    const guid = validateChatGuid(args.chat_id);
    if (!guid) return { ok: false, message: `${action} refused: chat_id is not a valid chat GUID` };

    const chat = lookupChat(guid, deps);
    if (chat.error) {
      return { ok: false, message: `${action} refused: could not verify chat_id against the Messages database (${truncate(chat.error, 120)})` };
    }
    if (!chat.found) {
      return { ok: false, message: `${action} refused: chat_id ${truncate(guid, 80)} was not found in the Messages database. Use a chat GUID from an existing conversation; this tool does not invent chats.` };
    }

    const isGroup = chat.participantCount > 1;
    const label = chat.displayName ? `"${truncate(chat.displayName, 60)}"` : guid;
    const summary = `send a message to chat ${label} (${chat.participantCount} participant${chat.participantCount === 1 ? "" : "s"})${attachment.filePath ? " with an attachment" : ""}`;

    const plan = planWrite({
      action,
      summary,
      recipientCount: isGroup ? chat.participantCount : 1,
      dryRun,
      confirm
    });
    if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

    const result = runAppleScript(
      buildSendToChatScript({ chatGuid: guid, text: body.text, attachmentPath: attachment.filePath }),
      { timeout: 60000 }
    );
    if (!result.ok) return { ok: false, message: failure(action, summary, result, [body.text]) };

    return {
      ok: true,
      message: writeSuccessMessage(action, "message sent", {
        chat_id: guid,
        participants: String(chat.participantCount),
        attachment: attachment.filePath ? path.basename(attachment.filePath) : undefined
      })
    };
  }

  const handles = normalizeList(args.to);
  if (handles.length === 0) {
    return { ok: false, message: `${action} refused: "to" (phone number or Apple ID email) or "chat_id" is required. This tool never invents recipients.` };
  }
  if (handles.length > MAX_RECIPIENTS) {
    return { ok: false, message: `${action} refused: ${handles.length} recipients exceeds the per-call limit of ${MAX_RECIPIENTS}` };
  }
  const invalid = handles.filter((h) => !isMessagesHandle(h));
  if (invalid.length > 0) {
    return { ok: false, message: `${action} refused: invalid recipient(s): ${invalid.map((h) => truncate(h, 40)).join(", ")}. Use E.164 phone numbers (+15551234567) or Apple ID emails.` };
  }

  const summary = `send a message to ${handles.join(", ")} over ${serviceRaw}${attachment.filePath ? " with an attachment" : ""}`;
  const plan = planWrite({ action, summary, recipientCount: handles.length, dryRun, confirm });
  if (!plan.proceed) return { ok: true, message: plan.message, planned: true };

  const result = runAppleScript(
    buildSendToHandlesScript({
      handles,
      text: body.text,
      service: serviceRaw,
      attachmentPath: attachment.filePath
    }),
    { timeout: 60000 }
  );
  if (!result.ok) return { ok: false, message: failure(action, summary, result, [body.text]) };

  return {
    ok: true,
    message: writeSuccessMessage(action, "message sent", {
      to: handles.join(", "),
      service: serviceRaw,
      attachment: attachment.filePath ? path.basename(attachment.filePath) : undefined
    })
  };
}
