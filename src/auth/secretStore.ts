import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { KEYCHAIN_ACCOUNT_OAUTH, KEYCHAIN_SERVICE, KEYCHAIN_WRITE_FAILED_MESSAGE } from "./constants.js";
import { SecretStoreWriteError } from "./errors.js";
import { redactSecrets } from "../sanitize.js";
import { getPlaudIndexDir } from "../paths.js";
import type { SecretStore } from "./types.js";

const execFileAsync = promisify(execFile);

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  describe(): string {
    return `in-memory store (account ${KEYCHAIN_ACCOUNT_OAUTH})`;
  }

  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

/**
 * File-backed store used in tests (`PLAUD_INDEX_HOME`) and as a Linux fallback.
 * Mini/LaunchAgent uses Keychain, not this file.
 */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  describe(): string {
    return `file store under ${path.join(this.dir, "secrets")} (account ${KEYCHAIN_ACCOUNT_OAUTH})`;
  }

  private fileFor(account: string): string {
    const safe = account.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(this.dir, "secrets", safe);
  }

  async get(account: string): Promise<string | null> {
    try {
      const raw = await fs.promises.readFile(this.fileFor(account), "utf8");
      const trimmed = raw.trim();
      return trimmed ? trimmed : null;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async set(account: string, value: string): Promise<void> {
    const file = this.fileFor(account);
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(file, value, { encoding: "utf8", mode: 0o600 });
    await fs.promises.chmod(file, 0o600);
  }

  async delete(account: string): Promise<void> {
    try {
      await fs.promises.rm(this.fileFor(account));
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"] }
) => ChildProcess;

/**
 * `security add-generic-password` argv. Secret is never on argv — caller writes it
 * to stdin because `-w -` means "read password from stdin".
 *
 * Mini: JXA/`osascript` `SecItemAdd` returns -50; this CLI path is what works.
 */
export function keychainSecurityWriteArgs(options: {
  service: string;
  account: string;
  update?: boolean;
}): string[] {
  const args = ["add-generic-password", "-s", options.service, "-a", options.account];
  if (options.update) {
    args.push("-U");
  }
  args.push("-w", "-");
  return args;
}

function keychainWriteFailure(detail?: string): SecretStoreWriteError {
  const trimmed = redactSecrets(detail ?? "").trim().replace(/\s+/g, " ");
  const extra = trimmed ? ` Details: ${trimmed.slice(0, 240)}` : "";
  return new SecretStoreWriteError(`${KEYCHAIN_WRITE_FAILED_MESSAGE}${extra}`);
}

function runSecurityStdinWrite(options: {
  bin: string;
  args: readonly string[];
  value: string;
  spawnImpl: SpawnImpl;
}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = options.spawnImpl(options.bin, options.args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const settle = (result: { code: number | null; stderr: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    });
    child.on("close", (code) => {
      settle({ code, stderr });
    });
    if (!child.stdin) {
      settle({ code: 1, stderr: stderr || "security stdin unavailable" });
      return;
    }
    // security may exit before stdin drains; write then emits EPIPE. Handle
    // it before write so a closed pipe cannot crash the process.
    child.stdin.on("error", () => {
      /* EPIPE / closed pipe: child close/error settles the promise. */
    });
    child.stdin.write(options.value);
    child.stdin.end();
  });
}

/**
 * Persist a generic password via `/usr/bin/security` with the secret on stdin
 * (`-w -`). Tries add, then update (`-U`) if the item already exists.
 *
 * Does not use osascript JXA `SecItemAdd` (that returns -50 on Mini).
 */
export async function writeKeychainPassword(options: {
  service: string;
  account: string;
  value: string;
  spawnImpl?: SpawnImpl;
  securityBin?: string;
}): Promise<void> {
  const spawnImpl = options.spawnImpl || spawn;
  const securityBin = options.securityBin || "/usr/bin/security";
  const addArgs = keychainSecurityWriteArgs({
    service: options.service,
    account: options.account
  });
  const updateArgs = keychainSecurityWriteArgs({
    service: options.service,
    account: options.account,
    update: true
  });

  let lastDetail = "";
  try {
    const added = await runSecurityStdinWrite({
      bin: securityBin,
      args: addArgs,
      value: options.value,
      spawnImpl
    });
    if (added.code === 0) {
      return;
    }
    lastDetail = `security add-generic-password exited ${added.code}${added.stderr ? `: ${added.stderr}` : ""}`;
    const updated = await runSecurityStdinWrite({
      bin: securityBin,
      args: updateArgs,
      value: options.value,
      spawnImpl
    });
    if (updated.code === 0) {
      return;
    }
    lastDetail = `security add-generic-password -U exited ${updated.code}${updated.stderr ? `: ${updated.stderr}` : ""}`;
  } catch (err) {
    lastDetail = err instanceof Error ? err.message : String(err);
  }
  throw keychainWriteFailure(lastDetail);
}

export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly securityBin: string = "/usr/bin/security",
    private readonly spawnImpl: SpawnImpl = spawn
  ) {}

  describe(): string {
    return `macOS Keychain (service ${this.service} / account ${KEYCHAIN_ACCOUNT_OAUTH})`;
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.securityBin, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w"
      ]);
      const value = stdout.replace(/\n$/, "");
      return value ? value : null;
    } catch {
      return null;
    }
  }

  async set(account: string, value: string): Promise<void> {
    await writeKeychainPassword({
      service: this.service,
      account,
      value,
      spawnImpl: this.spawnImpl,
      securityBin: this.securityBin
    });
  }

  async delete(account: string): Promise<void> {
    try {
      await execFileAsync(this.securityBin, [
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        account
      ]);
    } catch {
      /* already gone */
    }
  }
}

export function createSecretStore(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
} = {}): SecretStore {
  const env = options.env || process.env;
  if (env.PLAUD_SECRET_STORE === "memory") {
    return new MemorySecretStore();
  }
  const platform = options.platform || process.platform;
  const indexHome = env.PLAUD_INDEX_HOME && env.PLAUD_INDEX_HOME.trim();
  if (indexHome) {
    return new FileSecretStore(path.resolve(indexHome));
  }
  if (platform === "darwin") {
    return new KeychainSecretStore();
  }
  return new FileSecretStore(getPlaudIndexDir({ env }));
}

export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}
