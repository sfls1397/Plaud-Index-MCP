import fs from "node:fs";
import path from "node:path";

export const DEFAULT_LOCK_HEARTBEAT_MS = 60 * 1000;

export interface LockData {
  pid: number;
  timestamp: number;
  raw: string;
}

export function isProcessAlive(
  pid: number,
  killFn: (pid: number, signal: number) => void = (p, signal) => {
    process.kill(p, signal);
  }
): boolean {
  try {
    killFn(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseLockData(text: unknown): LockData | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const [pidStr, timestampStr] = text.split(":");
  const pid = parseInt(pidStr, 10);
  const timestamp = parseInt(timestampStr, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {
    pid,
    timestamp: Number.isInteger(timestamp) ? timestamp : 0,
    raw: text
  };
}

export function formatLockData(pid: number, timestamp: number): string {
  return `${pid}:${timestamp}`;
}

export interface IndexerLock {
  acquire(): boolean;
  release(): void;
  refresh(): boolean;
  startHeartbeat(intervalMs?: number): void;
  stopHeartbeat(): void;
  readonly ownsLock: boolean;
}

/**
 * Exclusive indexer.lock. A live holder is never displaced. Dead-PID
 * takeover uses wx-create so a peer's freshly written lock is not deleted.
 * Only one refresher holds the lock.
 */
export function createIndexerLock(options: {
  lockFile: string;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  fsApi?: Pick<typeof fs, "existsSync" | "readFileSync" | "writeFileSync" | "unlinkSync" | "mkdirSync">;
  log?: (msg: string) => void;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}): IndexerLock {
  const lockFile = options.lockFile;
  const pid = options.pid ?? process.pid;
  const now = options.now || (() => Date.now());
  const isAlive = options.isAlive || ((holderPid) => isProcessAlive(holderPid));
  const fsApi = options.fsApi || fs;
  const log = options.log || ((msg) => console.error(msg));
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  let ownsLock = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function readLockFile(): string | null {
    if (!fsApi.existsSync(lockFile)) {
      return null;
    }
    return fsApi.readFileSync(lockFile, "utf8");
  }

  function skipLiveHolder(parsed: LockData): boolean {
    log(`Another indexing instance running (PID ${parsed.pid}). Skipping indexing.`);
    ownsLock = false;
    return false;
  }

  function refreshOwned(): boolean {
    ownsLock = true;
    try {
      fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
    } catch {
      // Heartbeat can retry.
    }
    return true;
  }

  function acquire(): boolean {
    try {
      const lockDir = path.dirname(lockFile);
      if (!fsApi.existsSync(lockDir)) {
        fsApi.mkdirSync(lockDir, { recursive: true });
      }

      const existing = readLockFile();
      if (existing !== null) {
        const parsed = parseLockData(existing);
        if (!parsed) {
          ownsLock = false;
          return false;
        }
        if (parsed.pid === pid) {
          return refreshOwned();
        }
        if (isAlive(parsed.pid)) {
          return skipLiveHolder(parsed);
        }
        const again = readLockFile();
        if (again !== existing) {
          ownsLock = false;
          return false;
        }
        try {
          fsApi.unlinkSync(lockFile);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw err;
          }
        }
        log(`Removing stale lock file (PID ${parsed.pid} not running)`);
      }

      try {
        fsApi.writeFileSync(lockFile, formatLockData(pid, now()), { flag: "wx" });
        ownsLock = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          log("Another process acquired lock during race. Skipping indexing.");
          ownsLock = false;
          return false;
        }
        throw err;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Lock file error: ${message}`);
      ownsLock = false;
      return false;
    }
  }

  function release(): void {
    try {
      const lockData = readLockFile();
      if (lockData) {
        const parsed = parseLockData(lockData);
        if (parsed && parsed.pid === pid) {
          fsApi.unlinkSync(lockFile);
          ownsLock = false;
          log(`Released lock file (PID ${pid})`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Error releasing lock: ${message}`);
    }
  }

  function refresh(): boolean {
    try {
      if (!ownsLock) {
        return false;
      }
      const lockData = readLockFile();
      if (!lockData) {
        return false;
      }
      const parsed = parseLockData(lockData);
      if (parsed && parsed.pid === pid) {
        fsApi.writeFileSync(lockFile, formatLockData(pid, now()));
        return true;
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Lock heartbeat error: ${message}`);
      return false;
    }
  }

  function startHeartbeat(intervalMs = DEFAULT_LOCK_HEARTBEAT_MS): void {
    if (heartbeatTimer) {
      return;
    }
    heartbeatTimer = setIntervalFn(() => {
      refresh();
    }, intervalMs);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    acquire,
    release,
    refresh,
    startHeartbeat,
    stopHeartbeat,
    get ownsLock() {
      return ownsLock;
    }
  };
}
