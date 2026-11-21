
import path from "path";
import fs from "fs";


export function validateFilePath(filePath, allowedDir, allowedExtensions = []) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path is required');
  }

  if (allowedExtensions.length > 0) {
    const ext = path.extname(filePath).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Invalid file extension. Allowed: ${allowedExtensions.join(', ')}`);
    }
  }

  const resolvedPath = path.resolve(filePath);
  const resolvedAllowedDir = path.resolve(allowedDir);

  if (!resolvedPath.startsWith(resolvedAllowedDir + path.sep) && resolvedPath !== resolvedAllowedDir) {
    throw new Error('Access denied: path outside allowed directory');
  }

  return resolvedPath;
}

export function validateEmailPath(filePath, mailDir) {
  return validateFilePath(filePath, mailDir, ['.emlx']);
}


export function validateLimit(value, defaultValue = 30, max = 1000) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultValue;
  }
  return Math.min(parsed, max);
}

export function validateDaysBack(value, max = 3650) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, max);
}

export function validateWeekOffset(value, max = 52) {
  const parsed = parseInt(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return Math.min(parsed, max);
}


export function escapeAppleScript(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function validateMailboxName(mailbox) {
  if (!mailbox || typeof mailbox !== 'string') {
    return null;
  }

  if (!/^[a-zA-Z0-9._ -]+$/.test(mailbox)) {
    return null;
  }

  if (mailbox.length > 100) {
    return null;
  }

  return mailbox;
}

export function escapeSQL(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "''");
}

export function validateLanceDBId(id) {
  if (!id || typeof id !== 'string') {
    return null;
  }

  if (!/^[a-zA-Z0-9\s\-:,.]+$/.test(id)) {
    return null;
  }

  if (id.length > 500) {
    return null;
  }

  return id;
}


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


export function validateDate(date) {
  if (!date) {
    return null;
  }

  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) {
      return null;
    }

    const year = d.getFullYear();
    if (year < 1990 || year > 2100) {
      return null;
    }

    return d;
  } catch {
    return null;
  }
}


export function getValidatedHome() {
  const home = process.env.HOME;

  if (!home || typeof home !== 'string') {
    throw new Error('HOME environment variable is not set');
  }

  if (!path.isAbsolute(home)) {
    throw new Error('HOME must be an absolute path');
  }

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


export function escapeRegex(str) {
  if (!str || typeof str !== 'string') {
    return '';
  }
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function safeMatch(input, pattern, maxLength = 10000) {
  if (!input || typeof input !== 'string') {
    return null;
  }
  const safeInput = input.length > maxLength ? input.substring(0, maxLength) : input;
  try {
    return safeInput.match(pattern);
  } catch {
    return null;
  }
}

export function safeReplace(input, pattern, replacement, maxLength = 50000) {
  if (!input || typeof input !== 'string') {
    return '';
  }
  const safeInput = input.length > maxLength ? input.substring(0, maxLength) : input;
  try {
    return safeInput.replace(pattern, replacement);
  } catch {
    return safeInput;
  }
}

export function stripHtmlTags(html, maxLength = 100000) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  let text = html.length > maxLength ? html.substring(0, maxLength) : html;

  let result = '';
  let inTag = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '<') {
      inTag = true;
    } else if (char === '>') {
      inTag = false;
      result += ' ';
    } else if (!inTag) {
      result += char;
    }
  }

  return result.replace(/\s+/g, ' ').trim();
}


const MAC_ABSOLUTE_EPOCH = 978307200;

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

export function unfoldRfc822Headers(content) {
  if (!content || typeof content !== 'string') {
    return '';
  }
  const split = content.search(/\r?\n\r?\n/);
  const headers = split >= 0 ? content.slice(0, split) : content;
  const body = split >= 0 ? content.slice(split) : '';
  return headers.replace(/\r?\n[ \t]+/g, ' ') + body;
}

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

export function macAbsoluteTimeToDate(macTime) {
  if (macTime === null || macTime === undefined || isNaN(macTime)) {
    return 0;
  }

  let seconds = macTime;

  if (macTime > 50000000000) {
    seconds = macTime / 1e9;
  }

  return (seconds + MAC_ABSOLUTE_EPOCH) * 1000;
}
