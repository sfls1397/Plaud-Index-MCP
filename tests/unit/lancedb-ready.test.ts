import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LanceVectorStore } from "../../src/store/lancedbStore.js";
import { NOTES_TABLE } from "../../src/store/types.js";

function mockConnection(getNames: () => string[], rows: Record<string, unknown>[] = [{ id: "row-1" }]) {
  return {
    tableNames: async () => getNames(),
    openTable: async () => ({
      add: async () => undefined,
      delete: async () => undefined,
      query: () => ({
        limit: () => ({
          toArray: async () => (getNames().includes(NOTES_TABLE) ? rows : [])
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
