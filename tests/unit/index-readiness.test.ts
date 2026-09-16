import { describe, expect, it } from "vitest";
import {
  BUILDING_INITIAL_INDEX_MESSAGE,
  INDEXING_NEW_DATA_MESSAGE,
  INDEX_UNAVAILABLE_MESSAGE,
  indexQueryGate,
  isSearchBlockedByIndexing
} from "../../src/indexGate.js";
import { beginIndexCycle, mcpIndexingStartup } from "../../src/runtime.js";
import { FileVectorStore } from "../../src/store/fileStore.js";
import { createHashEmbedder } from "../../src/embed.js";
import { formatSearchResults, runPlaudGet, runPlaudSearch, type QuerySession } from "../../src/mcp/tools.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function populatedStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-idx-"));
  const store = new FileVectorStore(dir);
  const embedder = createHashEmbedder();
  const [vector] = await embedder.embed(["standup indexer file ids"]);
  await store.upsertChunks([
    {
      id: "file-standup-001:0",
      fileId: "file-standup-001",
      title: "Tuesday standup",
      createdAt: "2026-09-15T15:00:00.000Z",
      durationMs: 1000,
      fingerprint: "abc",
      chunkIndex: 0,
      kind: "transcript",
      text: "Ship the Plaud indexer. Search returns file ids.",
      vector
    }
  ]);
  await store.updateMetadata({
    embedModel: embedder.modelId,
    embedDim: embedder.dim,
    populated: true,
    noteCount: 1,
    chunkCount: 1
  });
  return { store, embedder };
}

describe("AC: query while indexer holds the lock", () => {
  it("succeeds when the indexer holds the lock and the on-disk index is populated", async () => {
    const startup = mcpIndexingStartup(() => false);
    expect(startup.reason).toBe("lock-held");
    expect(startup.ownsIndexLock).toBe(false);

    const { store, embedder } = await populatedStore();
    expect(await store.isReady()).toBe(true);

    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: startup.ownsIndexLock,
      isFirstEverRun: true
    };

    const gate = indexQueryGate({
      sessionIndexComplete: session.sessionIndexComplete,
      ownsIndexLock: session.ownsIndexLock,
      indexReady: true,
      isFirstEverRun: true
    });
    expect(gate.ok).toBe(true);
    expect(String(gate.message || "")).not.toMatch(/index not available/i);
    expect(gate.message).not.toBe(BUILDING_INITIAL_INDEX_MESSAGE);

    const text = await runPlaudSearch(store, embedder, session, { query: "indexer file ids" });
    expect(text).not.toMatch(/index not available/i);
    expect(text).not.toMatch(/Building initial Plaud index/i);
    const parsed = JSON.parse(text) as { results: Array<{ file_id: string; snippet: string }> };
    expect(parsed.results[0].file_id).toBe("file-standup-001");
  });

  it("does not treat lost-lock as still-indexing", () => {
    expect(isSearchBlockedByIndexing(false, false)).toBe(false);
  });

  it("refuses a missing/empty index instead of inventing results", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-empty-"));
    const store = new FileVectorStore(dir);
    expect(await store.isReady()).toBe(false);
    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: false,
      isFirstEverRun: true
    };
    const text = await runPlaudSearch(store, createHashEmbedder(), session, { query: "anything" });
    expect(text).toBe(INDEX_UNAVAILABLE_MESSAGE);
    expect(text).not.toMatch(/"results"/);
  });

  it("local-fallback still starts when no daemon holds the lock", () => {
    const fallback = mcpIndexingStartup(() => true);
    expect(fallback.reason).toBe("local-fallback");
    expect(fallback.startBackground).toBe(true);
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: true,
      indexReady: false,
      isFirstEverRun: true
    });
    expect(gate.message).toBe(BUILDING_INITIAL_INDEX_MESSAGE);
  });

  it("fallback mid first cycle refuses with Building, not index not available", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-building-"));
    const store = new FileVectorStore(dir);
    expect(await store.isReady()).toBe(false);
    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: true,
      isFirstEverRun: true
    };
    const text = await runPlaudSearch(store, createHashEmbedder(), session, { query: "anything" });
    expect(text).toBe(BUILDING_INITIAL_INDEX_MESSAGE);
    expect(text).not.toMatch(/index not available/i);
  });

  it("empty index + owns lock + complete-too-early looks like unavailable (QA mid-cycle bug)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-complete-early-"));
    const store = new FileVectorStore(dir);
    const session: QuerySession = {
      sessionIndexComplete: true,
      ownsIndexLock: true,
      isFirstEverRun: true
    };
    const text = await runPlaudSearch(store, createHashEmbedder(), session, { query: "anything" });
    expect(text).toBe(INDEX_UNAVAILABLE_MESSAGE);
  });

  it("overlapping cycles skip", () => {
    const nested = beginIndexCycle(true, () => {});
    expect(nested).toEqual({ started: false, indexingInProgress: true });
  });
});

describe("id-first search results", () => {
  it("returns Plaud file ids with title/snippet, not a full transcript dump", () => {
    const long =
      "Alice: Let's ship the Plaud indexer this week. ".repeat(40) +
      "Bob: Search should return Plaud file ids so Grok can fetch transcripts from Plaud MCP.";
    const json = formatSearchResults([
      {
        fileId: "file-standup-001",
        title: "Tuesday standup",
        createdAt: "2026-09-15T15:00:00.000Z",
        durationMs: 1000,
        score: 0.91,
        snippet: long.slice(0, 200)
      }
    ]);
    const parsed = JSON.parse(json) as {
      results: Array<{ file_id: string; snippet: string; fetch: string; title: string }>;
    };
    expect(parsed.results[0].file_id).toBe("file-standup-001");
    expect(parsed.results[0].title).toBe("Tuesday standup");
    expect(parsed.results[0].snippet.length).toBeLessThan(400);
    expect(parsed.results[0].fetch).toMatch(/Plaud MCP/);
    expect(json).not.toContain(long);
  });

  it("plaud_get returns metadata and snippets, not a forced full transcript", async () => {
    const { store } = await populatedStore();
    const session: QuerySession = {
      sessionIndexComplete: true,
      ownsIndexLock: false,
      isFirstEverRun: false
    };
    const text = await runPlaudGet(store, session, { file_id: "file-standup-001" });
    const parsed = JSON.parse(text) as { file_id: string; snippets: string[]; fetch: string };
    expect(parsed.file_id).toBe("file-standup-001");
    expect(parsed.snippets.length).toBeGreaterThan(0);
    expect(parsed.fetch).toMatch(/get_transcript/);
  });
});

describe("indexQueryGate", () => {
  it("lost-lock + ready index is ok even if this process never indexed", () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: false,
      indexReady: true,
      isFirstEverRun: true
    });
    expect(gate.ok).toBe(true);
    expect(gate.message).not.toBe(INDEXING_NEW_DATA_MESSAGE);
  });

  it("populated on-disk index succeeds even if this process still owns the lock", () => {
    const gate = indexQueryGate({
      sessionIndexComplete: false,
      ownsIndexLock: true,
      indexReady: true,
      isFirstEverRun: true
    });
    expect(gate.ok).toBe(true);
    expect(String(gate.message || "")).not.toMatch(/index not available/i);
  });
});

describe("on-disk index freshness", () => {
  it("isReady becomes true after another writer populates the same directory", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-fresh-"));
    const reader = new FileVectorStore(dir);
    expect(await reader.isReady()).toBe(false);

    const writer = new FileVectorStore(dir);
    const embedder = createHashEmbedder();
    const [vector] = await embedder.embed(["populated later"]);
    await writer.upsertChunks([
      {
        id: "file-later-001:0",
        fileId: "file-later-001",
        title: "Later note",
        createdAt: "2026-09-15T15:00:00.000Z",
        durationMs: 1000,
        fingerprint: "later",
        chunkIndex: 0,
        kind: "title",
        text: "populated later",
        vector
      }
    ]);

    expect(await reader.isReady()).toBe(true);
    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: false,
      isFirstEverRun: true
    };
    const text = await runPlaudSearch(reader, embedder, session, { query: "populated later" });
    expect(text).not.toMatch(/index not available/i);
    expect(JSON.parse(text).results[0].file_id).toBe("file-later-001");
  });

  it("plaud_search honors optional date_from / date_to", async () => {
    const { store, embedder } = await populatedStore();
    const session: QuerySession = {
      sessionIndexComplete: false,
      ownsIndexLock: false,
      isFirstEverRun: false
    };
    const hit = await runPlaudSearch(store, embedder, session, {
      query: "indexer",
      date_from: "2026-09-15",
      date_to: "2026-09-15"
    });
    expect(JSON.parse(hit).results[0].file_id).toBe("file-standup-001");

    const miss = await runPlaudSearch(store, embedder, session, {
      query: "indexer",
      date_from: "2020-01-01",
      date_to: "2020-01-02"
    });
    expect(JSON.parse(miss).results).toEqual([]);
  });
});
