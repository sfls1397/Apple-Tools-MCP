/**
 * Index-session search gating.
 *
 * sessionIndexComplete means "this process finished (or abandoned) its own
 * index cycle." A second MCP instance that lost the indexer lock never runs
 * a cycle, so that flag stays false. Lost-lock must not be treated as
 * "still indexing" — callers still check isIndexReady() for a missing index.
 * isIndexReady() / initDB() must re-list LanceDB tables on each check so a
 * first empty catalog (daemon writer in flight) is not cached forever.
 */

/**
 * Whether index-backed tools should return the still-indexing message.
 *
 * @param {boolean} sessionIndexComplete
 * @param {boolean} ownsIndexLock true if this process won/holds the indexer lock
 * @returns {boolean}
 */
export function isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock) {
  return Boolean(ownsIndexLock) && !sessionIndexComplete;
}

/**
 * In-memory flags after an index or rebuild cycle ends.
 * Searches must be unblocked on both success and failure.
 *
 * @param {boolean} success
 * @returns {{ indexingInProgress: false, sessionIndexComplete: true, ownsIndexLock: false, isFirstEverRun?: false }}
 */
export function cycleEndFlags(success) {
  const flags = {
    indexingInProgress: false,
    sessionIndexComplete: true,
    ownsIndexLock: false
  };
  if (success) {
    flags.isFirstEverRun = false;
  }
  return flags;
}

/**
 * User-facing message when a source table is missing.
 * Distinct from still-indexing: retry because the index is not there yet,
 * not because this process is mid-cycle.
 *
 * @param {"emails"|"messages"|"calendar"|undefined} type
 * @returns {string}
 */
export function indexUnavailableMessage(type) {
  if (type === "messages") {
    return "Messages index not available. Please try again shortly.";
  }
  if (type === "calendar") {
    return "Calendar index not available. Please try again shortly.";
  }
  if (type === "emails") {
    return "Email index not available. Please try again shortly.";
  }
  return "Index not available. Please try again shortly.";
}

export const BUILDING_INITIAL_INDEX_MESSAGE =
  "Building initial index. This may take several minutes on first run. Please try again shortly.";

export const INDEXING_NEW_DATA_MESSAGE =
  "Indexing new data. Please try again in a moment.";

/**
 * Still-indexing copy. Only for a process that owns the lock and has not
 * finished a local cycle — never for a lost-lock MCP reader.
 *
 * @param {boolean} isFirstEverRun
 * @returns {string}
 */
export function indexingInProgressMessage(isFirstEverRun) {
  return isFirstEverRun ? BUILDING_INITIAL_INDEX_MESSAGE : INDEXING_NEW_DATA_MESSAGE;
}

/**
 * Preflight for index-backed MCP query tools.
 * Readiness is `indexReady` (usable on-disk tables), not sessionIndexComplete.
 * Lost-lock never returns "building initial index" / still-indexing.
 *
 * @param {{
 *   sessionIndexComplete: boolean,
 *   ownsIndexLock: boolean,
 *   indexReady: boolean,
 *   type?: "emails"|"messages"|"calendar",
 *   isFirstEverRun?: boolean
 * }} args
 * @returns {{ ok: boolean, message: string|null }}
 */
export function indexQueryGate({
  sessionIndexComplete,
  ownsIndexLock,
  indexReady,
  type,
  isFirstEverRun = false
}) {
  if (isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)) {
    return { ok: false, message: indexingInProgressMessage(isFirstEverRun) };
  }
  if (!indexReady) {
    return { ok: false, message: indexUnavailableMessage(type) };
  }
  return { ok: true, message: null };
}

/** A shared index older than this many refresh intervals gets a note. */
export const STALE_INDEX_INTERVALS = 3;
/** Never call the index stale sooner than this, whatever the interval. */
export const STALE_INDEX_FLOOR_MS = 15 * 60 * 1000;

function describeAge(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  return `${Math.floor(hours / 24)} days`;
}

/**
 * Why the index is stale, from who holds indexer.lock (readIndexerLockHolder).
 * A live holder that keeps checking in is still working: a rebuild, a long
 * first pass, or catching up after the Mac slept.
 *
 * @param {{ state: string, pid: number, checkedInMsAgo: number } | null | undefined} holder
 * @returns {string}
 */
function staleCause(holder) {
  if (holder?.state === "running") {
    return `The indexer (PID ${holder.pid}) is running, so a refresh is likely still in progress: ` +
      `a rebuild, a long first pass, or catching up after the Mac slept.`;
  }
  if (holder?.state === "stuck") {
    return `The indexer (PID ${holder.pid}) holds the index lock but last checked in ` +
      `${describeAge(holder.checkedInMsAgo)} ago, so it may be stuck.`;
  }
  return `The indexer daemon (apple-tools-indexer) may be down.`;
}

/**
 * @param {number|null|undefined} lastSkippedPassTime
 * @returns {string|null}
 */
function neverRefreshedNote(lastSkippedPassTime) {
  if (!Number.isFinite(lastSkippedPassTime) || lastSkippedPassTime <= 0) return null;
  return `Note: the search index has never finished a refresh. The last index pass ` +
    `(${new Date(lastSkippedPassTime).toISOString()}) could not read Mail, Messages or Calendar, ` +
    `so results may be missing. Check that the indexer has Full Disk Access.`;
}

/**
 * Note for an index-backed reply when the shared index has not finished a pass
 * in a while. The HTTP server never indexes (3.4.1), so with the indexer daemon
 * down it would otherwise serve a stale index silently.
 *
 * With no finished pass on record, it stays silent through normal warm-up
 * and speaks only once a regular pass has finished with every source read
 * skipped (lastSkippedPassTime): the index has then never refreshed.
 *
 * @param {{
 *   lastPassTime: number|null|undefined,
 *   lastSkippedPassTime?: number|null,
 *   now?: number,
 *   intervalMs: number,
 *   readHolder?: () => ({ state: string, pid: number, checkedInMsAgo: number } | null)
 * }} args readHolder runs only once the index is stale; a throw words the note as "may be down"
 * @returns {string|null} null when fresh, or when no pass of any kind has finished yet
 */
export function staleIndexNote({ lastPassTime, lastSkippedPassTime, now = Date.now(), intervalMs, readHolder }) {
  if (!Number.isFinite(lastPassTime) || lastPassTime <= 0) {
    return neverRefreshedNote(lastSkippedPassTime);
  }
  const limit = Math.max(STALE_INDEX_INTERVALS * (Number(intervalMs) || 0), STALE_INDEX_FLOOR_MS);
  const age = now - lastPassTime;
  if (age <= limit) return null;
  let holder = null;
  if (typeof readHolder === "function") {
    try {
      holder = readHolder();
    } catch {
      holder = null;
    }
  }
  return `Note: the search index last finished a refresh ${describeAge(age)} ago ` +
    `(${new Date(lastPassTime).toISOString()}), so mail, messages and events since then may be missing. ` +
    staleCause(holder);
}
