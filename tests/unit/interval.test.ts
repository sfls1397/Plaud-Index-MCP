import { describe, expect, it } from "vitest";
import {
  clampIndexInterval,
  DEFAULT_INDEX_INTERVAL_MS,
  formatIntervalMs,
  loadConfigFile,
  loadResolvedIndexInterval,
  logResolvedInterval,
  MAX_INDEX_INTERVAL_MS,
  MIN_INDEX_INTERVAL_MS,
  parseDuration,
  resolveIndexInterval
} from "../../src/config.js";
import { getConfigPath, getPlaudIndexDir } from "../../src/paths.js";

describe("parseDuration", () => {
  it("accepts human forms 30s, 5m, 1h and plain ms", () => {
    expect(parseDuration("30s")).toBe(30 * 1000);
    expect(parseDuration("5m")).toBe(5 * 60 * 1000);
    expect(parseDuration("1h")).toBe(60 * 60 * 1000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration(60000)).toBe(60000);
    expect(parseDuration("60000")).toBe(60000);
  });

  it("rejects invalid values", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("nope")).toBeNull();
    expect(parseDuration("1.5m")).toBeNull();
  });
});

describe("clampIndexInterval", () => {
  it("uses the documented 30s floor, 6h ceiling, and 5m default", () => {
    expect(MIN_INDEX_INTERVAL_MS).toBe(30 * 1000);
    expect(MAX_INDEX_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_INDEX_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("allows 30s and 5m without clamping", () => {
    expect(clampIndexInterval("30s")).toMatchObject({ ms: 30000, clamped: false, invalid: false });
    expect(clampIndexInterval("5m")).toMatchObject({ ms: 300000, clamped: false });
  });

  it("clamps below the 30s floor with requestedMs preserved", () => {
    const result = clampIndexInterval("5s");
    expect(result.ms).toBe(MIN_INDEX_INTERVAL_MS);
    expect(result.clamped).toBe(true);
    expect(result.requestedMs).toBe(5000);
  });

  it("clamps above the 6h ceiling", () => {
    const result = clampIndexInterval("10h");
    expect(result.ms).toBe(MAX_INDEX_INTERVAL_MS);
    expect(result.clamped).toBe(true);
  });

  it("falls back to the 5m default for unparseable values", () => {
    const result = clampIndexInterval("banana");
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS);
    expect(result.invalid).toBe(true);
    expect(result.clamped).toBe(false);
  });
});

describe("resolveIndexInterval", () => {
  it("uses the 5-minute product default when nothing is set", () => {
    const result = resolveIndexInterval({ env: {}, fileData: {}, warn: () => {} });
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS);
    expect(result.source).toBe("default");
    expect(result.human).toBe("5m");
  });

  it("reads indexInterval from config when env is unset", () => {
    const result = resolveIndexInterval({
      env: {},
      fileData: { indexInterval: "1h" },
      warn: () => {}
    });
    expect(result.ms).toBe(60 * 60 * 1000);
    expect(result.source).toBe("config");
  });

  it("lets INDEX_INTERVAL_MS override the config file", () => {
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: "30s" },
      fileData: { indexInterval: "1h" },
      warn: () => {}
    });
    expect(result.ms).toBe(30000);
    expect(result.source).toBe("env");
  });

  it("warns when clamping an env value below 30s", () => {
    const warns: string[] = [];
    const result = resolveIndexInterval({
      env: { INDEX_INTERVAL_MS: "5s" },
      fileData: {},
      warn: (msg) => warns.push(msg)
    });
    expect(result.ms).toBe(MIN_INDEX_INTERVAL_MS);
    expect(result.clamped).toBe(true);
    expect(warns[0]).toMatch(/clamped to 30s/);
  });
});

describe("loadConfigFile", () => {
  it("treats a missing file as empty defaults", () => {
    const result = loadConfigFile({
      configPath: "/tmp/does-not-exist-plaud-index-config.json",
      exists: () => false,
      warn: () => {}
    });
    expect(result.missing).toBe(true);
    expect(result.data).toEqual({});
  });

  it("warns and ignores unknown keys including path overrides", () => {
    const warns: string[] = [];
    const result = loadConfigFile({
      configPath: "/tmp/config.json",
      exists: () => true,
      readFile: () => JSON.stringify({ indexInterval: "5m", extra: true, configPath: "/etc/passwd" }),
      warn: (msg) => warns.push(msg)
    });
    expect(result.data.indexInterval).toBe("5m");
    expect(warns.some((w) => w.includes("extra"))).toBe(true);
    expect(warns.some((w) => w.includes("configPath"))).toBe(true);
  });
});

describe("config path stays under ~/.plaud-index-mcp/", () => {
  it("does not follow a path from config contents", () => {
    const dir = getPlaudIndexDir({ env: { HOME: "/Users/example" } });
    const configPath = getConfigPath({ env: { HOME: "/Users/example" } });
    expect(dir).toBe("/Users/example/.plaud-index-mcp");
    expect(configPath).toBe("/Users/example/.plaud-index-mcp/config.json");
  });
});

describe("logResolvedInterval", () => {
  it("logs human form and milliseconds", () => {
    const lines: string[] = [];
    logResolvedInterval(
      { ms: 300000, human: "5m", source: "config", clamped: false },
      { log: (msg) => lines.push(msg) }
    );
    expect(lines[0]).toBe("Effective index refresh interval: 5m (300000 ms) [source=config]");
  });
});

describe("loadResolvedIndexInterval", () => {
  it("composes file load + resolve without throwing", () => {
    const result = loadResolvedIndexInterval({
      env: {},
      configPath: "/tmp/does-not-exist-plaud-index-config.json",
      warn: () => {}
    });
    expect(result.ms).toBe(DEFAULT_INDEX_INTERVAL_MS);
  });
});

describe("formatIntervalMs", () => {
  it("uses compact units", () => {
    expect(formatIntervalMs(30000)).toBe("30s");
    expect(formatIntervalMs(300000)).toBe("5m");
    expect(formatIntervalMs(6 * 60 * 60 * 1000)).toBe("6h");
  });
});
