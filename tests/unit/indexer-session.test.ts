import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHashEmbedder } from "../../src/embed.js";
import { runIndexerDaemon } from "../../src/indexer/daemon.js";
import { BUILDING_INITIAL_INDEX_MESSAGE } from "../../src/indexGate.js";
import { createIndexerLock } from "../../src/lock.js";
import { runPlaudSearch, type QuerySession } from "../../src/mcp/tools.js";
import { FileVectorStore } from "../../src/store/fileStore.js";
import type { VectorStore } from "../../src/store/types.js";

function wrapStore(store: VectorStore, beforeUpsert: () => Promise<void>): VectorStore {
  return {
    get indexDir() {
      return store.indexDir;
    },
    isReady: () => store.isReady(),
    getMetadata: () => store.getMetadata(),
    updateMetadata: (partial) => store.updateMetadata(partial),
    upsertChunks: async (chunks) => {
      await beforeUpsert();
      return store.upsertChunks(chunks);
    },
    deleteFile: (fileId) => store.deleteFile(fileId),
    replaceAll: (chunks, meta) => store.replaceAll(chunks, meta),
    search: (vector, options) => store.search(vector, options),
    getFile: (fileId) => store.getFile(fileId),
    listFingerprints: () => store.listFingerprints(),
    close: () => store.close()
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for indexer session flag");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("runIndexerDaemon querySession", () => {
  it("does not mark the MCP session complete when daemon start resolves", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "plaud-daemon-session-"));
    const store = new FileVectorStore(path.join(home, "vector-index"));
    let releaseUpsert: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });
    const wrapped = wrapStore(store, () => held);

    const lock = createIndexerLock({
      lockFile: path.join(home, "indexer.lock"),
      log: () => {}
    });
    expect(lock.acquire()).toBe(true);

    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: true,
      isFirstEverRun: true
    };

    const state = await runIndexerDaemon({
      env: {
        PLAUD_INDEX_HOME: home,
        PLAUD_CLIENT: "mock",
        PLAUD_EMBEDDER: "mock",
        INDEX_INTERVAL_MS: "3600000"
      },
      indexerMode: false,
      store: wrapped,
      lock,
      querySession: session
    });

    try {
      expect(state.sessionIndexComplete).toBe(false);
      expect(session.sessionIndexComplete).toBe(false);
      expect(session.ownsIndexLock).toBe(true);

      const text = await runPlaudSearch(store, createHashEmbedder(), session, {
        query: "indexer file ids"
      });
      expect(text).toBe(BUILDING_INITIAL_INDEX_MESSAGE);
      expect(text).not.toMatch(/index not available/i);

      releaseUpsert();
      await waitUntil(() => session.sessionIndexComplete);
      expect(state.sessionIndexComplete).toBe(true);
    } finally {
      state.stop();
      lock.stopHeartbeat();
      lock.release();
    }
  });
});
