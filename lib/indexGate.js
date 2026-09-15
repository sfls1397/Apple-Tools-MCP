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
