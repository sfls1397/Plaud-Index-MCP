#!/usr/bin/env node

import { createIndexerLock, DEFAULT_LOCK_HEARTBEAT_MS } from "./lock.js";
import { packageVersion, startQueryMcp } from "./mcp/server.js";
import { isIndexerMode } from "./processMode.js";
import { getLockFilePath, getVectorIndexDir } from "./paths.js";
import { runIndexerDaemon } from "./indexer/daemon.js";
import { bindStdinCloseExit, beginOwnedIndexing, mcpIndexingStartup, shouldConnectMcpStdio } from "./runtime.js";
import { openVectorStore } from "./store/openStore.js";

const INDEXER_MODE = isIndexerMode();

async function main(): Promise<void> {
  const env = process.env;

  if (INDEXER_MODE) {
    console.error(`Plaud Index MCP indexer running (v${packageVersion()})`);
    await runIndexerDaemon({ env, indexerMode: true });
    return;
  }

  if (!shouldConnectMcpStdio(INDEXER_MODE)) {
    return;
  }

  const lock = createIndexerLock({
    lockFile: getLockFilePath({ env }),
    log: (msg) => console.error(msg)
  });

  const session = {
    sessionIndexComplete: false,
    ownsIndexLock: false,
    isFirstEverRun: true
  };

  function acquireLock(): boolean {
    const ok = lock.acquire();
    session.ownsIndexLock = lock.ownsLock;
    return ok;
  }

  function releaseLock(): void {
    lock.release();
    session.ownsIndexLock = lock.ownsLock;
    if (!session.ownsIndexLock) {
      lock.stopHeartbeat();
    }
  }

  function shutdown(exitCode?: number): void {
    lock.stopHeartbeat();
    releaseLock();
    if (exitCode !== undefined) {
      process.exit(exitCode);
    }
  }

  process.on("exit", () => {
    lock.stopHeartbeat();
    releaseLock();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      shutdown();
      process.exit();
    });
  }

  bindStdinCloseExit(process.stdin, INDEXER_MODE, () => {
    console.error("Client disconnected. Exiting.");
    shutdown(0);
  });

  const store = await openVectorStore({
    indexDir: getVectorIndexDir({ env }),
    env
  });
  session.isFirstEverRun = !(await store.isReady());

  const startup = mcpIndexingStartup(() => acquireLock());
  if (!startup.startBackground) {
    console.error(
      "Another plaud-index-mcp instance is indexing. Query MCP will search the shared on-disk index."
    );
    session.ownsIndexLock = false;
  } else {
    session.ownsIndexLock = true;
    beginOwnedIndexing({
      startHeartbeat: () => lock.startHeartbeat(DEFAULT_LOCK_HEARTBEAT_MS),
      startBackground: () => {
        // Cycle completion is synced from the daemon's applyEnd — not when
        // start() resolves. startBackground returns immediately, before the
        // first index cycle finishes.
        void runIndexerDaemon({
          env,
          indexerMode: false,
          store,
          lock,
          querySession: session
        });
      }
    });
  }

  await startQueryMcp({ store, session, env });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
