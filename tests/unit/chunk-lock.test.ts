import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_CHUNK_CHARS } from "../../src/chunk.js";
import { isIndexerMode, getCliCommand } from "../../src/processMode.js";
import { bindStdinCloseExit, shouldExitOnStdinClose } from "../../src/runtime.js";
import { createIndexerLock, formatLockData, parseLockData } from "../../src/lock.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world")).toEqual([{ index: 0, text: "hello world" }]);
  });

  it("splits long transcripts with overlap", () => {
    const text = "alpha ".repeat(400);
    const chunks = chunkText(text, { size: 80, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0].text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_CHARS);
    expect(chunks[1].text.length).toBeGreaterThan(0);
  });
});

describe("processMode", () => {
  it("detects --mode=indexer and the indexer bin name", () => {
    expect(isIndexerMode(["node", "dist/cli.js", "--mode=indexer"])).toBe(true);
    expect(isIndexerMode(["node", "dist/cli.js", "--mode", "indexer"])).toBe(true);
    expect(isIndexerMode(["node", "/usr/bin/plaud-index-indexer"])).toBe(true);
    expect(isIndexerMode(["node", "dist/cli.js"])).toBe(false);
    expect(isIndexerMode(["node", "dist/cli.js", "login"])).toBe(false);
  });

  it("routes login and logout as CLI commands", () => {
    expect(getCliCommand(["node", "dist/cli.js", "login"])).toBe("login");
    expect(getCliCommand(["node", "dist/cli.js", "logout"])).toBe("logout");
    expect(getCliCommand(["node", "dist/cli.js", "login", "--no-browser"])).toBe("login");
    expect(getCliCommand(["node", "dist/cli.js"])).toBe("mcp");
  });
});

describe("stdin close", () => {
  it("binds close only for query MCP, not the indexer daemon", () => {
    expect(shouldExitOnStdinClose(true)).toBe(false);
    expect(shouldExitOnStdinClose(false)).toBe(true);
    let bound = 0;
    bindStdinCloseExit({ on: () => { bound += 1; } }, true, () => {});
    expect(bound).toBe(0);
    bindStdinCloseExit({ on: () => { bound += 1; } }, false, () => {});
    expect(bound).toBe(1);
  });
});

describe("indexer lock", () => {
  it("only one process acquires; live holder is not displaced", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-lock-"));
    const lockFile = path.join(dir, "indexer.lock");
    const alive = new Set([1]);
    const a = createIndexerLock({
      lockFile,
      pid: 1,
      isAlive: (pid) => alive.has(pid),
      log: () => {}
    });
    const b = createIndexerLock({
      lockFile,
      pid: 2,
      isAlive: (pid) => alive.has(pid),
      log: () => {}
    });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    expect(parseLockData(formatLockData(1, 10))?.pid).toBe(1);
    a.release();
    expect(b.acquire()).toBe(true);
  });
});
