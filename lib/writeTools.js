/**
 * MCP write tool definitions and dispatch.
 *
 * Every tool here mutates user data, so each one:
 * - validates its arguments (no invented recipients, ids, or dates)
 * - honours `dry_run` (preview, never execute)
 * - requires `confirm: true` for deletes and multi-recipient sends
 * - reports what happened by id/recipient/title, never by echoing bodies
 *
 * Execution is routed by lib/writeRouting.js: the indexer daemon runs writes
 * itself, an MCP stdio process hands privacy-gated writes to the daemon.
 */

import {
  mailCompose,
  mailReply,
  mailForward,
  mailMark,
  mailArchive,
  mailTrash
} from "./mailWrite.js";
import { messagesSend } from "./messagesWrite.js";
import {
  calendarListCalendars,
  calendarAdd,
  calendarEdit,
  calendarRemove,
  calendarRsvp,
  RECURRENCE_FREQUENCIES,
  RSVP_RESPONSES
} from "./calendarWrite.js";
import { contactsAdd, contactsEdit, contactsRemove } from "./contactsWrite.js";
import { planWriteRoute, planAfterDelegation, tccFallbackAdvice } from "./writeRouting.js";
import { requestWriteViaBridge, probeSocket, defaultSocketPath } from "./writeBridge.js";
import { isTccDenial } from "./appleScript.js";

const CONFIRM_PROPS = {
  dry_run: { type: "boolean", description: "Preview only: report what would happen and change nothing (default false)" },
  confirm: { type: "boolean", description: "Required for deletes and multi-recipient sends; without it the call only previews" }
};

const MESSAGE_TARGET_PROPS = {
  message_id: { type: "string", description: "RFC822 Message-ID of the email (from mail_search / mail_read results)" },
  file_path: { type: "string", description: "Alternative to message_id: the .emlx file_path from mail_search, resolved to its Message-ID" }
};

export const WRITE_TOOL_DEFINITIONS = [
  // ============ MAIL WRITES ============
  {
    name: "mail_send",
    description: "Send an email through Mail.app. Sending to more than one recipient in total (to + cc + bcc) requires confirm=true. Use dry_run=true to preview.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses (required, at least one)" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC email addresses" },
        subject: { type: "string", description: "Subject line (required)" },
        body: { type: "string", description: "Plain text body (required)" },
        ...CONFIRM_PROPS
      },
      required: ["to", "subject", "body"]
    }
  },
  {
    name: "mail_draft",
    description: "Save an email to Drafts without sending it. Drafts are never delivered, so no recipient confirmation is required.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses (required, at least one)" },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC email addresses" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Plain text body" },
        ...CONFIRM_PROPS
      },
      required: ["to"]
    }
  },
  {
    name: "mail_reply",
    description: "Reply to an existing email. reply_all=true fans out to every original recipient and requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_TARGET_PROPS,
        body: { type: "string", description: "Reply text, prepended above the quoted original (required)" },
        reply_all: { type: "boolean", description: "Reply to all original recipients (default false)" },
        save_as_draft: { type: "boolean", description: "Save the reply to Drafts instead of sending (default false)" },
        ...CONFIRM_PROPS
      },
      required: ["body"]
    }
  },
  {
    name: "mail_forward",
    description: "Forward an existing email to new recipients. More than one recipient requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_TARGET_PROPS,
        to: { type: "array", items: { type: "string" }, description: "Forward recipients (required, at least one)" },
        body: { type: "string", description: "Optional note added above the forwarded message" },
        save_as_draft: { type: "boolean", description: "Save the forward to Drafts instead of sending (default false)" },
        ...CONFIRM_PROPS
      },
      required: ["to"]
    }
  },
  {
    name: "mail_mark",
    description: "Mark an email as read or unread.",
    inputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_TARGET_PROPS,
        status: { type: "string", enum: ["read", "unread"], description: "New read state (default read)" },
        ...CONFIRM_PROPS
      },
      required: []
    }
  },
  {
    name: "mail_archive",
    description: "Move an email to its account's Archive mailbox.",
    inputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_TARGET_PROPS,
        ...CONFIRM_PROPS
      },
      required: []
    }
  },
  {
    name: "mail_trash",
    description: "Move an email to Trash. Destructive: requires confirm=true, otherwise the call only reports what would be trashed.",
    inputSchema: {
      type: "object",
      properties: {
        ...MESSAGE_TARGET_PROPS,
        ...CONFIRM_PROPS
      },
      required: []
    }
  },

  // ============ MESSAGES WRITES ============
  {
    name: "messages_send",
    description: "Send an iMessage or SMS. Address it with 'to' (E.164 phone numbers like +15551234567, or Apple ID emails) or with 'chat_id' (a chat GUID from chat.db, e.g. 'iMessage;-;+15551234567' or 'iMessage;+;chat123456'). Group chats and multiple recipients require confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Phone numbers in E.164 form or Apple ID emails" },
        chat_id: { type: "string", description: "Existing chat GUID; verified against the Messages database before sending" },
        text: { type: "string", description: "Message text (required unless attachment_path is given)" },
        attachment_path: { type: "string", description: "Absolute path to an existing file on this Mac to attach" },
        service: { type: "string", enum: ["auto", "imessage", "sms"], description: "Delivery service (default auto: iMessage, then SMS relay)" },
        ...CONFIRM_PROPS
      },
      required: []
    }
  },

  // ============ CALENDAR WRITES ============
  {
    name: "calendar_list_calendars",
    description: "List the calendars in Calendar.app with their writability, so events land on the intended calendar instead of the default.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "calendar_add",
    description: "Create a calendar event. Times must be explicit local datetimes (YYYY-MM-DD HH:MM). Supports recurrence (FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT or UNTIL, BYDAY) and alerts in minutes before the start. Returns the new event id.",
    inputSchema: {
      type: "object",
      properties: {
        calendar_name: { type: "string", description: "Target calendar name from calendar_list_calendars (required)" },
        title: { type: "string", description: "Event title (required)" },
        start: { type: "string", description: "Start as YYYY-MM-DD HH:MM local time, or YYYY-MM-DD for all-day (required)" },
        end: { type: "string", description: "End as YYYY-MM-DD HH:MM local time (default: start + 1 hour)" },
        all_day: { type: "boolean", description: "Create an all-day event" },
        location: { type: "string", description: "Event location" },
        notes: { type: "string", description: "Event notes / description" },
        frequency: { type: "string", enum: RECURRENCE_FREQUENCIES, description: "Recurrence frequency" },
        interval: { type: "number", description: "Recurrence interval, e.g. 2 for every other week (1-366)" },
        count: { type: "number", description: "Number of occurrences (1-1000); cannot be combined with until" },
        until: { type: "string", description: "Repeat until this local datetime (YYYY-MM-DD HH:MM)" },
        by_day: { type: "array", items: { type: "string" }, description: "Weekly by-day list: MO TU WE TH FR SA SU" },
        recurrence: { type: "string", description: "Raw RRULE instead of the structured fields, e.g. FREQ=WEEKLY;INTERVAL=1;COUNT=10" },
        alerts_minutes_before: { type: "array", items: { type: "number" }, description: "Display alerts in minutes before the start (max 5, up to 40320)" },
        ...CONFIRM_PROPS
      },
      required: ["calendar_name", "title", "start"]
    }
  },
  {
    name: "calendar_edit",
    description: "Update an existing event by id. Pass only the fields to change. Setting alerts_minutes_before replaces the event's existing alerts.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID from calendar_date or calendar_add (required)" },
        title: { type: "string", description: "New title" },
        start: { type: "string", description: "New start as YYYY-MM-DD HH:MM local time" },
        end: { type: "string", description: "New end as YYYY-MM-DD HH:MM local time" },
        location: { type: "string", description: "New location" },
        notes: { type: "string", description: "New notes / description" },
        frequency: { type: "string", enum: RECURRENCE_FREQUENCIES, description: "Recurrence frequency" },
        interval: { type: "number", description: "Recurrence interval (1-366)" },
        count: { type: "number", description: "Number of occurrences (1-1000)" },
        until: { type: "string", description: "Repeat until this local datetime" },
        by_day: { type: "array", items: { type: "string" }, description: "Weekly by-day list: MO TU WE TH FR SA SU" },
        recurrence: { type: "string", description: "Raw RRULE" },
        alerts_minutes_before: { type: "array", items: { type: "number" }, description: "Replacement alerts in minutes before the start" },
        replace_alerts: { type: "boolean", description: "Remove existing alerts even when no replacements are given" },
        ...CONFIRM_PROPS
      },
      required: ["event_id"]
    }
  },
  {
    name: "calendar_remove",
    description: "Delete a calendar event by id. Destructive: requires confirm=true, otherwise the call only reports what would be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID from calendar_date (required)" },
        ...CONFIRM_PROPS
      },
      required: ["event_id"]
    }
  },
  {
    name: "calendar_rsvp",
    description: "Respond to a calendar invitation: accept, decline, or tentative.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "Event ID of the invitation (required)" },
        response: { type: "string", enum: RSVP_RESPONSES, description: "accept, decline, or tentative (required)" },
        attendee_email: { type: "string", description: "Your invited address, when the event lists several attendees" },
        ...CONFIRM_PROPS
      },
      required: ["event_id", "response"]
    }
  },

  // ============ CONTACTS WRITES ============
  {
    name: "contacts_add",
    description: "Create a contact in Contacts.app. Returns the new contact id.",
    inputSchema: {
      type: "object",
      properties: {
        first_name: { type: "string", description: "First name" },
        last_name: { type: "string", description: "Last name" },
        organization: { type: "string", description: "Company / organization" },
        job_title: { type: "string", description: "Job title" },
        emails: { type: "array", items: { type: "string" }, description: "Email addresses (max 10)" },
        email_label: { type: "string", description: "Label for the emails, e.g. work or home (default work)" },
        phones: { type: "array", items: { type: "string" }, description: "Phone numbers (max 10)" },
        phone_label: { type: "string", description: "Label for the phones, e.g. mobile or home (default mobile)" },
        ...CONFIRM_PROPS
      },
      required: []
    }
  },
  {
    name: "contacts_edit",
    description: "Update a contact by id. Emails and phones are added unless replace_emails / replace_phones is set; replacing with an empty list removes them and requires confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "Contact ID from contacts_search or contacts_lookup (required)" },
        first_name: { type: "string", description: "New first name" },
        last_name: { type: "string", description: "New last name" },
        organization: { type: "string", description: "New organization" },
        job_title: { type: "string", description: "New job title" },
        emails: { type: "array", items: { type: "string" }, description: "Email addresses to add (or to replace with)" },
        email_label: { type: "string", description: "Label for those emails (default work)" },
        phones: { type: "array", items: { type: "string" }, description: "Phone numbers to add (or to replace with)" },
        phone_label: { type: "string", description: "Label for those phones (default mobile)" },
        replace_emails: { type: "boolean", description: "Remove existing emails before adding" },
        replace_phones: { type: "boolean", description: "Remove existing phones before adding" },
        ...CONFIRM_PROPS
      },
      required: ["contact_id"]
    }
  },
  {
    name: "contacts_remove",
    description: "Delete a contact by id. Destructive: requires confirm=true, otherwise the call only reports what would be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "string", description: "Contact ID from contacts_search or contacts_lookup (required)" },
        ...CONFIRM_PROPS
      },
      required: ["contact_id"]
    }
  }
];

export const WRITE_TOOL_HANDLERS = {
  mail_send: (args) => mailCompose(args, { draft: false }),
  mail_draft: (args) => mailCompose(args, { draft: true }),
  mail_reply: mailReply,
  mail_forward: mailForward,
  mail_mark: mailMark,
  mail_archive: mailArchive,
  mail_trash: mailTrash,
  messages_send: messagesSend,
  calendar_list_calendars: () => calendarListCalendars(),
  calendar_add: calendarAdd,
  calendar_edit: calendarEdit,
  calendar_remove: calendarRemove,
  calendar_rsvp: calendarRsvp,
  contacts_add: contactsAdd,
  contacts_edit: contactsEdit,
  contacts_remove: contactsRemove
};

export const WRITE_TOOL_NAMES = Object.keys(WRITE_TOOL_HANDLERS);

export function isWriteTool(name) {
  return Object.prototype.hasOwnProperty.call(WRITE_TOOL_HANDLERS, name);
}

/**
 * Run a write in this process.
 * @returns {{ ok: boolean, message: string }}
 */
export function executeWriteToolLocally(name, args = {}) {
  const handler = WRITE_TOOL_HANDLERS[name];
  if (!handler) {
    return { ok: false, message: `Unknown write tool: ${name}`, unsupported: true };
  }
  try {
    return handler(args || {});
  } catch (e) {
    return { ok: false, message: `${name} failed: ${e.message}` };
  }
}

/**
 * Run a write, delegating privacy-gated work to the indexer daemon when it is
 * listening. Falls back to local execution whenever the bridge is unusable.
 *
 * @param {string} name
 * @param {object} args
 * @param {object} [deps] - injected for tests
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function dispatchWriteTool(name, args = {}, deps = {}) {
  const {
    indexerMode = false,
    socketPath = defaultSocketPath(),
    probe = probeSocket,
    request = requestWriteViaBridge,
    runLocally = executeWriteToolLocally,
    log = () => {}
  } = deps;

  if (!isWriteTool(name)) {
    return { ok: false, message: `Unknown write tool: ${name}` };
  }

  let bridgeAvailable = false;
  if (!indexerMode) {
    bridgeAvailable = await probe(socketPath);
  }

  const route = planWriteRoute({ indexerMode, bridgeAvailable, toolName: name });

  if (route.target === "daemon") {
    const { delivered, response, error } = await request({ socketPath, tool: name, args });
    const { fallbackLocal } = planAfterDelegation({ delivered, response });
    if (!fallbackLocal) {
      return response;
    }
    log(`Write bridge unavailable for ${name} (${error || "no response"}); running locally.`);
  }

  const result = runLocally(name, args);
  if (result && result.ok === false && isTccDenial(result.message)) {
    return { ...result, message: `${result.message} ${tccFallbackAdvice({ bridgeAvailable })}` };
  }
  return result;
}
