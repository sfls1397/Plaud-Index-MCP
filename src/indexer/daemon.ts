import { loadResolvedIndexInterval, logResolvedInterval } from "../config.js";
import { createEmbedder } from "../embed.js";
import { createIndexerLock, DEFAULT_LOCK_HEARTBEAT_MS } from "../lock.js";
import { getLockFilePath, getVectorIndexDir } from "../paths.js";
import { createPlaudClient } from "../plaud/client.js";
import { refreshIndex } from "../refresh.js";
import { describeAuthFailure } from "../auth/login.js";
import { AuthExpiredError, isAuthExpiredError } from "../auth/errors.js";
import { RELLOGIN_MESSAGE } from "../auth/constants.js";
import {
  applyIndexerCycleEnd,
  beginIndexCycle,
  beginOwnedIndexing,
  waitForIndexerLock
} from "../runtime.js";
import { openVectorStore } from "../store/openStore.js";
import type { VectorStore } from "../store/types.js";

export interface QuerySessionFlags {
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  isFirstEverRun: boolean;
}

export interface IndexerState {
  indexingInProgress: boolean;
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  isFirstEverRun: boolean;
  stop(): void;
}

export async function runOneRefresh(options: {
  env?: NodeJS.ProcessEnv;
  store?: VectorStore;
  log?: (msg: string) => void;
}): Promise<void> {
  const env = options.env || process.env;
  const log = options.log || ((msg) => console.error(msg));
  let client;
  try {
    client = await createPlaudClient({ env, log });
  } catch (err) {
    if (isAuthExpiredError(err) || err instanceof AuthExpiredError) {
      log(RELLOGIN_MESSAGE);
      return;
    }
    log(describeAuthFailure(err));
    return;
  }
  const store =
    options.store ||
    (await openVectorStore({
      indexDir: getVectorIndexDir({ env }),
      env
    }));
  const embedder = await createEmbedder({ env });
  const result = await refreshIndex({ client, store, embedder, log });
  log(
    `Index cycle complete: examined=${result.examined} upserted=${result.upserted} skipped=${result.skipped} deleted=${result.deleted} model=${result.modelId}`
  );
}

export async function runIndexerDaemon(options: {
  env?: NodeJS.ProcessEnv;
  indexerMode?: boolean;
  store?: VectorStore;
  lock?: ReturnType<typeof createIndexerLock>;
  querySession?: QuerySessionFlags;
} = {}): Promise<IndexerState> {
  const env = options.env || process.env;
  const indexerMode = options.indexerMode !== false;
  const resolved = loadResolvedIndexInterval({ env });
  logResolvedInterval(resolved);

  const lock =
    options.lock ||
    createIndexerLock({
      lockFile: getLockFilePath({ env }),
      log: (msg) => console.error(msg)
    });

  let store: VectorStore | null = options.store || null;
  let indexTimer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (indexTimer) {
      clearInterval(indexTimer);
      indexTimer = null;
    }
  }

  const state: IndexerState = {
    indexingInProgress: false,
    sessionIndexComplete: false,
    ownsIndexLock: lock.ownsLock,
    isFirstEverRun: true,
    stop
  };

  function syncQuerySession(): void {
    const session = options.querySession;
    if (!session) {
      return;
    }
    session.sessionIndexComplete = state.sessionIndexComplete;
    session.ownsIndexLock = state.ownsIndexLock;
    session.isFirstEverRun = state.isFirstEverRun;
  }

  function acquireLock(): boolean {
    const ok = lock.acquire();
    state.ownsIndexLock = lock.ownsLock;
    return ok;
  }

  function releaseLock(): void {
    lock.release();
    state.ownsIndexLock = lock.ownsLock;
    if (!state.ownsIndexLock) {
      lock.stopHeartbeat();
    }
  }

  async function ensureStore(): Promise<VectorStore> {
    if (!store) {
      store = await openVectorStore({
        indexDir: getVectorIndexDir({ env }),
        env
      });
    }
    return store;
  }

  async function runCycle(): Promise<void> {
    const cycle = beginIndexCycle(state.indexingInProgress);
    if (!cycle.started) {
      return;
    }
    state.indexingInProgress = true;
    if (!lock.ownsLock && !acquireLock()) {
      state.indexingInProgress = false;
      console.error("Another instance is indexing. Skipping.");
      return;
    }

    try {
      const vectorStore = await ensureStore();
      state.isFirstEverRun = !(await vectorStore.isReady());
      state.ownsIndexLock = lock.ownsLock;
      syncQuerySession();
      await runOneRefresh({ env, store: vectorStore });
      applyEnd(true);
    } catch (err) {
      if (isAuthExpiredError(err) || err instanceof AuthExpiredError) {
        console.error(RELLOGIN_MESSAGE);
      } else {
        console.error(`Indexing error: ${describeAuthFailure(err)}`);
      }
      applyEnd(false);
    }
  }

  function applyEnd(success: boolean): void {
    const next = applyIndexerCycleEnd({
      success,
      indexerMode,
      releaseLock
    });
    state.indexingInProgress = next.indexingInProgress;
    state.sessionIndexComplete = next.sessionIndexComplete;
    state.ownsIndexLock = next.ownsIndexLock;
    if (next.isFirstEverRun === false) {
      state.isFirstEverRun = false;
    }
    syncQuerySession();
  }

  function startBackground(): void {
    void runCycle();
    indexTimer = setInterval(() => {
      void runCycle();
    }, resolved.ms);
    console.error(`Background indexing started (interval: ${resolved.human} / ${resolved.ms} ms)`);
  }

  process.on("exit", () => {
    stop();
    lock.stopHeartbeat();
    if (indexerMode) {
      releaseLock();
    }
  });

  if (indexerMode) {
    waitForIndexerLock(acquireLock, {
      retryMs: 5000,
      onAcquired: () => {
        beginOwnedIndexing({
          startHeartbeat: () => lock.startHeartbeat(DEFAULT_LOCK_HEARTBEAT_MS),
          startBackground
        });
      }
    });
  } else {
    startBackground();
  }

  return state;
}
