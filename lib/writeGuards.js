
export const MAX_RECIPIENTS = 25;

export const MAX_BODY_LENGTH = 20000;
export const MAX_SUBJECT_LENGTH = 500;

export function isFlagTrue(value) {
  return value === true || value === "true";
}

export function normalizeList(value) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = [];
  for (const entry of raw) {
    if (entry === undefined || entry === null) continue;
    const trimmed = String(entry).trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;
const PHONE_RE = /^[+(]?[0-9(][0-9 ().-]{4,24}$/;
const MESSAGE_ID_RE = /^<?[A-Za-z0-9!#$%&'*+/=?^_{|}~.@-]{1,500}>?$/;
const EVENT_UID_RE = /^[A-Za-z0-9._:@+-]{1,255}$/;
const EVENTKIT_ID_RE = /^[A-Za-z0-9._:@+/=-]{1,500}$/;
const CONTACT_ID_RE = /^[A-Za-z0-9._:-]{1,255}$/;
const CHAT_GUID_RE = /^[A-Za-z0-9;:+._@-]{1,255}$/;
const LABEL_RE = /^[A-Za-z][A-Za-z ]{0,19}$/;
const CALENDAR_NAME_RE = /^[^\u0000-\u001f"\\]{1,100}$/;

export function isEmailAddress(value) {
  return typeof value === "string" && value.length <= 254 && EMAIL_RE.test(value);
}

export function isPhoneNumber(value) {
  if (typeof value !== "string" || !PHONE_RE.test(value)) return false;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 5 && digits.length <= 15;
}

export function isMessagesHandle(value) {
  return isEmailAddress(value) || isPhoneNumber(value);
}

export function validateMessageId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!MESSAGE_ID_RE.test(trimmed)) return null;
  return trimmed.replace(/^</, "").replace(/>$/, "");
}

export function validateEventId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EVENT_UID_RE.test(trimmed) ? trimmed : null;
}

export function validateEventKitId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return EVENTKIT_ID_RE.test(trimmed) ? trimmed : null;
}

export function validateContactId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CONTACT_ID_RE.test(trimmed) ? trimmed : null;
}

export function validateChatGuid(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CHAT_GUID_RE.test(trimmed) ? trimmed : null;
}

export function validateCalendarName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CALENDAR_NAME_RE.test(trimmed) ? trimmed : null;
}

export function validateLabel(value, fallback = "home") {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return LABEL_RE.test(trimmed) ? trimmed : null;
}

export function validateEmailList(value, field) {
  const list = normalizeList(value);
  const addresses = [];
  for (const entry of list) {
    const angle = entry.match(/<([^<>]{1,254})>\s*$/);
    const address = angle ? angle[1].trim() : entry;
    if (!isEmailAddress(address)) {
      return { addresses: [], error: `${field} contains an invalid email address: ${truncate(address, 80)}` };
    }
    addresses.push(address);
  }
  if (addresses.length > MAX_RECIPIENTS) {
    return { addresses: [], error: `${field} has ${addresses.length} recipients; the per-call limit is ${MAX_RECIPIENTS}` };
  }
  return { addresses, error: null };
}

export function validateBody(value, { required = false, field = "body" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) return { text: null, error: `${field} is required` };
    return { text: "", error: null };
  }
  if (typeof value !== "string") return { text: null, error: `${field} must be text` };
  if (value.length > MAX_BODY_LENGTH) {
    return { text: null, error: `${field} is ${value.length} characters; the limit is ${MAX_BODY_LENGTH}` };
  }
  return { text: value, error: null };
}

export function validateSubject(value, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) return { text: null, error: "subject is required" };
    return { text: "", error: null };
  }
  if (typeof value !== "string") return { text: null, error: "subject must be text" };
  if (value.length > MAX_SUBJECT_LENGTH) {
    return { text: null, error: `subject is ${value.length} characters; the limit is ${MAX_SUBJECT_LENGTH}` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    return { text: null, error: "subject contains control characters" };
  }
  return { text: value, error: null };
}

export function planWrite({
  action,
  summary,
  destructive = false,
  recipientCount = 0,
  dryRun = false,
  confirm = false
}) {
  const multiRecipient = recipientCount > 1;
  const requiresConfirm = Boolean(destructive || multiRecipient);

  if (dryRun) {
    const tail = requiresConfirm
      ? " Re-run with dry_run=false and confirm=true to apply."
      : " Re-run with dry_run=false to apply.";
    return {
      decision: "dry_run",
      proceed: false,
      requiresConfirm,
      message: `DRY RUN (${action}): would ${summary}. Nothing was changed.${tail}`
    };
  }

  if (requiresConfirm && !confirm) {
    const why = destructive
      ? "This is a destructive action"
      : `This send has ${recipientCount} recipients`;
    return {
      decision: "needs_confirm",
      proceed: false,
      requiresConfirm,
      message: `CONFIRMATION REQUIRED (${action}): would ${summary}. ${why}, so nothing was changed. Re-run with confirm=true to apply, or dry_run=true for a preview.`
    };
  }

  return { decision: "execute", proceed: true, requiresConfirm, message: null };
}

export function plannedWriteResult(plan) {
  return {
    ok: false,
    planned: true,
    delivered: false,
    mailbox: null,
    message: plan && plan.message ? plan.message : "Nothing was changed."
  };
}

export function truncate(text, max = 200) {
  if (typeof text !== "string") return "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

export function scrubValues(text, values = []) {
  let out = typeof text === "string" ? text : "";
  for (const value of values) {
    if (typeof value !== "string" || value.length < 4) continue;
    while (out.includes(value)) {
      out = out.replace(value, "[redacted]");
    }
  }
  return out;
}

export function writeErrorMessage(action, summary, error, secrets = []) {
  const raw = error && error.message ? error.message : String(error || "unknown error");
  const reason = truncate(scrubValues(raw, secrets), 300);
  return `${action} failed — attempted to ${summary}. Reason: ${reason}`;
}

export function writeSuccessMessage(action, summary, details = {}) {
  const parts = [`${action}: ${summary}.`];
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}: ${truncate(String(value), 200)}`);
  }
  return parts.join(" ");
}
