/**
 * indexer.lock acquire / release / heartbeat.
 *
 * A live holder is never displaced, even if the lock timestamp is old
 * (blocked event loop, long index cycle). Age-based steal races with that
 * "long sleep" and can let two processes write vector-index. Dead PIDs are
 * removed with a compare-and-swap unlink so a replacement lock is not deleted.
 */

import fs from "fs";
import path from "path";

export const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_LOCK_HEARTBEAT_MS = 60 * 1000;

/**
 * @param {unknown} pid
 * @param {(pid: number, signal: number) => void} [killFn]
 * @returns {boolean}
 */
export function isProcessAlive(pid, killFn = (p, signal) => process.kill(p, signal)) {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {{ pid: number, timestamp: number, raw: string } | null}
 */
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

/**
 * @param {number} pid
 * @param {number} timestamp
 * @returns {string}
 */
export function formatLockData(pid, timestamp) {
  return `${pid}:${timestamp}`;
}

/**
 * @param {{
 *   lockFile: string,
 *   pid?: number,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   isAlive?: (pid: number) => boolean,
 *   fsApi?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync" | "unlinkSync" | "mkdirSync">,
 *   log?: (msg: string) => void,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval
 * }} options
 */
export function createIndexerLock(options) {
  const lockFile = options.lockFile;
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

  function unlinkIfUnchanged(expected) {
    const current = fsApi.existsSync(lockFile) ? fsApi.readFileSync(lockFile, "utf8") : null;
    if (current !== expected) {
      return false;
    }
    fsApi.unlinkSync(lockFile);
    return true;
  }

  function acquire() {
    try {
      const lockDir = path.dirname(lockFile);
      if (!fsApi.existsSync(lockDir)) {
        fsApi.mkdirSync(lockDir, { recursive: true });
      }

      if (fsApi.existsSync(lockFile)) {
        const lockData = fsApi.readFileSync(lockFile, "utf8");
        const parsed = parseLockData(lockData);

        if (parsed && parsed.pid === pid) {
          ownsLock = true;
          try {
            fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
          } catch {
            // Heartbeat or the next cycle can retry the write.
          }
          return true;
        }

        if (parsed && isAlive(parsed.pid)) {
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

        const stalePid = parsed ? parsed.pid : "unknown";
        try {
          if (!unlinkIfUnchanged(lockData)) {
            ownsLock = false;
            return false;
          }
          log(`Removing stale lock file (PID ${stalePid} not running)`);
        } catch (err) {
          log(`Lock file error: ${err.message}`);
          ownsLock = false;
          return false;
        }
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
    } catch (e) {
      log(`Lock file error: ${e.message}`);
      ownsLock = false;
      return false;
    }
  }

  function release() {
    try {
      if (fsApi.existsSync(lockFile)) {
        const lockData = fsApi.readFileSync(lockFile, "utf8");
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
      if (!ownsLock || !fsApi.existsSync(lockFile)) {
        return false;
      }
      const lockData = fsApi.readFileSync(lockFile, "utf8");
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
