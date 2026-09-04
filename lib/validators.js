/**
 * Security validation and escaping utilities for apple-tools-mcp
 *
 * This module centralizes input validation to prevent:
 * - Path traversal attacks
 * - Command injection
 * - SQL injection
 * - Integer overflow
 */

import path from "path";
import fs from "fs";

// ============ PATH VALIDATION ============

/**
 * Validates that a file path is within an allowed directory and has expected extension
 * Prevents path traversal attacks like "../../../etc/passwd"
 *
 * @param {string} filePath - The path to validate
 * @param {string} allowedDir - The directory the path must be within
 * @param {string[]} allowedExtensions - Array of allowed extensions (e.g., ['.emlx'])
 * @returns {string} The resolved, validated path
 * @throws {Error} If validation fails
 */
export function validateFilePath(filePath, allowedDir, allowedExtensions = []) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path is required');
  }

  // Check extension if specified
  if (allowedExtensions.length > 0) {
    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Invalid file extension. Allowed: ${allowedExtensions.join(', ')}`);
    }
  }

  // Resolve to absolute path (handles ../ etc)
  const resolvedPath = path.resolve(filePath);
  const resolvedAllowedDir = path.resolve(allowedDir);

  // Ensure the resolved path starts with the allowed directory
  if (!resolvedPath.startsWith(resolvedAllowedDir + path.sep) && resolvedPath !== resolvedAllowedDir) {
    throw new Error('Access denied: path outside allowed directory');
  }

  return resolvedPath;
}

/**
 * Validates an email file path specifically
 * @param {string} filePath - The email file path
 * @param {string} mailDir - The Mail directory (usually ~/Library/Mail)
 * @returns {string} The validated path
 */
export function validateEmailPath(filePath, mailDir) {
  return validateFilePath(filePath, mailDir, ['.emlx']);
}

// ============ NUMERIC VALIDATION ============

/**
 * Validates and constrains a limit parameter
 * Prevents integer overflow and excessively large queries
 *
 * @param {any} value - The value to validate
 * @param {number} defaultValue - Default if invalid (default: 30)
 * @param {number} max - Maximum allowed value (default: 1000)
 * @returns {number} A safe integer within bounds
 */
export function validateLimit(value, defaultValue = 30, max = 1000) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

/**
 * Validates a days_back parameter
 * @param {any} value - The value to validate
 * @param {number} max - Maximum days back (default: 3650 = ~10 years)
 * @returns {number} A safe integer >= 0
 */
export function validateDaysBack(value, max = 3650) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, max);
}

/**
 * Validates a week offset parameter
 * @param {any} value - The value to validate
 * @param {number} max - Maximum weeks ahead (default: 52)
 * @returns {number} A safe integer >= 0
 */
export function validateWeekOffset(value, max = 52) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, max);
}

// ============ STRING ESCAPING ============

/**
 * Escapes a string for use in AppleScript double-quoted strings
 * Prevents AppleScript injection attacks
 *
 * @param {string} str - The string to escape
 * @returns {string} Escaped string safe for AppleScript
 */
export function escapeAppleScript(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  // Escape backslashes first, then quotes, then line breaks.
  // Unescaped CR/LF inside an AppleScript double-quoted string can close the
  // string and inject additional statements.
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Validates a mailbox name for use in AppleScript
 * Only allows safe characters to prevent injection
 *
 * @param {string} mailbox - The mailbox name
 * @returns {string|null} Validated mailbox name or null if invalid
 */
export function validateMailboxName(mailbox) {
  if (!mailbox || typeof mailbox !== 'string') {
    return null;
  }

  // Only allow alphanumeric, spaces, hyphens, underscores, and periods
  // Literal space only — \s would also allow newlines/tabs (injection risk)
  if (!/^[a-zA-Z0-9._ -]+$/.test(mailbox)) {
    return null;
  }

  // Also limit length
  if (mailbox.length > 100) {
    return null;
  }

  return mailbox;
}

/**
 * Escapes a string for use in SQL single-quoted strings
 * Note: Prefer parameterized queries when possible
 *
 * @param {string} str - The string to escape
 * @returns {string} Escaped string safe for SQL
 */
export function escapeSQL(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  // Double single quotes and escape backslashes
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''");
}

/**
 * Validates and sanitizes an ID string for LanceDB queries
 * @param {string} id - The ID to validate
 * @returns {string|null} Validated ID or null if invalid
 */
export function validateLanceDBId(id) {
  if (!id || typeof id !== 'string') {
    return null;
  }

  // IDs should only contain safe characters
  // Allow alphanumeric, spaces, hyphens, colons, commas, periods
  if (!/^[a-zA-Z0-9\s\-:,.]+$/.test(id)) {
    return null;
  }

  // Limit length
  if (id.length > 500) {
    return null;
  }

  return id;
}

// ============ SEARCH QUERY VALIDATION ============

/**
 * Validates a search query string
 * @param {string} query - The search query
 * @param {number} maxLength - Maximum allowed length (default: 1000)
 * @returns {string} Validated query
 * @throws {Error} If query is invalid
 */
export function validateSearchQuery(query, maxLength = 1000) {
  if (!query || typeof query !== 'string') {
    throw new Error('Search query is required');
  }

  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error('Search query cannot be empty');
  }

  if (trimmed.length > maxLength) {
    return trimmed.substring(0, maxLength);
  }

  return trimmed;
}

/**
 * Validates a contact/name string
 * @param {string} contact - The contact name or identifier
 * @param {number} maxLength - Maximum length (default: 200)
 * @returns {string|null} Validated contact or null
 */
export function validateContact(contact, maxLength = 200) {
  if (!contact || typeof contact !== 'string') {
    return null;
  }

  const trimmed = contact.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

// ============ DATE VALIDATION ============

/**
 * Validates a date string or timestamp
 * @param {string|number} date - The date to validate
 * @returns {Date|null} Validated Date object or null
 */
export function validateDate(date) {
  if (!date) {
    return null;
  }

  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) {
      return null;
    }

    // Sanity check: date should be between year 1990 and 2100
    const year = d.getFullYear();
    if (year < 1990 || year > 2100) {
      return null;
    }

    return d;
  } catch {
    return null;
  }
}

// ============ ENVIRONMENT VALIDATION ============

/**
 * Gets a validated home directory path
 * @returns {string} The home directory
 * @throws {Error} If HOME is invalid
 */
export function getValidatedHome() {
  const home = process.env.HOME;

  if (!home || typeof home !== 'string') {
    throw new Error('HOME environment variable is not set');
  }

  // Ensure it's an absolute path
  if (!path.isAbsolute(home)) {
    throw new Error('HOME must be an absolute path');
  }

  // Ensure it exists and is a directory
  try {
    const stats = fs.statSync(home);
    if (!stats.isDirectory()) {
      throw new Error('HOME is not a directory');
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error('HOME directory does not exist');
    }
    throw e;
  }

  return home;
}

// ============ REGEX SAFETY ============

/**
 * Escapes special regex characters in a string
 * Prevents ReDoS when using user input in regex patterns
 *
 * @param {string} str - The string to escape
 * @returns {string} Escaped string safe for use in RegExp
 */
export function escapeRegex(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safely execute a regex match with input length limits
 * Prevents ReDoS by limiting input size
 *
 * @param {string} input - The input string to match against
 * @param {RegExp} pattern - The regex pattern
 * @param {number} maxLength - Maximum input length (default: 10000)
 * @returns {RegExpMatchArray|null} Match result or null
 */
export function safeMatch(input, pattern, maxLength = 10000) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  // Truncate overly long inputs to prevent ReDoS
  const safeInput = input.length > maxLength ? input.substring(0, maxLength) : input;
  try {
    return safeInput.match(pattern);
  } catch {
    return null;
  }
}

/**
 * Safely execute a regex replace with input length limits
 *
 * @param {string} input - The input string
 * @param {RegExp|string} pattern - The regex pattern or string
 * @param {string|Function} replacement - The replacement string or function
 * @param {number} maxLength - Maximum input length (default: 50000)
 * @returns {string} Replaced string
 */
export function safeReplace(input, pattern, replacement, maxLength = 50000) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  // Truncate overly long inputs
  const safeInput = input.length > maxLength ? input.substring(0, maxLength) : input;
  try {
    return safeInput.replace(pattern, replacement);
  } catch {
    return safeInput;
  }
}

/**
 * Strip HTML tags safely without ReDoS vulnerability
 * Uses iterative approach instead of complex regex
 *
 * @param {string} html - The HTML string
 * @param {number} maxLength - Maximum input length (default: 100000)
 * @returns {string} Text with HTML tags removed
 */
export function stripHtmlTags(html, maxLength = 100000) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Truncate overly long inputs
  let text = html.length > maxLength ? html.substring(0, maxLength) : html;

  // Simple state machine approach - more predictable than regex
  let result = '';
  let inTag = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
      result += ' '; // Replace tag with space
    } else if (!inTag) {
      result += char;
    }
  }

  // Normalize whitespace
  return result.replace(/\s+/g, ' ').trim();
}

// ============ DATE UTILITIES ============

/**
 * Mac Absolute Time epoch constant
 * Mac epoch is January 1, 2001 00:00:00 UTC
 * Unix epoch is January 1, 1970 00:00:00 UTC
 * Difference is 978307200 seconds
 */
const MAC_ABSOLUTE_EPOCH = 978307200;

/**
 * Normalize a Unix timestamp to milliseconds.
 * Messages chat.db values are stored as seconds; email/calendar timestamps
 * are milliseconds. Treating seconds as ms drops every date-filtered message.
 *
 * Threshold 1e11 ms is 1973-03-03 — well before any real mail/message date,
 * and far above Unix seconds for year 2100 (~4e9).
 *
 * @param {number|string|null|undefined} ts
 * @returns {number} Timestamp in milliseconds, or 0 if invalid
 */
export function toUnixMillis(ts) {
  if (ts === null || ts === undefined || ts === '') {
    return 0;
  }
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return n < 1e11 ? n * 1000 : n;
}

/**
 * Unfold RFC 822 wrapped header lines (CRLF + WSP continuation) so
 * From/Subject/To matchers see the full header value.
 *
 * @param {string} content - Raw email content (headers + body)
 * @returns {string} Content with folded headers joined into single lines
 */
export function unfoldRfc822Headers(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }
  const split = content.search(/\r?\n\r?\n/);
  const headers = split >= 0 ? content.slice(0, split) : content;
  const body = split >= 0 ? content.slice(split) : '';
  return headers.replace(/\r?\n[ \t]+/g, ' ') + body;
}

/**
 * Strip repeated Re:/Fwd:/Fw: prefixes from an email subject for thread matching.
 *
 * @param {string} subject
 * @returns {string}
 */
export function stripSubjectPrefixes(subject) {
  if (!subject || typeof subject !== 'string') {
    return '';
  }
  let s = subject.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  } while (s !== prev);
  return s;
}

/**
 * Convert Mac Absolute Time to Unix timestamp (milliseconds)
 * Handles both seconds and nanoseconds formats
 *
 * @param {number} macTime - Mac absolute time value
 * @returns {number} Unix timestamp in milliseconds
 */
export function macAbsoluteTimeToDate(macTime) {
  if (macTime === null || macTime === undefined || isNaN(macTime)) {
    return 0;
  }

  let seconds = macTime;

  // Detect nanoseconds (Messages database uses nanoseconds)
  // If the value is larger than reasonable for seconds (> year 3000), assume nanoseconds
  if (macTime > 50000000000) {
    seconds = macTime / 1e9;
  }

  // Convert to Unix timestamp (milliseconds)
  return (seconds + MAC_ABSOLUTE_EPOCH) * 1000;
}
