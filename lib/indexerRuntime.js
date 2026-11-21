
export function shouldConnectMcpStdio(indexerMode) {
  return !indexerMode;
}

export function shouldExitOnStdinClose(indexerMode) {
  return !indexerMode;
}

export function bindStdinCloseExit(stdin, indexerMode, onClose) {
  if (!shouldExitOnStdinClose(indexerMode)) {
    return { bound: false };
  }
  stdin.on("close", onClose);
  return { bound: true };
}

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

export function beginIndexCycle(indexingInProgress, log = (msg) => console.error(msg)) {
  if (indexingInProgress) {
    log("Indexing already in progress, skipping cycle");
    return { started: false, indexingInProgress: true };
  }
  return { started: true, indexingInProgress: true };
}

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

export function mcpIndexingStartup(acquireLock, { httpMode = false } = {}) {
  if (httpMode) {
    return { startBackground: false, ownsIndexLock: false, startHeartbeat: false, reason: "http-server" };
  }
  if (!acquireLock()) {
    return { startBackground: false, ownsIndexLock: false, startHeartbeat: false, reason: "lock-held" };
  }
  return { startBackground: true, ownsIndexLock: true, startHeartbeat: true, reason: "local-fallback" };
}

export function beginOwnedIndexing(steps) {
  steps.startHeartbeat();
  steps.startBackground();
}

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
