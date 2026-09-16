/**
 * Index-session search gating.
 *
 * Readiness is a populated on-disk index. Query tools succeed whenever that
 * index exists — including when the indexer daemon holds the lock and this
 * MCP process never ran its own first cycle. Do not fail with
 * "index not available" in that case.
 */

export const INDEX_UNAVAILABLE_MESSAGE =
  "Plaud index not available. Start the indexer (`plaud-index-indexer` or `--mode=indexer`) and retry. Do not invent results.";

export const BUILDING_INITIAL_INDEX_MESSAGE =
  "Building initial Plaud index. This may take a few minutes on first run. Please try again shortly.";

export const INDEXING_NEW_DATA_MESSAGE = "Indexing new Plaud data. Please try again in a moment.";

export function isSearchBlockedByIndexing(
  sessionIndexComplete: boolean,
  ownsIndexLock: boolean
): boolean {
  return Boolean(ownsIndexLock) && !sessionIndexComplete;
}

export function cycleEndFlags(success: boolean): {
  indexingInProgress: false;
  sessionIndexComplete: true;
  ownsIndexLock: false;
  isFirstEverRun?: false;
} {
  const flags: {
    indexingInProgress: false;
    sessionIndexComplete: true;
    ownsIndexLock: false;
    isFirstEverRun?: false;
  } = {
    indexingInProgress: false,
    sessionIndexComplete: true,
    ownsIndexLock: false
  };
  if (success) {
    flags.isFirstEverRun = false;
  }
  return flags;
}

export function indexingInProgressMessage(isFirstEverRun: boolean): string {
  return isFirstEverRun ? BUILDING_INITIAL_INDEX_MESSAGE : INDEXING_NEW_DATA_MESSAGE;
}

export function indexQueryGate(args: {
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  indexReady: boolean;
  isFirstEverRun?: boolean;
}): { ok: boolean; message: string | null } {
  const { sessionIndexComplete, ownsIndexLock, indexReady, isFirstEverRun = false } = args;
  // On-disk populated index always wins. Query MCP must succeed while the
  // indexer holds the lock — readiness is not "this process finished a cycle."
  if (indexReady) {
    return { ok: true, message: null };
  }
  if (isSearchBlockedByIndexing(sessionIndexComplete, ownsIndexLock)) {
    return { ok: false, message: indexingInProgressMessage(isFirstEverRun) };
  }
  return { ok: false, message: INDEX_UNAVAILABLE_MESSAGE };
}
