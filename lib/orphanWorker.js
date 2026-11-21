
import { execFileSync } from "child_process";
import { isProcessAlive, readIndexerLockHolder } from "./indexerLock.js";

export const INDEX_WORKER_FLAG = "--indexer-worker";
export const ORPHAN_TERM_GRACE_MS = 5000;

export function isOrphanedIndexWorker(info, ownUid) {
  if (!info || typeof info.args !== "string") return false;
  const words = info.args.trim().split(/\s+/);
  return info.ppid === 1 &&
    info.uid === ownUid &&
    words.includes(INDEX_WORKER_FLAG) &&
    words.includes("--mode=indexer");
}

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
  if (!isOrphanedIndexWorker(readInfo(pid), ownUid)) return { reaped: false, pid };
  try {
    kill(pid, "SIGKILL");
  } catch {
  }
  const gone = await waitGone();
  log(gone
    ? `Orphaned index worker PID ${pid} killed`
    : `Orphaned index worker PID ${pid} did not exit yet; the new worker waits for indexer.lock`);
  return { reaped: gone, pid, signal: "SIGKILL" };
}
