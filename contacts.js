
import fs from "fs";
import path from "path";
import { safeSqlite3, safeSqlite3Json } from "./lib/shell.js";

const ADDRESSBOOK_DIR = path.join(process.env.HOME, "Library", "Application Support", "AddressBook");
const SOURCES_DIR = path.join(ADDRESSBOOK_DIR, "Sources");

let contactsLoaded = false;
let contacts = [];
const emailToContact = new Map();
const phoneToContact = new Map();
const nameToContact = new Map();

const CACHE_TTL = 5 * 60 * 1000;
let lastLoadTime = 0;

const MAX_CONTACTS = 50000;
const MAX_EMAILS_PER_CONTACT = 10;
const MAX_PHONES_PER_CONTACT = 10;

export function isAddressBookPermissionError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("eperm") ||
    text.includes("operation not permitted") ||
    text.includes("unable to open database") ||
    text.includes("authorization denied");
}

export const ADDRESSBOOK_FDA_HINT =
  "Contacts reads need Full Disk Access for the process macOS holds responsible for this server " +
  "(the app that launched it over stdio, or node itself when launchd starts the indexer daemon). " +
  "This is a Full Disk Access / attribution issue, not the AddressBook entitlement that gates Contacts writes.";

function findContactsDatabase() {
  let permissionDenied = false;

  let sources = [];
  try {
    if (fs.existsSync(SOURCES_DIR)) {
      sources = fs.readdirSync(SOURCES_DIR);
    }
  } catch (e) {
    if (isAddressBookPermissionError(e.message) || e.code === "EPERM" || e.code === "EACCES") {
      permissionDenied = true;
    }
  }

  for (const source of sources) {
    const dbPath = path.join(SOURCES_DIR, source, "AddressBook-v22.abcddb");
    if (!fs.existsSync(dbPath)) continue;
    try {
      const result = safeSqlite3(dbPath, "SELECT COUNT(*) FROM ZABCDRECORD", { json: false, timeout: 5000 });
      const count = parseInt(result.trim());
      if (count > 0) {
        return dbPath;
      }
    } catch (e) {
      if (isAddressBookPermissionError(e.message)) {
        permissionDenied = true;
      }
    }
  }

  const mainDb = path.join(ADDRESSBOOK_DIR, "AddressBook-v22.abcddb");
  if (fs.existsSync(mainDb)) {
    return mainDb;
  }

  if (permissionDenied) {
    console.error(`Contacts: AddressBook database exists but could not be read. ${ADDRESSBOOK_FDA_HINT}`);
  }

  return null;
}

export function normalizePhone(phone) {
  if (!phone) return "";
  const hasPlus = phone.startsWith("+");
  const digits = phone.replace(/\D/g, "");
  const wasUSNumber = digits.length === 11 && digits.startsWith("1");
  const normalized = wasUSNumber
    ? digits.slice(1)
    : digits;
  return (hasPlus && !wasUSNumber) ? `+${normalized}` : normalized;
}

export function loadContacts() {
  const now = Date.now();

  if (contactsLoaded && (now - lastLoadTime) < CACHE_TTL) {
    return contacts;
  }

  const dbPath = findContactsDatabase();
  if (!dbPath) {
    console.error("Contacts database not found");
    return [];
  }

  try {
    const buildContactQuery = (includeUniqueId) => `
      SELECT
        Z_PK as id,
        ${includeUniqueId ? "ZUNIQUEID as uniqueId," : "'' as uniqueId,"}
        ZFIRSTNAME as firstName,
        ZLASTNAME as lastName,
        ZNICKNAME as nickname,
        ZORGANIZATION as organization,
        ZDEPARTMENT as department,
        ZJOBTITLE as jobTitle
      FROM ZABCDRECORD
      WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL
      LIMIT ${MAX_CONTACTS}
    `;

    let rawContacts;
    try {
      rawContacts = safeSqlite3Json(dbPath, buildContactQuery(true), { timeout: 10000 });
    } catch (e) {
      console.error(`Contacts: unique id column unavailable (${e.message}); loading without it`);
      rawContacts = safeSqlite3Json(dbPath, buildContactQuery(false), { timeout: 10000 });
    }

    if (rawContacts.length >= MAX_CONTACTS) {
      console.error(`Warning: Contact limit reached (${MAX_CONTACTS}). Some contacts may not be searchable.`);
    }

    const emailQuery = `
      SELECT
        ZOWNER as contactId,
        ZADDRESS as email,
        ZLABEL as label
      FROM ZABCDEMAILADDRESS
      WHERE ZADDRESS IS NOT NULL
    `;

    const emails = safeSqlite3Json(dbPath, emailQuery, { timeout: 10000 });

    const phoneQuery = `
      SELECT
        ZOWNER as contactId,
        ZFULLNUMBER as phone,
        ZLABEL as label
      FROM ZABCDPHONENUMBER
      WHERE ZFULLNUMBER IS NOT NULL
    `;

    const phones = safeSqlite3Json(dbPath, phoneQuery, { timeout: 10000 });

    const emailsByContact = new Map();
    for (const e of emails) {
      if (!emailsByContact.has(e.contactId)) {
        emailsByContact.set(e.contactId, []);
      }
      const contactEmails = emailsByContact.get(e.contactId);
      if (contactEmails.length < MAX_EMAILS_PER_CONTACT) {
        contactEmails.push({
          email: e.email,
          label: e.label || "other"
        });
      }
    }

    const phonesByContact = new Map();
    for (const p of phones) {
      if (!phonesByContact.has(p.contactId)) {
        phonesByContact.set(p.contactId, []);
      }
      const contactPhones = phonesByContact.get(p.contactId);
      if (contactPhones.length < MAX_PHONES_PER_CONTACT) {
        contactPhones.push({
          phone: p.phone,
          normalized: normalizePhone(p.phone),
          label: p.label || "other"
        });
      }
    }

    contacts = [];
    emailToContact.clear();
    phoneToContact.clear();
    nameToContact.clear();

    for (const c of rawContacts) {
      const contact = {
        id: c.id,
        uniqueId: c.uniqueId || "",
        firstName: c.firstName || "",
        lastName: c.lastName || "",
        nickname: c.nickname || "",
        organization: c.organization || "",
        department: c.department || "",
        jobTitle: c.jobTitle || "",
        emails: emailsByContact.get(c.id) || [],
        phones: phonesByContact.get(c.id) || [],
        displayName: formatDisplayName(c)
      };

      contacts.push(contact);

      for (const e of contact.emails) {
        const emailLower = e.email.toLowerCase();
        emailToContact.set(emailLower, contact);
      }

      for (const p of contact.phones) {
        if (p.normalized) {
          phoneToContact.set(p.normalized, contact);
        }
      }

      const fullName = `${contact.firstName} ${contact.lastName}`.trim().toLowerCase();
      if (fullName) {
        if (!nameToContact.has(fullName)) {
          nameToContact.set(fullName, []);
        }
        nameToContact.get(fullName).push(contact);
      }

      if (contact.firstName) {
        const firstLower = contact.firstName.toLowerCase();
        if (!nameToContact.has(firstLower)) {
          nameToContact.set(firstLower, []);
        }
        nameToContact.get(firstLower).push(contact);
      }

      if (contact.nickname) {
        const nickLower = contact.nickname.toLowerCase();
        if (!nameToContact.has(nickLower)) {
          nameToContact.set(nickLower, []);
        }
        nameToContact.get(nickLower).push(contact);
      }
    }

    contactsLoaded = true;
    lastLoadTime = now;
    console.error(`Contacts: Loaded ${contacts.length} contacts with ${emailToContact.size} emails and ${phoneToContact.size} phones`);

    return contacts;
  } catch (e) {
    if (isAddressBookPermissionError(e.message)) {
      console.error(`Error loading contacts: ${e.message}. ${ADDRESSBOOK_FDA_HINT}`);
    } else {
      console.error("Error loading contacts:", e.message);
    }
    return [];
  }
}

function formatDisplayName(contact) {
  const parts = [];
  if (contact.firstName) parts.push(contact.firstName);
  if (contact.lastName) parts.push(contact.lastName);
  if (parts.length === 0 && contact.organization) {
    return contact.organization;
  }
  return parts.join(" ");
}

export function resolveEmail(email) {
  if (!email) return null;
  loadContacts();
  return emailToContact.get(email.toLowerCase()) || null;
}

export function resolvePhone(phone) {
  if (!phone) return null;
  loadContacts();
  const normalized = normalizePhone(phone);
  return phoneToContact.get(normalized) || null;
}

export function resolveByName(name) {
  if (!name) return [];
  loadContacts();

  const nameLower = name.toLowerCase().trim();

  const exact = nameToContact.get(nameLower);
  if (exact && exact.length > 0) {
    return exact;
  }

  const matches = [];
  for (const contact of contacts) {
    const fullName = `${contact.firstName} ${contact.lastName}`.toLowerCase();
    const orgName = contact.organization?.toLowerCase() || "";
    const nick = contact.nickname?.toLowerCase() || "";

    if (fullName.includes(nameLower) ||
        orgName.includes(nameLower) ||
        nick.includes(nameLower) ||
        nameLower.includes(contact.firstName?.toLowerCase() || "---") ||
        nameLower.includes(contact.lastName?.toLowerCase() || "---")) {
      matches.push(contact);
    }
  }

  return matches;
}

export function resolveByExactName(name) {
  if (!name) return [];
  loadContacts();
  return nameToContact.get(name.toLowerCase().trim()) || [];
}

export function getContactIdentifiers(contactId) {
  loadContacts();
  const contact = contacts.find(c => c.id === contactId);
  if (!contact) {
    return { emails: [], phones: [] };
  }
  return {
    emails: contact.emails.map(e => e.email),
    phones: contact.phones.map(p => p.phone)
  };
}

export function searchContacts(query, limit = 30) {
  loadContacts();

  if (!query) {
    return contacts.slice(0, limit);
  }

  const queryLower = query.toLowerCase();
  const matches = [];

  for (const contact of contacts) {
    const searchText = [
      contact.firstName,
      contact.lastName,
      contact.nickname,
      contact.organization,
      contact.department,
      contact.jobTitle,
      ...contact.emails.map(e => e.email),
      ...contact.phones.map(p => p.phone)
    ].filter(Boolean).join(" ").toLowerCase();

    if (searchText.includes(queryLower)) {
      matches.push(contact);
      if (matches.length >= limit) break;
    }
  }

  return matches;
}

export function lookupContact(identifier) {
  if (!identifier) return null;

  let contact = resolveEmail(identifier);
  if (contact) return contact;

  contact = resolvePhone(identifier);
  if (contact) return contact;

  const nameMatches = resolveByName(identifier);
  if (nameMatches.length > 0) {
    return nameMatches[0];
  }

  return null;
}

export function formatContact(contact) {
  if (!contact) return "Unknown";

  let result = contact.displayName;
  if (contact.organization && contact.displayName !== contact.organization) {
    result += ` (${contact.organization})`;
  }
  return result;
}

export function getContactStats() {
  loadContacts();
  return {
    total: contacts.length,
    totalContacts: contacts.length,
    withEmail: [...emailToContact.values()].length,
    withPhone: [...phoneToContact.values()].length,
    uniqueEmails: emailToContact.size,
    uniquePhones: phoneToContact.size
  };
}
