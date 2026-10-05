/**
 * Contact matching and peer naming for indexed Messages rows.
 *
 * Rows carry raw handles (`sender` is a phone/email or "Me"; `chatIdentifier`
 * is the other party's handle in a 1:1 chat, or "chatNNN" for a group). Tool
 * output shows contact names, so callers pass names back ("Dad"). These helpers
 * map that name to handles and tell a reader who a from-me row was sent to.
 *
 * Lookups are injected so the logic is testable without the AddressBook.
 */

const MIN_PHONE_DIGITS = 7;

function looksLikeEmail(value) {
  return value.includes("@");
}

function looksLikePhone(value) {
  return value.replace(/\D/g, "").length >= MIN_PHONE_DIGITS;
}

/**
 * Build a predicate that matches message rows to a caller-supplied contact.
 *
 * Keeps the old raw substring match on sender / chatIdentifier, and adds:
 * - phone input matched on normalized digits (605-360-2675 == +16053602675)
 * - email input matched exactly (case-insensitive)
 * - a name matched exactly (full name, first name, or nickname) against
 *   Contacts, then every phone and email on those contacts. No fuzzy name
 *   matching: a short name must not pull in other people's threads.
 *
 * @param {string} contact - Name, phone, or email
 * @param {object} deps
 * @param {(name: string) => object[]} deps.resolveExactName - contacts with that exact name
 * @param {(phone: string) => string} deps.normalizePhone
 * @returns {{ matches: (row: object) => boolean, isName: boolean, resolvedCount: number } | null}
 */
export function createMessageContactMatcher(contact, { resolveExactName, normalizePhone }) {
  const raw = String(contact || "").trim().toLowerCase();
  if (!raw) return null;

  const phones = new Set();
  const emails = new Set();
  const isName = !looksLikeEmail(raw) && !looksLikePhone(raw);
  let resolvedCount = 0;

  if (looksLikeEmail(raw)) {
    emails.add(raw);
  } else if (looksLikePhone(raw)) {
    const normalized = normalizePhone(raw);
    if (normalized) phones.add(normalized);
  } else {
    const people = resolveExactName(raw) || [];
    resolvedCount = people.length;
    for (const person of people) {
      for (const p of person.phones || []) {
        const normalized = p.normalized || normalizePhone(p.phone || "");
        if (normalized) phones.add(normalized);
      }
      for (const e of person.emails || []) {
        if (e.email) emails.add(e.email.toLowerCase());
      }
    }
  }

  const fieldMatches = (value) => {
    const lower = String(value || "").toLowerCase();
    if (!lower || lower === "me" || lower === "unknown") return false;
    if (lower.includes(raw)) return true;
    if (emails.has(lower)) return true;
    if (phones.size > 0 && !looksLikeEmail(lower)) {
      const normalized = normalizePhone(lower);
      if (normalized && phones.has(normalized)) return true;
    }
    return false;
  };

  return {
    matches: (row) => fieldMatches(row.sender) || fieldMatches(row.chatIdentifier),
    isName,
    resolvedCount
  };
}

/**
 * Name the other side of a from-me row, so "Me" lines say who they went to.
 *
 * @param {object} row - Indexed message row (chatIdentifier, chatName, isGroupChat)
 * @param {object} deps
 * @param {(phone: string) => object|null} deps.resolvePhone
 * @param {(email: string) => object|null} deps.resolveEmail
 * @param {(contact: object) => string} deps.formatContact
 * @returns {string|null} e.g. "Dad (+16053602675)", "group chat \"Family\"", or null
 */
export function describeMessagePeer(row, { resolvePhone, resolveEmail, formatContact }) {
  const chatIdentifier = row.chatIdentifier || "";
  if (row.isGroupChat) {
    if (row.chatName) return `group chat "${row.chatName}"`;
    return chatIdentifier ? `group chat ${chatIdentifier}` : "group chat";
  }
  if (!chatIdentifier) return null;
  const person = looksLikeEmail(chatIdentifier)
    ? resolveEmail(chatIdentifier)
    : resolvePhone(chatIdentifier);
  return person ? `${formatContact(person)} (${chatIdentifier})` : chatIdentifier;
}
