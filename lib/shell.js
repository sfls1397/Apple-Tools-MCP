/**
 * Safe shell execution utilities for apple-tools-mcp
 *
 * This module provides secure wrappers around child_process functions
 * to prevent command injection vulnerabilities by:
 * - Using spawnSync instead of execSync (avoids shell interpolation)
 * - Passing arguments as arrays, not concatenated strings
 * - Validating inputs before execution
 */

import { spawnSync } from "child_process";
import path from "path";
import { escapeSQL } from "./validators.js";

// ============ SQLITE3 EXECUTION ============

/**
 * Safely execute a sqlite3 query using spawnSync
 * Prevents command injection by passing args as array
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {string} query - SQL query to execute
 * @param {object} options - Additional options
 * @param {boolean} options.json - Return JSON output (default: true)
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @param {number} options.maxBuffer - Max buffer size (default: 50MB)
 * @returns {string} Raw output from sqlite3
 * @throws {Error} If execution fails
 */
export function safeSqlite3(dbPath, query, options = {}) {
  const {
    json = true,
    timeout = 30000,
    maxBuffer = 50 * 1024 * 1024
  } = options;

  // Validate database path exists and is absolute
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('Database path is required');
  }
  if (!path.isAbsolute(dbPath)) {
    throw new Error('Database path must be absolute');
  }

  // Validate query
  if (!query || typeof query !== 'string') {
    throw new Error('SQL query is required');
  }

  // Build args array - no shell interpolation possible
  const args = [];
  if (json) {
    args.push('-json');
  }
  args.push(dbPath);
  args.push(query.replace(/\n/g, ' ')); // Normalize whitespace

  const result = spawnSync('sqlite3', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer,
    // Don't use shell - prevents injection
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errorMsg = result.stderr || `sqlite3 exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return result.stdout;
}

/**
 * Execute sqlite3 and parse JSON result
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {string} query - SQL query to execute
 * @param {object} options - Additional options
 * @returns {Array} Parsed JSON array of results
 */
export function safeSqlite3Json(dbPath, query, options = {}) {
  const output = safeSqlite3(dbPath, query, { ...options, json: true });

  if (!output || output.trim() === '') {
    return [];
  }

  try {
    return JSON.parse(output);
  } catch (e) {
    throw new Error(`Failed to parse sqlite3 JSON output: ${e.message}`);
  }
}

// ============ OSASCRIPT EXECUTION ============

/**
 * Safely execute AppleScript using spawnSync
 * Uses stdin to pass script content, preventing shell injection
 *
 * @param {string} script - AppleScript to execute
 * @param {object} options - Additional options
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @returns {string} Output from AppleScript
 * @throws {Error} If execution fails
 */
export function safeOsascript(script, options = {}) {
  const {
    timeout = 30000
  } = options;

  if (!script || typeof script !== 'string') {
    throw new Error('AppleScript is required');
  }

  // Use -e flag with the script content passed as argument
  // This is safer than heredoc shell syntax
  const result = spawnSync('osascript', ['-e', script], {
    encoding: 'utf-8',
    timeout,
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  // osascript may return non-zero for certain operations
  // Return stdout if we have it, otherwise throw
  if (result.status !== 0 && !result.stdout) {
    const errorMsg = result.stderr || `osascript exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return result.stdout;
}

// ============ MDFIND EXECUTION ============

/**
 * Safely execute mdfind (Spotlight search) using spawnSync
 *
 * @param {string} query - Spotlight query
 * @param {object} options - Additional options
 * @param {string} options.onlyin - Directory to search in
 * @param {number} options.timeout - Timeout in ms (default: 60000)
 * @returns {string[]} Array of file paths
 */
export function safeMdfind(query, options = {}) {
  const {
    onlyin,
    timeout = 60000
  } = options;

  if (!query || typeof query !== 'string') {
    throw new Error('Search query is required');
  }

  const args = [];

  if (onlyin) {
    if (!path.isAbsolute(onlyin)) {
      throw new Error('onlyin path must be absolute');
    }
    args.push('-onlyin', onlyin);
  }

  args.push(query);

  const result = spawnSync('mdfind', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 100 * 1024 * 1024, // 100MB for large result sets
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errorMsg = result.stderr || `mdfind exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  // Split output into lines, filter empty
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// ============ FIND EXECUTION ============

/**
 * Safely execute find command using spawnSync
 *
 * @param {string} searchPath - Directory to search
 * @param {object} options - Find options
 * @param {string} options.name - Filename pattern (-name)
 * @param {string} options.type - File type (-type f, d, etc.)
 * @param {string} options.mtime - Modification time (-mtime)
 * @param {number} options.maxdepth - Max directory depth
 * @param {number} options.timeout - Timeout in ms (default: 120000)
 * @returns {string[]} Array of file paths
 */
export function safeFind(searchPath, options = {}) {
  const {
    name,
    type,
    mtime,
    maxdepth,
    timeout = 120000
  } = options;

  if (!searchPath || typeof searchPath !== 'string') {
    throw new Error('Search path is required');
  }
  if (!path.isAbsolute(searchPath)) {
    throw new Error('Search path must be absolute');
  }

  const args = [searchPath];

  if (maxdepth !== undefined) {
    const depth = parseInt(maxdepth);
    if (!Number.isInteger(depth) || depth < 0) {
      throw new Error('maxdepth must be a non-negative integer');
    }
    args.push('-maxdepth', String(depth));
  }

  if (type) {
    // Validate type is a single character
    if (!/^[fdlbcps]$/.test(type)) {
      throw new Error('Invalid find type');
    }
    args.push('-type', type);
  }

  if (name) {
    args.push('-name', name);
  }

  if (mtime) {
    // Validate mtime format (e.g., -1, +7, 0)
    if (!/^[+-]?\d+$/.test(mtime)) {
      throw new Error('Invalid mtime format');
    }
    args.push('-mtime', mtime);
  }

  const result = spawnSync('find', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 100 * 1024 * 1024,
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  const paths = (result.stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Partial permission errors can still yield some paths; keep those.
  // A complete failure (no paths + non-zero status) must not be treated as
  // "zero files" — callers persist index timestamps on empty scans.
  if (result.status !== 0 && paths.length === 0) {
    const errorMsg = (result.stderr || '').trim() || `find exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return paths;
}

// ============ GENERIC SAFE SPAWN ============

/**
 * Generic safe spawn wrapper for other commands
 *
 * @param {string} command - Command to execute
 * @param {string[]} args - Arguments as array
 * @param {object} options - spawnSync options
 * @returns {object} { stdout, stderr, status }
 */
export function safeSpawn(command, args = [], options = {}) {
  const {
    timeout = 30000,
    maxBuffer = 10 * 1024 * 1024,
    encoding = 'utf-8',
    ...restOptions
  } = options;

  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }

  if (!Array.isArray(args)) {
    throw new Error('Args must be an array');
  }

  const result = spawnSync(command, args, {
    encoding,
    timeout,
    maxBuffer,
    shell: false,
    ...restOptions
  });

  if (result.error) {
    throw result.error;
  }

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status
  };
}
