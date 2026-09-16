import fs from "node:fs";
import { getConfigPath, getPlaudIndexDir } from "./paths.js";

/** Product default. */
export const DEFAULT_INDEX_INTERVAL_MS = 5 * 60 * 1000;

/** Documented floor: 30 seconds. */
export const MIN_INDEX_INTERVAL_MS = 30 * 1000;

/** Documented ceiling: 6 hours. */
export const MAX_INDEX_INTERVAL_MS = 6 * 60 * 60 * 1000;

const KNOWN_CONFIG_KEYS = new Set(["indexInterval", "indexIntervalMs"]);
const MAX_DURATION_STRING_LENGTH = 32;

function defaultWarn(message: string): void {
  console.error(message);
}

export function parseDuration(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DURATION_STRING_LENGTH) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isSafeInteger(n)) {
      return null;
    }
    return n;
  }
  const match = /^(\d+)(ms|s|m|h)$/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  const multiplier =
    unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60 * 1000 : 60 * 60 * 1000;
  const result = n * multiplier;
  if (!Number.isSafeInteger(result)) {
    return null;
  }
  return result;
}

export function formatIntervalMs(ms: number): string {
  if (!Number.isFinite(ms)) {
    return String(ms);
  }
  const rounded = Math.round(ms);
  if (rounded % (60 * 60 * 1000) === 0) {
    return `${rounded / (60 * 60 * 1000)}h`;
  }
  if (rounded % (60 * 1000) === 0) {
    return `${rounded / (60 * 1000)}m`;
  }
  if (rounded % 1000 === 0) {
    return `${rounded / 1000}s`;
  }
  return `${rounded}ms`;
}

export interface ClampResult {
  ms: number;
  human: string;
  clamped: boolean;
  invalid: boolean;
  requestedMs: number | null;
}

export function clampIndexInterval(
  raw: unknown,
  bounds: { defaultMs?: number; minMs?: number; maxMs?: number } = {}
): ClampResult {
  const defaultMs = bounds.defaultMs ?? DEFAULT_INDEX_INTERVAL_MS;
  const minMs = bounds.minMs ?? MIN_INDEX_INTERVAL_MS;
  const maxMs = bounds.maxMs ?? MAX_INDEX_INTERVAL_MS;
  const requestedMs = parseDuration(raw);

  if (requestedMs === null) {
    return {
      ms: defaultMs,
      human: formatIntervalMs(defaultMs),
      clamped: false,
      invalid: true,
      requestedMs: null
    };
  }

  const clampedMs = Math.min(maxMs, Math.max(minMs, requestedMs));
  return {
    ms: clampedMs,
    human: formatIntervalMs(clampedMs),
    clamped: clampedMs !== requestedMs,
    invalid: false,
    requestedMs
  };
}

export interface LoadedConfig {
  data: Record<string, unknown>;
  missing: boolean;
  invalid: boolean;
  path: string;
}

export function loadConfigFile(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  warn?: (msg: string) => void;
} = {}): LoadedConfig {
  const warn = options.warn || defaultWarn;
  const configPath = options.configPath || getConfigPath({ env: options.env });
  const exists = options.exists || ((p) => fs.existsSync(p));
  const readFile = options.readFile || ((p) => fs.readFileSync(p, "utf8"));

  if (!exists(configPath)) {
    return { data: {}, missing: true, invalid: false, path: configPath };
  }

  try {
    const raw = readFile(configPath);
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      warn("Invalid config.json: expected a JSON object. Using defaults.");
      return { data: {}, missing: false, invalid: true, path: configPath };
    }
    const data = parsed as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        warn(`Ignoring unknown config key: ${key}`);
      }
    }
    return { data, missing: false, invalid: false, path: configPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "parse error";
    warn(`Invalid config.json (${message}). Using defaults.`);
    return { data: {}, missing: false, invalid: true, path: configPath };
  }
}

function fileIntervalRaw(data: Record<string, unknown> | undefined): unknown {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(data, "indexInterval")) {
    return data.indexInterval;
  }
  if (Object.prototype.hasOwnProperty.call(data, "indexIntervalMs")) {
    return data.indexIntervalMs;
  }
  return undefined;
}

export type IntervalSource = "env" | "config" | "default";

export interface ResolvedInterval {
  ms: number;
  human: string;
  source: IntervalSource;
  clamped: boolean;
  invalid: boolean;
  requestedMs: number | null;
  raw: unknown;
}

/**
 * Precedence (highest wins):
 *   1. INDEX_INTERVAL_MS or PLAUD_INDEX_INTERVAL env
 *   2. ~/.plaud-index-mcp/config.json indexInterval / indexIntervalMs
 *   3. Product default 5m
 *
 * Values are clamped to [30s, 6h]. Env overrides file.
 */
export function resolveIndexInterval(options: {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  fileData?: Record<string, unknown>;
  warn?: (msg: string) => void;
} = {}): ResolvedInterval {
  const env = options.env || process.env;
  const warn = options.warn || defaultWarn;
  const envRaw = env.INDEX_INTERVAL_MS || env.PLAUD_INDEX_INTERVAL;
  const envSet = envRaw !== undefined && envRaw !== "";

  let source: IntervalSource = "default";
  let raw: unknown = DEFAULT_INDEX_INTERVAL_MS;

  if (envSet) {
    source = "env";
    raw = envRaw;
  } else {
    const data =
      options.fileData !== undefined
        ? options.fileData
        : loadConfigFile({ configPath: options.configPath, env, warn }).data;
    const fromFile = fileIntervalRaw(data);
    if (fromFile !== undefined) {
      source = "config";
      raw = fromFile;
    }
  }

  const clamped = clampIndexInterval(raw);
  if (clamped.invalid && source !== "default") {
    warn(
      `Invalid index interval ${JSON.stringify(raw)} from ${source}; using default ${clamped.human} (${clamped.ms} ms)`
    );
  } else if (clamped.clamped) {
    const fromHuman = formatIntervalMs(clamped.requestedMs ?? 0);
    warn(
      `Index interval ${fromHuman} (${clamped.requestedMs} ms) from ${source} is outside ${formatIntervalMs(MIN_INDEX_INTERVAL_MS)}–${formatIntervalMs(MAX_INDEX_INTERVAL_MS)}; clamped to ${clamped.human} (${clamped.ms} ms)`
    );
  }

  return {
    ms: clamped.ms,
    human: clamped.human,
    source: clamped.invalid && source !== "default" ? "default" : source,
    clamped: clamped.clamped,
    invalid: clamped.invalid,
    requestedMs: clamped.requestedMs,
    raw
  };
}

export function loadResolvedIndexInterval(options: {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  warn?: (msg: string) => void;
} = {}): ResolvedInterval {
  const warn = options.warn || defaultWarn;
  const loaded = loadConfigFile({
    configPath: options.configPath,
    env: options.env,
    warn
  });
  return resolveIndexInterval({
    env: options.env,
    fileData: loaded.data,
    warn
  });
}

export function logResolvedInterval(
  resolved: Pick<ResolvedInterval, "ms" | "human" | "source" | "clamped">,
  options: { log?: (msg: string) => void } = {}
): void {
  const log = options.log || defaultWarn;
  const clampedNote = resolved.clamped ? ", clamped" : "";
  log(
    `Effective index refresh interval: ${resolved.human} (${resolved.ms} ms) [source=${resolved.source}${clampedNote}]`
  );
}

export function ensurePlaudIndexDir(options: { env?: NodeJS.ProcessEnv } = {}): string {
  const dir = getPlaudIndexDir({ env: options.env });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
