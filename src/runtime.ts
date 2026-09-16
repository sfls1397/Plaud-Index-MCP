import { cycleEndFlags } from "./indexGate.js";

export function shouldConnectMcpStdio(indexerMode: boolean): boolean {
  return !indexerMode;
}

export function shouldExitOnStdinClose(indexerMode: boolean): boolean {
  return !indexerMode;
}

export function bindStdinCloseExit(
  stdin: { on: (event: string, handler: () => void) => void },
  indexerMode: boolean,
  onClose: () => void
): { bound: boolean } {
  if (!shouldExitOnStdinClose(indexerMode)) {
    return { bound: false };
  }
  stdin.on("close", onClose);
  return { bound: true };
}

export function beginIndexCycle(
  indexingInProgress: boolean,
  log: (msg: string) => void = (msg) => console.error(msg)
): { started: boolean; indexingInProgress: boolean } {
  if (indexingInProgress) {
    log("Indexing already in progress, skipping cycle");
    return { started: false, indexingInProgress: true };
  }
  return { started: true, indexingInProgress: true };
}

export function applyIndexerCycleEnd(args: {
  success: boolean;
  indexerMode: boolean;
  releaseLock: () => void;
}): {
  indexingInProgress: boolean;
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  isFirstEverRun?: boolean;
  released: boolean;
} {
  const flags = cycleEndFlags(args.success);
  if (args.indexerMode) {
    return {
      indexingInProgress: flags.indexingInProgress,
      sessionIndexComplete: flags.sessionIndexComplete,
      ownsIndexLock: true,
      isFirstEverRun: flags.isFirstEverRun,
      released: false
    };
  }
  args.releaseLock();
  return {
    indexingInProgress: flags.indexingInProgress,
    sessionIndexComplete: flags.sessionIndexComplete,
    ownsIndexLock: flags.ownsIndexLock,
    isFirstEverRun: flags.isFirstEverRun,
    released: true
  };
}

export function mcpIndexingStartup(acquireLock: () => boolean): {
  startBackground: boolean;
  ownsIndexLock: boolean;
  startHeartbeat: boolean;
  reason: "local-fallback" | "lock-held";
} {
  if (!acquireLock()) {
    return {
      startBackground: false,
      ownsIndexLock: false,
      startHeartbeat: false,
      reason: "lock-held"
    };
  }
  return {
    startBackground: true,
    ownsIndexLock: true,
    startHeartbeat: true,
    reason: "local-fallback"
  };
}

export function beginOwnedIndexing(steps: {
  startHeartbeat: () => void;
  startBackground: () => void;
}): void {
  steps.startHeartbeat();
  steps.startBackground();
}

export function waitForIndexerLock(
  acquireLock: () => boolean,
  options: {
    retryMs: number;
    onAcquired: () => void;
    log?: (msg: string) => void;
    setTimeoutFn?: typeof setTimeout;
  }
): void {
  const log = options.log || ((msg) => console.error(msg));
  const setTimeoutFn = options.setTimeoutFn || setTimeout;

  const tryAcquire = () => {
    if (acquireLock()) {
      log("Indexer daemon acquired indexer.lock");
      options.onAcquired();
      return;
    }
    log("Indexer daemon waiting for indexer.lock...");
    setTimeoutFn(tryAcquire, options.retryMs);
  };
  tryAcquire();
}
