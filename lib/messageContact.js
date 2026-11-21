
const MIN_PHONE_DIGITS = 7;

function looksLikeEmail(value) {
  return value.includes("@");
}

function looksLikePhone(value) {
  return value.replace(/\D/g, "").length >= MIN_PHONE_DIGITS;
}

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
