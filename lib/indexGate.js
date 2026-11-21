
export function isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock) {
  return Boolean(ownsIndexLock) && !sessionIndexComplete;
}

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

export function indexingInProgressMessage(isFirstEverRun) {
  return isFirstEverRun ? BUILDING_INITIAL_INDEX_MESSAGE : INDEXING_NEW_DATA_MESSAGE;
}

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

export const STALE_INDEX_INTERVALS = 3;
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

function neverRefreshedNote(lastSkippedPassTime) {
  if (!Number.isFinite(lastSkippedPassTime) || lastSkippedPassTime <= 0) return null;
  return `Note: the search index has never finished a refresh. The last index pass ` +
    `(${new Date(lastSkippedPassTime).toISOString()}) could not read Mail, Messages or Calendar, ` +
    `so results may be missing. Check that the indexer has Full Disk Access.`;
}

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
