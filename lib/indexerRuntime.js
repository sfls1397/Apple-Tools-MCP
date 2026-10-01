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
 * Track JSON-RPC requests the server has received but not yet answered.
 * A caller that pipes a batch and closes stdin (`printf ... | apple-tools-mcp`)
 * fires stdin `close` right after the last line is read, while tools/call is
 * still running; without this the close handler exits mid-call.
 * Call after server.connect(transport) — Protocol sets onmessage there.
 *
 * @param {{ onmessage?: (message: any, extra?: any) => void, send: (message: any, options?: any) => Promise<void> }} transport
 * @returns {{ readonly size: number, whenIdle: () => Promise<void> }}
 */
export function trackInFlightRequests(transport) {
  const pending = new Set();
  let idleWaiters = [];
  const settle = () => {
    if (pending.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message?.method === "notifications/cancelled") {
      // The SDK sends no response for a cancelled request.
      pending.delete(message.params?.requestId);
      settle();
    } else if (message?.method && message.id !== undefined) {
      pending.add(message.id);
    }
    onmessage?.(message, extra);
  };

  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    try {
      return await send(message, options);
    } finally {
      if (!message?.method && message?.id !== undefined && pending.delete(message.id)) {
        settle();
      }
    }
  };

  return {
    get size() {
      return pending.size;
    },
    whenIdle() {
      if (pending.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    }
  };
}

/**
 * On stdin close: let in-flight requests answer (up to timeoutMs), then exit.
 * Exiting synchronously drops the last tools/call. The SDK's send() resolves
 * only once stdout has drained, so an answered request is fully written.
 *
 * @param {{
 *   inFlight: { size: number, whenIdle: () => Promise<void> } | null,
 *   timeoutMs: number,
 *   exit: () => void,
 *   log?: (msg: string) => void
 * }} options
 * @returns {Promise<{ drained: boolean, pending: number }>}
 */
export async function drainInFlightThenExit(options) {
  const { inFlight, timeoutMs, exit } = options;
  const log = options.log || ((msg) => console.error(msg));

  const pending = inFlight ? inFlight.size : 0;
  let drained = true;
  if (pending > 0) {
    log(`Waiting for ${pending} in-flight request(s) before exit...`);
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    drained = !(await Promise.race([inFlight.whenIdle().then(() => false), timedOut]));
    clearTimeout(timer);
    if (!drained) {
      log(`Gave up on ${inFlight.size} in-flight request(s) after ${timeoutMs}ms.`);
    }
  }
  exit();
  return { drained, pending };
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
 * @returns {{ startBackground: boolean, ownsIndexLock: boolean, startHeartbeat: boolean, reason: "local-fallback" | "lock-held" }}
 */
export function mcpIndexingStartup(acquireLock) {
  if (!acquireLock()) {
    return { startBackground: false, ownsIndexLock: false, startHeartbeat: false, reason: "lock-held" };
  }
  return { startBackground: true, ownsIndexLock: true, startHeartbeat: true, reason: "local-fallback" };
}

/**
 * Shared path once this process owns indexer.lock: heartbeat + background cycles.
 * MCP local-fallback must use this too, not only the daemon.
 *
 * @param {{ startHeartbeat: () => void, startBackground: () => void }} steps
 */
export function beginOwnedIndexing(steps) {
  steps.startHeartbeat();
  steps.startBackground();
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
