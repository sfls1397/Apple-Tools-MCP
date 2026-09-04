/**
 * Index-session search gating.
 *
 * sessionIndexComplete means "this process finished (or abandoned) its own
 * index cycle." A second MCP instance that lost the indexer lock never runs
 * a cycle, so that flag stays false. Lost-lock must not be treated as
 * "still indexing" — callers still check isIndexReady() for a missing index.
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
