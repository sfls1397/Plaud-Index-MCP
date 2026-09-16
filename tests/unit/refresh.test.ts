import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHashEmbedder } from "../../src/embed.js";
import { MockPlaudClient } from "../../src/plaud/mockClient.js";
import { refreshIndex } from "../../src/refresh.js";
import { FileVectorStore } from "../../src/store/fileStore.js";
import { TOOL_DEFINITIONS } from "../../src/mcp/tools.js";

describe("refreshIndex", () => {
  it("indexes mock Plaud files and records the embed model id", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-refresh-"));
    const store = new FileVectorStore(dir);
    const embedder = createHashEmbedder("Xenova/all-MiniLM-L6-v2");
    const client = new MockPlaudClient();
    const result = await refreshIndex({ client, store, embedder, log: () => {} });
    expect(result.upserted).toBeGreaterThan(0);
    expect(result.modelId).toBe("Xenova/all-MiniLM-L6-v2");
    expect(await store.isReady()).toBe(true);
    const meta = await store.getMetadata();
    expect(meta.embedModel).toBe("Xenova/all-MiniLM-L6-v2");
    const hit = await store.getFile("file-standup-001");
    expect(hit?.title).toBe("Tuesday standup");
  });

  it("full re-indexes when the embed model id changes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-reindex-"));
    const store = new FileVectorStore(dir);
    const client = new MockPlaudClient();
    await refreshIndex({
      client,
      store,
      embedder: createHashEmbedder("Xenova/all-MiniLM-L6-v2"),
      log: () => {}
    });
    const next = await refreshIndex({
      client,
      store,
      embedder: createHashEmbedder("Xenova/all-MiniLM-L6-v3"),
      log: () => {}
    });
    expect(next.fullReindex).toBe(true);
    expect(next.upserted).toBeGreaterThan(0);
    const meta = await store.getMetadata();
    expect(meta.embedModel).toBe("Xenova/all-MiniLM-L6-v3");
  });

  it("skips unchanged fingerprints on incremental refresh", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-incr-"));
    const store = new FileVectorStore(dir);
    const embedder = createHashEmbedder("Xenova/all-MiniLM-L6-v2");
    const client = new MockPlaudClient();
    await refreshIndex({ client, store, embedder, log: () => {} });
    const second = await refreshIndex({ client, store, embedder, log: () => {} });
    expect(second.fullReindex).toBe(false);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.upserted).toBe(0);
  });
});

describe("tools are read-only", () => {
  it("exposes only plaud_search and plaud_get", () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(["plaud_get", "plaud_search"]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.toLowerCase()).not.toMatch(/delete|overwrite|write to plaud/);
    }
  });
});
