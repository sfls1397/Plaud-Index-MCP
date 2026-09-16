import { loadResolvedIndexInterval, logResolvedInterval } from "../config.js";
import { createEmbedder } from "../embed.js";
import { createIndexerLock, DEFAULT_LOCK_HEARTBEAT_MS } from "../lock.js";
import { getLockFilePath, getVectorIndexDir } from "../paths.js";
import { createPlaudClient, readPlaudToken } from "../plaud/client.js";
import { refreshIndex } from "../refresh.js";
import {
  applyIndexerCycleEnd,
  beginIndexCycle,
  beginOwnedIndexing,
  waitForIndexerLock
} from "../runtime.js";
import { openVectorStore } from "../store/openStore.js";
import type { VectorStore } from "../store/types.js";

export interface IndexerState {
  indexingInProgress: boolean;
  sessionIndexComplete: boolean;
  ownsIndexLock: boolean;
  isFirstEverRun: boolean;
}

export async function runOneRefresh(options: {
  env?: NodeJS.ProcessEnv;
  store?: VectorStore;
  log?: (msg: string) => void;
}): Promise<void> {
  const env = options.env || process.env;
  const log = options.log || ((msg) => console.error(msg));
  const token = readPlaudToken(env);
  if (!token && env.PLAUD_CLIENT !== "mock" && env.PLAUD_USE_MOCK !== "1") {
    log(
      "PLAUD_API_TOKEN is not set. Put the Plaud API token in Keychain or env on the Mini. Do not use Grok OAuth. Skipping cycle."
    );
    return;
  }
  const store =
    options.store ||
    (await openVectorStore({
      indexDir: getVectorIndexDir({ env }),
      env
    }));
  const embedder = await createEmbedder({ env });
  const client = createPlaudClient({ env });
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

  const state: IndexerState = {
    indexingInProgress: false,
    sessionIndexComplete: false,
    ownsIndexLock: lock.ownsLock,
    isFirstEverRun: true
  };

  let store: VectorStore | null = options.store || null;
  let indexTimer: ReturnType<typeof setInterval> | null = null;

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
      await runOneRefresh({ env, store: vectorStore });
      applyEnd(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Indexing error: ${message}`);
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
  }

  function startBackground(): void {
    void runCycle();
    indexTimer = setInterval(() => {
      void runCycle();
    }, resolved.ms);
    console.error(`Background indexing started (interval: ${resolved.human} / ${resolved.ms} ms)`);
  }

  process.on("exit", () => {
    if (indexTimer) clearInterval(indexTimer);
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
