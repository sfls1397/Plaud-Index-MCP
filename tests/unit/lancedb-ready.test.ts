import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LanceVectorStore } from "../../src/store/lancedbStore.js";
import { NOTES_TABLE, scoreFromLanceDistance, type StoredChunk } from "../../src/store/types.js";

function parseFileIdPredicate(predicate: string): string | null {
  const match = /file_id\s*=\s*'((?:''|[^'])*)'/.exec(predicate);
  return match ? match[1].replace(/''/g, "'") : null;
}

function memoryLanceDb() {
  const tables = new Map<string, Record<string, unknown>[]>();

  function makeTable(name: string) {
    const query = () => {
      let predicate: string | undefined;
      let columns: string[] | undefined;
      const self = {
        where(p: string) {
          predicate = p;
          return self;
        },
        select(cols: string[]) {
          columns = cols;
          return self;
        },
        nearestTo(_vector: number[]) {
          return { limit: (n: number) => ({ toArray: async () => apply(n) }) };
        },
        limit(n: number) {
          return { toArray: async () => apply(n) };
        },
        toArray: async () => apply(undefined)
      };
      function apply(n?: number): Record<string, unknown>[] {
        let rows = [...(tables.get(name) || [])];
        if (predicate) {
          const id = parseFileIdPredicate(predicate);
          if (id) {
            rows = rows.filter((r) => String(r.file_id) === id);
          }
        }
        if (columns) {
          rows = rows.map((row) => {
            const slim: Record<string, unknown> = {};
            for (const col of columns!) {
              slim[col] = row[col];
            }
            return slim;
          });
        }
        if (n != null) {
          rows = rows.slice(0, n);
        }
        return rows;
      }
      return self;
    };
    return {
      add: async (data: Record<string, unknown>[]) => {
        const rows = tables.get(name) || [];
        rows.push(...data);
        tables.set(name, rows);
      },
      delete: async (predicate: string) => {
        const id = parseFileIdPredicate(predicate);
        const rows = (tables.get(name) || []).filter((r) => String(r.file_id) !== id);
        tables.set(name, rows);
      },
      query,
      vectorSearch: (vector: number[]) => ({
        limit: (n: number) => ({
          toArray: async () => {
            const rows = [...(tables.get(name) || [])];
            return rows.slice(0, n).map((row, i) => ({
              ...row,
              _distance: typeof row._distance === "number" ? row._distance : i === 0 ? 0 : 2
            }));
          }
        })
      })
    };
  }

  return {
    tableNames: async () => [...tables.keys()],
    openTable: async (name: string) => makeTable(name),
    createTable: async (name: string, data: Record<string, unknown>[]) => {
      tables.set(name, [...data]);
      return makeTable(name);
    },
    dropTable: async (name: string) => {
      tables.delete(name);
    }
  };
}

function mockConnection(getNames: () => string[], rows: Record<string, unknown>[] = [{ id: "row-1" }]) {
  return {
    tableNames: async () => getNames(),
    openTable: async () => ({
      add: async () => undefined,
      delete: async () => undefined,
      query: () => ({
        where: (predicate: string) => {
          const id = parseFileIdPredicate(predicate);
          const mine = rows.filter((r) => String(r.file_id) === id);
          return {
            limit: (n: number) => ({ toArray: async () => mine.slice(0, n) }),
            toArray: async () => mine
          };
        },
        limit: (n: number) => ({
          toArray: async () => (getNames().includes(NOTES_TABLE) ? rows.slice(0, n) : [])
        }),
        toArray: async () => (getNames().includes(NOTES_TABLE) ? rows : [])
      })
    }),
    createTable: async () => ({
      add: async () => undefined,
      delete: async () => undefined,
      query: () => ({
        limit: () => ({ toArray: async () => rows }),
        toArray: async () => rows
      })
    }),
    close() {}
  };
}

function chunk(fileId: string, index: number, extras: Partial<StoredChunk> = {}): StoredChunk {
  return {
    id: `${fileId}:${index}`,
    fileId,
    title: extras.title || fileId,
    createdAt: extras.createdAt ?? "2026-09-15T15:00:00.000Z",
    durationMs: extras.durationMs ?? 1000,
    fingerprint: extras.fingerprint || `fp-${fileId}`,
    chunkIndex: index,
    kind: extras.kind || "transcript",
    text: extras.text || `text ${fileId} ${index}`,
    vector: extras.vector || [1, 0, 0]
  };
}

describe("LanceVectorStore isReady (on-disk, not local cycle)", () => {
  it("does not cache an empty first catalog forever", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-lance-"));
    let names: string[] = [];
    const store = new LanceVectorStore(dir, async () => mockConnection(() => names));
    expect(await store.isReady()).toBe(false);
    names = [NOTES_TABLE];
    expect(await store.isReady()).toBe(true);
  });
});

describe("scoreFromLanceDistance", () => {
  it("maps L2 to cosine-like similarity and clamps to [0, 1]", () => {
    expect(scoreFromLanceDistance(0)).toBe(1);
    expect(scoreFromLanceDistance(Math.SQRT2)).toBeCloseTo(0, 10);
    expect(scoreFromLanceDistance(2)).toBe(0);
    expect(scoreFromLanceDistance(0.5)).toBeCloseTo(1 - 0.25 / 2, 10);
    expect(scoreFromLanceDistance(Number.NaN)).toBe(0);
  });
});

describe("LanceVectorStore metadata counts", () => {
  it("recounts noteCount and chunkCount after upsert and delete", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-lance-counts-"));
    const store = new LanceVectorStore(dir, async () => memoryLanceDb());

    await store.upsertChunks([chunk("file-a", 0), chunk("file-a", 1)]);
    let meta = await store.getMetadata();
    expect(meta.noteCount).toBe(1);
    expect(meta.chunkCount).toBe(2);

    await store.upsertChunks([chunk("file-b", 0)]);
    meta = await store.getMetadata();
    expect(meta.noteCount).toBe(2);
    expect(meta.chunkCount).toBe(3);

    await store.upsertChunks([chunk("file-a", 0)]);
    meta = await store.getMetadata();
    expect(meta.noteCount).toBe(2);
    expect(meta.chunkCount).toBe(2);

    await store.deleteFile("file-b");
    meta = await store.getMetadata();
    expect(meta.noteCount).toBe(1);
    expect(meta.chunkCount).toBe(1);
    expect(meta.populated).toBe(true);
  });
});

describe("LanceVectorStore search scores", () => {
  it("does not return negative scores for large L2 distances", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-lance-score-"));
    const db = memoryLanceDb();
    const store = new LanceVectorStore(dir, async () => db);
    await store.upsertChunks([
      { ...chunk("file-near", 0), vector: [1, 0, 0] },
      { ...chunk("file-far", 0), vector: [-1, 0, 0] }
    ]);
    const hits = await store.search([1, 0, 0], { limit: 8 });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0);
      expect(hit.score).toBeLessThanOrEqual(1);
    }
  });
});

describe("LanceVectorStore getFile where predicate", () => {
  it("finds a file beyond the first 5000 chunks via where, not a JS scan", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-lance-get-"));
    const store = new LanceVectorStore(dir, async () => memoryLanceDb());
    const filler: StoredChunk[] = [];
    for (let i = 0; i < 5001; i++) {
      filler.push(chunk("file-a", i));
    }
    await store.upsertChunks(filler);
    await store.upsertChunks([chunk("file-b", 0, { title: "Beyond the scan window" })]);

    const view = await store.getFile("file-b");
    expect(view).not.toBeNull();
    expect(view?.fileId).toBe("file-b");
    expect(view?.title).toBe("Beyond the scan window");
    expect(view?.chunkCount).toBe(1);
  });
});
