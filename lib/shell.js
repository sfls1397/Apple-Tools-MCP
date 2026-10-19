/**
 * Safe shell execution utilities for apple-tools-mcp
 *
 * This module provides secure wrappers around child_process functions
 * to prevent command injection vulnerabilities by:
 * - Using spawnSync instead of execSync (avoids shell interpolation)
 * - Passing arguments as arrays, not concatenated strings
 * - Validating inputs before execution
 */

import { spawn, spawnSync } from "child_process";
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
 * @param {boolean} options.readonly - Open the database read-only (default: false)
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @param {number} options.maxBuffer - Max buffer size (default: 50MB)
 * @returns {string} Raw output from sqlite3
 * @throws {Error} If execution fails
 */
function buildSqlite3Args(dbPath, query, { json = true, readonly = false } = {}) {
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
  if (readonly) {
    args.push('-readonly');
  }
  args.push(dbPath);
  args.push(query.replace(/\n/g, ' ')); // Normalize whitespace
  return args;
}

function sqlite3Output(result) {
  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errorMsg = result.stderr || `sqlite3 exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return result.stdout;
}

function parseSqlite3Json(output) {
  if (!output || output.trim() === '') {
    return [];
  }

  try {
    return JSON.parse(output);
  } catch (e) {
    throw new Error(`Failed to parse sqlite3 JSON output: ${e.message}`);
  }
}

export function safeSqlite3(dbPath, query, options = {}) {
  const {
    timeout = 30000,
    maxBuffer = 50 * 1024 * 1024
  } = options;
  const args = buildSqlite3Args(dbPath, query, options);

  const result = spawnSync('sqlite3', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer,
    // Don't use shell - prevents injection
    shell: false
  });

  return sqlite3Output(result);
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
  return parseSqlite3Json(safeSqlite3(dbPath, query, { ...options, json: true }));
}

/**
 * Async safeSqlite3Json for long-lived processes (the indexer daemon):
 * a slow query under load waits without blocking the event loop, so the
 * write bridge (writer.sock) keeps answering while an index cycle reads.
 * Same validation, argv and error semantics as the sync version.
 */
export async function safeSqlite3JsonAsync(dbPath, query, options = {}) {
  const {
    timeout = 30000,
    maxBuffer = 50 * 1024 * 1024
  } = options;
  const args = buildSqlite3Args(dbPath, query, { ...options, json: true });
  const result = await spawnCollect('sqlite3', args, { timeout, maxBuffer });
  return parseSqlite3Json(sqlite3Output(result));
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
const OSASCRIPT_LANGUAGES = new Set(["JavaScript"]);

export function safeOsascript(script, options = {}) {
  const {
    timeout = 30000,
    language = null
  } = options;

  if (!script || typeof script !== 'string') {
    throw new Error('AppleScript is required');
  }

  const args = [];
  if (language) {
    if (!OSASCRIPT_LANGUAGES.has(language)) {
      throw new Error(`Unsupported osascript language: ${language}`);
    }
    args.push("-l", language);
  }
  args.push("-e", script);

  // Use -e with the script as an argument (never a shell string).
  // Hung Apple Events ignore SIGTERM (Mini write-bridge ~60s wedge).
  // Timeout must SIGKILL osascript so compose fails fast instead of hanging.
  const result = spawnSync('osascript', args, {
    encoding: 'utf-8',
    timeout,
    killSignal: 'SIGKILL',
    shell: false
  });

  const stderr = String(result.stderr || "").trim().slice(0, 500);

  if (result.error) {
    if (stderr) {
      const wrapped = new Error(`${result.error.message}; osascript stderr: ${stderr}`);
      wrapped.code = result.error.code;
      throw wrapped;
    }
    throw result.error;
  }

  // osascript may return non-zero for certain operations
  // Return stdout if we have it, otherwise throw
  if (result.status !== 0 && !result.stdout) {
    const errorMsg = stderr || `osascript exited with code ${result.status}`;
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
function buildFindArgs(searchPath, options = {}) {
  const {
    name,
    type,
    mtime,
    maxdepth
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
  return args;
}

function findPaths(result) {
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

export function safeFind(searchPath, options = {}) {
  const { timeout = 120000 } = options;
  const args = buildFindArgs(searchPath, options);
  const result = spawnSync('find', args, {
    encoding: 'utf-8',
    timeout,
    maxBuffer: 100 * 1024 * 1024,
    shell: false
  });
  return findPaths(result);
}

/**
 * Async safeFind for the indexer daemon: a 2-minute find under heavy load
 * no longer freezes the daemon's event loop (and with it writer.sock).
 */
export async function safeFindAsync(searchPath, options = {}) {
  const { timeout = 120000 } = options;
  const args = buildFindArgs(searchPath, options);
  const result = await spawnCollect('find', args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  return findPaths(result);
}

/**
 * spawn() with spawnSync-shaped results: { stdout, stderr, status, error }.
 * Never a shell. On timeout the child is SIGKILLed and `error` is an
 * ETIMEDOUT Error like spawnSync's; output past maxBuffer kills the child
 * with ENOBUFS. Resolves (never rejects) so callers keep sync semantics.
 */
export function spawnCollect(command, args, { timeout = 30000, maxBuffer = 10 * 1024 * 1024, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ stdout: '', stderr: '', status: null, error: e });
      return;
    }
    const out = [];
    const err = [];
    let size = 0;
    let error = null;
    let settled = false;
    const kill = (e) => {
      if (!error) error = e;
      try {
        child.kill('SIGKILL');
      } catch {
        // already exited
      }
    };
    const timer = timeout > 0
      ? setTimeout(() => {
        const e = new Error(`spawn ${command} ETIMEDOUT`);
        e.code = 'ETIMEDOUT';
        kill(e);
      }, timeout)
      : null;
    const collect = (chunks) => (chunk) => {
      size += chunk.length;
      if (size > maxBuffer) {
        const e = new Error(`spawn ${command} ENOBUFS`);
        e.code = 'ENOBUFS';
        kill(e);
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const finish = (status, spawnError) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        status,
        error: error || spawnError || null
      });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code, null));
  });
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
/**
 * Launch a first-party app with `open -a` (argv only, never a shell).
 * Contacts cold-start under launchd does not reliably auto-launch from
 * `tell application "Contacts"`; `open -a Contacts` is the host-proven path.
 */
export const OPEN_APP_ALLOWLIST = Object.freeze(["Contacts", "Mail", "Messages"]);

export function safeOpenApp(appName, options = {}) {
  const { timeout = 15000, spawn = spawnSync } = options;
  if (!OPEN_APP_ALLOWLIST.includes(appName)) {
    throw new Error("open -a app name is not allowed");
  }
  const result = spawn("open", ["-a", appName], {
    encoding: "utf-8",
    timeout,
    shell: false
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(stderr || `open -a ${appName} exited ${result.status}`);
  }
  return String(result.stdout || "").trim();
}

/**
 * Start a command in the background and return immediately (no shell, no
 * timeout, stdio ignored). The child is detached and unref'd, so it is never
 * killed mid-run by a spawnSync timeout and never holds the caller open — for
 * self-terminating helpers like `caffeinate -t N`. Returns the pid, or null if
 * the spawn failed.
 */
export function safeSpawnDetached(command, args = []) {
  if (!command || typeof command !== 'string') {
    throw new Error('Command is required');
  }

  if (!Array.isArray(args)) {
    throw new Error('Args must be an array');
  }

  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
  return child.pid ?? null;
}

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
