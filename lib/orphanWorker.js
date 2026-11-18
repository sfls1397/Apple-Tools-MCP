/**
 * Reap an index worker left behind when its daemon parent died abruptly.
 *
 * The indexer daemon forks one index worker (`--mode=indexer
 * --indexer-worker`) and keeps the write bridge in the parent. A worker
 * whose event loop is free exits on its own when the IPC channel closes.
 * One whose event loop is blocked (a stuck synchronous read) cannot, and
 * launchd does not kill it either: when the job's main process dies, launchd
 * signals the rest of the process group but never escalates to SIGKILL
 * (proved on the Mac mini, Nov 17 2026). The orphan then keeps indexer.lock
 * forever and the restarted daemon's new worker waits behind it.
 *
 * Only the indexer.lock holder is a candidate, and only when every check
 * passes: its parent is gone (re-parented to launchd, PID 1), it runs as this
 * user, and its command line is an index worker's. Anything else (a stdio
 * MCP client that won the lock, another daemon's live worker) is left alone.
 * The worker never serves writes, so stopping it cannot start or repeat one.
 */

import { execFileSync } from "child_process";
import { isProcessAlive, readIndexerLockHolder } from "./indexerLock.js";

export const INDEX_WORKER_FLAG = "--indexer-worker";
export const ORPHAN_TERM_GRACE_MS = 5000;

/**
 * @param {{ ppid: number, uid: number, args: string } | null | undefined} info
 * @param {number} ownUid
 * @returns {boolean}
 */
export function isOrphanedIndexWorker(info, ownUid) {
  if (!info || typeof info.args !== "string") return false;
  const words = info.args.trim().split(/\s+/);
  return info.ppid === 1 &&
    info.uid === ownUid &&
    words.includes(INDEX_WORKER_FLAG) &&
    words.includes("--mode=indexer");
}

/**
 * @param {number} pid
 * @param {typeof execFileSync} [exec]
 * @returns {{ ppid: number, uid: number, args: string } | null}
 */
export function readProcessInfo(pid, exec = execFileSync) {
  try {
    const out = exec("/bin/ps", ["-o", "ppid=,uid=,args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const match = String(out).trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) return null;
    return { ppid: Number(match[1]), uid: Number(match[2]), args: match[3] };
  } catch {
    return null;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   lockFile: string,
 *   ownPid?: number,
 *   ownUid?: number,
 *   readHolder?: () => ({ state: string, pid: number } | null),
 *   readInfo?: (pid: number) => ({ ppid: number, uid: number, args: string } | null),
 *   kill?: (pid: number, signal: string) => void,
 *   isAlive?: (pid: number) => boolean,
 *   sleep?: (ms: number) => Promise<void>,
 *   graceMs?: number,
 *   log?: (msg: string) => void
 * }} options
 * @returns {Promise<{ reaped: boolean, pid?: number, signal?: string }>}
 */
export async function reapOrphanedIndexWorker(options) {
  const {
    lockFile,
    ownPid = process.pid,
    ownUid = process.getuid(),
    readHolder = () => readIndexerLockHolder({ lockFile }),
    readInfo = readProcessInfo,
    kill = (pid, signal) => process.kill(pid, signal),
    isAlive = (pid) => isProcessAlive(pid),
    sleep = defaultSleep,
    graceMs = ORPHAN_TERM_GRACE_MS,
    log = () => {}
  } = options;

  let holder;
  try {
    holder = readHolder();
  } catch {
    return { reaped: false };
  }
  if (!holder || holder.state === "dead" || holder.pid === ownPid) return { reaped: false };
  const pid = holder.pid;
  if (!isOrphanedIndexWorker(readInfo(pid), ownUid)) return { reaped: false, pid };

  const waitGone = async () => {
    for (let waited = 0; waited < graceMs; waited += 100) {
      if (!isAlive(pid)) return true;
      await sleep(100);
    }
    return !isAlive(pid);
  };

  log(`indexer.lock is held by orphaned index worker PID ${pid} (its daemon is gone); stopping it`);
  try {
    kill(pid, "SIGTERM");
  } catch {
    return { reaped: !isAlive(pid), pid, signal: "SIGTERM" };
  }
  if (await waitGone()) {
    log(`Orphaned index worker PID ${pid} exited`);
    return { reaped: true, pid, signal: "SIGTERM" };
  }
  // Still there: its event loop is blocked. Check it is the same process
  // before the kill, so a reused PID is never touched.
  if (!isOrphanedIndexWorker(readInfo(pid), ownUid)) return { reaped: false, pid };
  try {
    kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  const gone = await waitGone();
  log(gone
    ? `Orphaned index worker PID ${pid} killed`
    : `Orphaned index worker PID ${pid} did not exit yet; the new worker waits for indexer.lock`);
  return { reaped: gone, pid, signal: "SIGKILL" };
}
