
import { spawn, spawnSync } from "child_process";
import path from "path";
import { escapeSQL } from "./validators.js";


function buildSqlite3Args(dbPath, query, { json = true, readonly = false } = {}) {
  if (!dbPath || typeof dbPath !== 'string') {
    throw new Error('Database path is required');
  }
  if (!path.isAbsolute(dbPath)) {
    throw new Error('Database path must be absolute');
  }

  if (!query || typeof query !== 'string') {
    throw new Error('SQL query is required');
  }

  const args = [];
  if (json) {
    args.push('-json');
  }
  if (readonly) {
    args.push('-readonly');
  }
  args.push(dbPath);
  args.push(query.replace(/\n/g, ' '));
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
    shell: false
  });

  return sqlite3Output(result);
}

export function safeSqlite3Json(dbPath, query, options = {}) {
  return parseSqlite3Json(safeSqlite3(dbPath, query, { ...options, json: true }));
}

export async function safeSqlite3JsonAsync(dbPath, query, options = {}) {
  const {
    timeout = 30000,
    maxBuffer = 50 * 1024 * 1024
  } = options;
  const args = buildSqlite3Args(dbPath, query, { ...options, json: true });
  const result = await spawnCollect('sqlite3', args, { timeout, maxBuffer });
  return parseSqlite3Json(sqlite3Output(result));
}


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

  if (result.status !== 0 && !result.stdout) {
    const errorMsg = stderr || `osascript exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return result.stdout;
}


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
    maxBuffer: 100 * 1024 * 1024,
    shell: false
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errorMsg = result.stderr || `mdfind exited with code ${result.status}`;
    throw new Error(errorMsg);
  }

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}


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
    if (!/^[fdlbcps]$/.test(type)) {
      throw new Error('Invalid find type');
    }
    args.push('-type', type);
  }

  if (name) {
    args.push('-name', name);
  }

  if (mtime) {
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

export async function safeFindAsync(searchPath, options = {}) {
  const { timeout = 120000 } = options;
  const args = buildFindArgs(searchPath, options);
  const result = await spawnCollect('find', args, { timeout, maxBuffer: 100 * 1024 * 1024 });
  return findPaths(result);
}

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
