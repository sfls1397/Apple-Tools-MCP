
import fs from "fs";
import path from "path";

export const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_LOCK_HEARTBEAT_MS = 60 * 1000;
export const TAKEOVER_MUTEX_SUFFIX = ".takeover";
export const TAKEOVER_FENCE_DEPTH = 8;

export function getTakeoverMutexPath(lockFile) {
  return `${lockFile}${TAKEOVER_MUTEX_SUFFIX}`;
}

export function getTakeoverFencePath(lockFile, ...deadIds) {
  let p = getTakeoverMutexPath(lockFile);
  for (const id of deadIds) {
    p = `${p}.${id}`;
  }
  return p;
}

export function isProcessAlive(pid, killFn = (p, signal) => process.kill(p, signal)) {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseLockData(text) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const [pidStr, timestampStr] = text.split(":");
  const pid = parseInt(pidStr, 10);
  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    timestamp: Number.isInteger(timestamp) ? timestamp : 0,
    raw: text
  };
}

export function formatLockData(pid, timestamp) {
  return `${pid}:${timestamp}`;
}

export const LOCK_HOLDER_FRESH_MS = 5 * DEFAULT_LOCK_HEARTBEAT_MS;

export function readIndexerLockHolder(options) {
  const fsApi = options.fsApi || fs;
  const isAlive = options.isAlive || ((holderPid) => isProcessAlive(holderPid));
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const freshMs = options.freshMs ?? LOCK_HOLDER_FRESH_MS;
  let text;
  try {
    text = fsApi.readFileSync(options.lockFile, "utf8");
  } catch {
    return null;
  }
  const parsed = parseLockData(text);
  if (!parsed) return null;
  const checkedInMsAgo = Math.max(0, now - parsed.timestamp);
  if (!isAlive(parsed.pid)) return { state: "dead", pid: parsed.pid, checkedInMsAgo };
  const state = parsed.timestamp > 0 && checkedInMsAgo <= freshMs ? "running" : "stuck";
  return { state, pid: parsed.pid, checkedInMsAgo };
}

export function createIndexerLock(options) {
  const lockFile = options.lockFile;
  const mutexPath = getTakeoverMutexPath(lockFile);
  const pid = options.pid ?? process.pid;
  const now = options.now || (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const isAlive = options.isAlive || ((holderPid) => isProcessAlive(holderPid));
  const fsApi = options.fsApi || fs;
  const log = options.log || ((msg) => console.error(msg));
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  let ownsLock = false;
  let heartbeatTimer = null;
  let heldMutexPath = null;

  function readLockFile() {
    if (!fsApi.existsSync(lockFile)) {
      return null;
    }
    return fsApi.readFileSync(lockFile, "utf8");
  }

  function skipLiveHolder(parsed) {
    const lockAge = now() - parsed.timestamp;
    if (lockAge > timeoutMs) {
      log(
        `Lock file is ${Math.round(lockAge / 60000)} minutes old, but PID ${parsed.pid} is still running. Not taking over.`
      );
    } else {
      log(`Another indexing instance running (PID ${parsed.pid}). Skipping indexing.`);
    }
    ownsLock = false;
    return false;
  }

  function refreshOwned() {
    ownsLock = true;
    try {
      fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
    } catch {
    }
    return true;
  }

  function tryAcquireMutex() {
    const token = formatLockData(pid, now());
    let candidate = mutexPath;
    try {
      for (let depth = 0; depth < TAKEOVER_FENCE_DEPTH; depth++) {
        let exists = false;
        for (let spin = 0; spin < 4; spin++) {
          try {
            fsApi.writeFileSync(candidate, token, { flag: "wx" });
            heldMutexPath = candidate;
            return true;
          } catch (err) {
            if (err && err.code === "ENOENT") {
              continue;
            }
            if (!err || err.code !== "EEXIST") {
              throw err;
            }
            exists = true;
            break;
          }
        }
        if (!exists) {
          return false;
        }
        let data;
        try {
          data = fsApi.readFileSync(candidate, "utf8");
        } catch (err) {
          if (err && err.code === "ENOENT") {
            continue;
          }
          throw err;
        }
        const parsed = parseLockData(data);
        if (!parsed) {
          return false;
        }
        if (isAlive(parsed.pid)) {
          return false;
        }
        candidate = `${candidate}.${parsed.pid}`;
      }
      return false;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        return false;
      }
      log(`Takeover mutex error: ${err.message}`);
      return false;
    }
  }

  function dropMutex() {
    const held = heldMutexPath;
    heldMutexPath = null;
    if (!held) {
      return;
    }
    try {
      if (!fsApi.existsSync(held)) {
        return;
      }
      const data = fsApi.readFileSync(held, "utf8");
      const parsed = parseLockData(data);
      if (parsed && parsed.pid === pid) {
        fsApi.unlinkSync(held);
      }
    } catch (err) {
      log(`Takeover mutex release error: ${err.message}`);
    }
  }

  function finishAcquireUnderMutex(expectedStale) {
    const current = readLockFile();

    if (current !== null) {
      const parsed = parseLockData(current);
      if (!parsed) {
        ownsLock = false;
        return false;
      }
      if (parsed.pid === pid) {
        return refreshOwned();
      }
      if (isAlive(parsed.pid)) {
        return skipLiveHolder(parsed);
      }
      if (expectedStale === null || current !== expectedStale) {
        ownsLock = false;
        return false;
      }
      const again = readLockFile();
      if (again !== expectedStale) {
        ownsLock = false;
        return false;
      }
      try {
        fsApi.unlinkSync(lockFile);
      } catch (err) {
        if (!err || err.code !== "ENOENT") {
          throw err;
        }
      }
      log(`Removing stale lock file (PID ${parsed ? parsed.pid : "unknown"} not running)`);
    }

    try {
      fsApi.writeFileSync(lockFile, formatLockData(pid, now()), { flag: "wx" });
      ownsLock = true;
      return true;
    } catch (err) {
      if (err.code === "EEXIST") {
        log("Another process acquired lock during race. Skipping indexing.");
        ownsLock = false;
        return false;
      }
      throw err;
    }
  }

  function acquire() {
    try {
      const lockDir = path.dirname(lockFile);
      if (!fsApi.existsSync(lockDir)) {
        fsApi.mkdirSync(lockDir, { recursive: true });
      }

      const existing = readLockFile();
      if (existing !== null) {
        const parsed = parseLockData(existing);
        if (!parsed) {
          ownsLock = false;
          return false;
        }
        if (parsed.pid === pid) {
          return refreshOwned();
        }
        if (isAlive(parsed.pid)) {
          return skipLiveHolder(parsed);
        }
      }

      if (!tryAcquireMutex()) {
        log("Another process acquired lock during race. Skipping indexing.");
        ownsLock = false;
        return false;
      }
      try {
        return finishAcquireUnderMutex(existing);
      } finally {
        dropMutex();
      }
    } catch (e) {
      log(`Lock file error: ${e.message}`);
      ownsLock = false;
      return false;
    }
  }

  function release() {
    try {
      const lockData = readLockFile();
      if (lockData) {
        const parsed = parseLockData(lockData);
        if (parsed && parsed.pid === pid) {
          fsApi.unlinkSync(lockFile);
          ownsLock = false;
          log(`Released lock file (PID ${pid})`);
        }
      }
    } catch (err) {
      log(`Error releasing lock: ${err.message}`);
    }
  }

  function refresh() {
    try {
      if (!ownsLock) {
        return false;
      }
      const lockData = readLockFile();
      if (!lockData) {
        return false;
      }
      const parsed = parseLockData(lockData);
      if (parsed && parsed.pid === pid) {
        fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
        return true;
      }
      return false;
    } catch (err) {
      log(`Lock heartbeat error: ${err.message}`);
      return false;
    }
  }

  function startHeartbeat(intervalMs = DEFAULT_LOCK_HEARTBEAT_MS) {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setIntervalFn(() => {
      refresh();
    }, intervalMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    acquire,
    release,
    refresh,
    startHeartbeat,
    stopHeartbeat,
    get ownsLock() {
      return ownsLock;
    }
  };
}
