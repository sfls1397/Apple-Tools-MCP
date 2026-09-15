/**
 * Indexer daemon vs MCP stdio runtime helpers.
 * Kept separate from index.js so daemon paths can be tested without
 * starting MCP stdio or loading the embedding model.
 */

/**
 * @param {boolean} indexerMode
 * @returns {boolean}
 */
export function shouldConnectMcpStdio(indexerMode) {
  return !indexerMode;
}

/**
 * @param {boolean} indexerMode
 * @returns {boolean}
 */
export function shouldExitOnStdinClose(indexerMode) {
  return !indexerMode;
}

/**
 * Bind stdin `close` → callback only for MCP stdio clients.
 * Indexer daemons must ignore stdin close (LaunchAgent often uses /dev/null).
 *
 * @param {{ on: (event: string, handler: () => void) => void }} stdin
 * @param {boolean} indexerMode
 * @param {() => void} onClose
 * @returns {{ bound: boolean }}
 */
export function bindStdinCloseExit(stdin, indexerMode, onClose) {
  if (!shouldExitOnStdinClose(indexerMode)) {
    return { bound: false };
  }
  stdin.on("close", onClose);
  return { bound: true };
}

/**
 * Start one index cycle, or skip if a cycle is already running.
 *
 * @param {boolean} indexingInProgress
 * @param {(msg: string) => void} [log]
 * @returns {{ started: boolean, indexingInProgress: boolean }}
 */
export function beginIndexCycle(indexingInProgress, log = (msg) => console.error(msg)) {
  if (indexingInProgress) {
    log("Indexing already in progress, skipping cycle");
    return { started: false, indexingInProgress: true };
  }
  return { started: true, indexingInProgress: true };
}

/**
 * After a cycle: daemon keeps the lock; MCP local-fallback releases it.
 *
 * @param {{
 *   success: boolean,
 *   indexerMode: boolean,
 *   cycleEndFlags: (success: boolean) => {
 *     indexingInProgress: boolean,
 *     sessionIndexComplete: boolean,
 *     ownsIndexLock: boolean,
 *     isFirstEverRun?: boolean
 *   },
 *   releaseLock: () => void
 * }} args
 */
export function applyIndexerCycleEnd({ success, indexerMode, cycleEndFlags, releaseLock }) {
  const flags = cycleEndFlags(success);
  if (indexerMode) {
    return {
      indexingInProgress: flags.indexingInProgress,
      sessionIndexComplete: flags.sessionIndexComplete,
      ownsIndexLock: true,
      isFirstEverRun: flags.isFirstEverRun,
      released: false
    };
  }
  releaseLock();
  return {
    indexingInProgress: flags.indexingInProgress,
    sessionIndexComplete: flags.sessionIndexComplete,
    ownsIndexLock: flags.ownsIndexLock,
    isFirstEverRun: flags.isFirstEverRun,
    released: true
  };
}

/**
 * MCP stdio startup: index locally only when the lock is free.
 *
 * @param {() => boolean} acquireLock
 * @returns {{ startBackground: boolean, ownsIndexLock: boolean, reason: "local-fallback" | "lock-held" }}
 */
export function mcpIndexingStartup(acquireLock) {
  if (!acquireLock()) {
    return { startBackground: false, ownsIndexLock: false, reason: "lock-held" };
  }
  return { startBackground: true, ownsIndexLock: true, reason: "local-fallback" };
}

/**
 * Retry until the daemon owns indexer.lock, then run onAcquired.
 *
 * @param {() => boolean} acquireLock
 * @param {{
 *   retryMs: number,
 *   onAcquired: () => void,
 *   log?: (msg: string) => void,
 *   setTimeoutFn?: typeof setTimeout
 * }} options
 */
export function waitForIndexerLock(acquireLock, options) {
  const retryMs = options.retryMs;
  const onAcquired = options.onAcquired;
  const log = options.log || ((msg) => console.error(msg));
  const setTimeoutFn = options.setTimeoutFn || setTimeout;

  const tryAcquire = () => {
    if (acquireLock()) {
      log("Indexer daemon acquired indexer.lock");
      onAcquired();
      return;
    }
    log("Indexer daemon waiting for indexer.lock...");
    setTimeoutFn(tryAcquire, retryMs);
  };
  tryAcquire();
}
