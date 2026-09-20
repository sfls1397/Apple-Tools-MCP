/**
 * Contact Resolution Service
 *
 * Provides unified contact lookup across email addresses, phone numbers, and names.
 * Uses macOS AddressBook database to resolve identifiers to full contact records.
 */

import fs from "fs";
import path from "path";
import { safeSqlite3, safeSqlite3Json } from "./lib/shell.js";

// Database location - iCloud synced contacts are in Sources subdirectory
const ADDRESSBOOK_DIR = path.join(process.env.HOME, "Library", "Application Support", "AddressBook");
const SOURCES_DIR = path.join(ADDRESSBOOK_DIR, "Sources");

// In-memory lookup maps for fast resolution
let contactsLoaded = false;
let contacts = [];  // Array of all contact records
const emailToContact = new Map();  // email (lowercase) -> contact
const phoneToContact = new Map();  // normalized phone -> contact
const nameToContact = new Map();   // "firstname lastname" (lowercase) -> contact[]

// Cache settings
const CACHE_TTL = 5 * 60 * 1000;  // 5 minutes
let lastLoadTime = 0;

// Memory bounds - prevent excessive memory usage with very large contact databases
const MAX_CONTACTS = 50000;  // Maximum contacts to load
const MAX_EMAILS_PER_CONTACT = 10;  // Maximum email addresses per contact
const MAX_PHONES_PER_CONTACT = 10;  // Maximum phone numbers per contact

/**
 * Find the contacts database file (handles iCloud sync location)
 */
function findContactsDatabase() {
  // First check Sources directory for iCloud-synced contacts
  if (fs.existsSync(SOURCES_DIR)) {
    const sources = fs.readdirSync(SOURCES_DIR);
    for (const source of sources) {
      const dbPath = path.join(SOURCES_DIR, source, "AddressBook-v22.abcddb");
      if (fs.existsSync(dbPath)) {
        // Check if it has actual data (not empty)
        try {
          const result = safeSqlite3(dbPath, "SELECT COUNT(*) FROM ZABCDRECORD", { json: false, timeout: 5000 });
          const count = parseInt(result.trim());
          if (count > 0) {
            return dbPath;
          }
        } catch (e) {
          // Continue to next source
        }
      }
    }
  }

  // Fallback to main AddressBook database
  const mainDb = path.join(ADDRESSBOOK_DIR, "AddressBook-v22.abcddb");
  if (fs.existsSync(mainDb)) {
    return mainDb;
  }

  return null;
}

/**
 * Normalize phone number for consistent matching
 * Strips all non-digit characters except leading +
 */
function normalizePhone(phone) {
  if (!phone) return "";
  // Keep leading + for international, then only digits
  const hasPlus = phone.startsWith("+");
  const digits = phone.replace(/\D/g, "");
  // For US numbers, normalize to 10 digits (remove leading 1)
  const wasUSNumber = digits.length === 11 && digits.startsWith("1");
  const normalized = wasUSNumber
    ? digits.slice(1)
    : digits;
  // Only keep + if it wasn't a US number (didn't remove leading 1)
  return (hasPlus && !wasUSNumber) ? `+${normalized}` : normalized;
}

/**
 * Load all contacts from the AddressBook database
 */
export function loadContacts() {
  const now = Date.now();

  // Return cached if still valid
  if (contactsLoaded && (now - lastLoadTime) < CACHE_TTL) {
    return contacts;
  }

  const dbPath = findContactsDatabase();
  if (!dbPath) {
    console.error("Contacts database not found");
    return [];
  }

  try {
    // Query all contacts with their basic info (with limit for memory safety).
    // ZUNIQUEID is the Contacts.app person id the write tools address contacts
    // by; a schema without it must still load contacts for search.
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

    // Query all email addresses
    const emailQuery = `
      SELECT
        ZOWNER as contactId,
        ZADDRESS as email,
        ZLABEL as label
      FROM ZABCDEMAILADDRESS
      WHERE ZADDRESS IS NOT NULL
    `;

    const emails = safeSqlite3Json(dbPath, emailQuery, { timeout: 10000 });

    // Query all phone numbers
    const phoneQuery = `
      SELECT
        ZOWNER as contactId,
        ZFULLNUMBER as phone,
        ZLABEL as label
      FROM ZABCDPHONENUMBER
      WHERE ZFULLNUMBER IS NOT NULL
    `;

    const phones = safeSqlite3Json(dbPath, phoneQuery, { timeout: 10000 });

    // Group emails and phones by contact ID (with per-contact limits)
    const emailsByContact = new Map();
    for (const e of emails) {
      if (!emailsByContact.has(e.contactId)) {
        emailsByContact.set(e.contactId, []);
      }
      const contactEmails = emailsByContact.get(e.contactId);
      // Limit emails per contact to prevent memory issues
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
      // Limit phones per contact to prevent memory issues
      if (contactPhones.length < MAX_PHONES_PER_CONTACT) {
        contactPhones.push({
          phone: p.phone,
          normalized: normalizePhone(p.phone),
          label: p.label || "other"
        });
      }
    }

    // Build complete contact records and lookup maps
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

      // Build email lookup
      for (const e of contact.emails) {
        const emailLower = e.email.toLowerCase();
        emailToContact.set(emailLower, contact);
      }

      // Build phone lookup (using normalized phone)
      for (const p of contact.phones) {
        if (p.normalized) {
          phoneToContact.set(p.normalized, contact);
        }
      }

      // Build name lookup
      const fullName = `${contact.firstName} ${contact.lastName}`.trim().toLowerCase();
      if (fullName) {
        if (!nameToContact.has(fullName)) {
          nameToContact.set(fullName, []);
        }
        nameToContact.get(fullName).push(contact);
      }

      // Also index by first name only for fuzzy matching
      if (contact.firstName) {
        const firstLower = contact.firstName.toLowerCase();
        if (!nameToContact.has(firstLower)) {
          nameToContact.set(firstLower, []);
        }
        nameToContact.get(firstLower).push(contact);
      }

      // Index by nickname
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
    console.error("Error loading contacts:", e.message);
    return [];
  }
}

/**
 * Format display name from contact record
 */
function formatDisplayName(contact) {
  const parts = [];
  if (contact.firstName) parts.push(contact.firstName);
  if (contact.lastName) parts.push(contact.lastName);
  if (parts.length === 0 && contact.organization) {
    return contact.organization;
  }
  return parts.join(" ");
}

/**
 * Resolve an email address to a contact record
 * @param {string} email - Email address to look up
 * @returns {object|null} Contact record or null if not found
 */
export function resolveEmail(email) {
  if (!email) return null;
  loadContacts();  // Ensure contacts are loaded
  return emailToContact.get(email.toLowerCase()) || null;
}

/**
 * Resolve a phone number to a contact record
 * @param {string} phone - Phone number to look up (any format)
 * @returns {object|null} Contact record or null if not found
 */
export function resolvePhone(phone) {
  if (!phone) return null;
  loadContacts();  // Ensure contacts are loaded
  const normalized = normalizePhone(phone);
  return phoneToContact.get(normalized) || null;
}

/**
 * Resolve a name to matching contact records (fuzzy match)
 * @param {string} name - Name to search for
 * @returns {object[]} Array of matching contacts (may be empty)
 */
export function resolveByName(name) {
  if (!name) return [];
  loadContacts();  // Ensure contacts are loaded

  const nameLower = name.toLowerCase().trim();

  // Exact match first
  const exact = nameToContact.get(nameLower);
  if (exact && exact.length > 0) {
    return exact;
  }

  // Partial match - search all contacts
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

/**
 * Get all identifiers (emails and phones) for a contact
 * @param {number} contactId - Contact ID
 * @returns {object} { emails: string[], phones: string[] }
 */
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

/**
 * Search contacts by query (name, email, phone, or organization)
 * @param {string} query - Search query
 * @param {number} limit - Maximum results
 * @returns {object[]} Matching contacts
 */
export function searchContacts(query, limit = 30) {
  loadContacts();

  if (!query) {
    return contacts.slice(0, limit);
  }

  const queryLower = query.toLowerCase();
  const matches = [];

  for (const contact of contacts) {
    // Check all searchable fields
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

/**
 * Look up a contact by any identifier (email, phone, or name)
 * @param {string} identifier - Email, phone, or name
 * @returns {object|null} Contact record or null
 */
export function lookupContact(identifier) {
  if (!identifier) return null;

  // Try email first (most specific)
  let contact = resolveEmail(identifier);
  if (contact) return contact;

  // Try phone
  contact = resolvePhone(identifier);
  if (contact) return contact;

  // Try name (return first match)
  const nameMatches = resolveByName(identifier);
  if (nameMatches.length > 0) {
    return nameMatches[0];
  }

  return null;
}

/**
 * Format contact for display
 * @param {object} contact - Contact record
 * @returns {string} Formatted contact string
 */
export function formatContact(contact) {
  if (!contact) return "Unknown";

  let result = contact.displayName;
  if (contact.organization && contact.displayName !== contact.organization) {
    result += ` (${contact.organization})`;
  }
  return result;
}

/**
 * Get contact stats
 * @returns {object} Stats about loaded contacts
 */
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
