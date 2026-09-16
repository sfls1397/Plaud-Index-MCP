import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { KEYCHAIN_ACCOUNT_OAUTH, KEYCHAIN_LINE_TOO_LONG_MESSAGE, KEYCHAIN_READBACK_FAILED_MESSAGE, KEYCHAIN_SERVICE, KEYCHAIN_WRITE_FAILED_MESSAGE } from "./constants.js";
import { SecretStoreWriteError, isSecretStoreWriteError } from "./errors.js";
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

export type ExecFileAsync = (
  file: string,
  args: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

/** True when argv would store the character `-` as the password (Apple does not treat `-w -` as stdin). */
export function securityArgvUsesLiteralDashPassword(args: readonly string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-w" && args[i + 1] === "-") {
      return true;
    }
  }
  return false;
}

/**
 * Apple `security -i` reads one command line into a 4096-byte buffer
 * (`fgets(buf, 4096)` → at most 4095 bytes + NUL). Refuse at 4096 or more.
 */
export const SECURITY_INTERACTIVE_LINE_MAX = 4096;

/**
 * Quote one word for `security -i`.
 * Apple's tokenizer: `'` opens/closes a quoted word; inside it, `\\` and `\'`
 * escape backslash and quote. This is not POSIX shell `'\''` concatenation.
 */
export function quoteSecurityCliWord(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * Split a `security -i` line the way Apple's tokenizer does: whitespace
 * separates words; `'` quotes; `\\` / `\'` (and `\` + next char) escape.
 */
export function tokenizeSecurityInteractiveLine(line: string): string[] {
  const src = line.endsWith("\n") ? line.slice(0, -1) : line;
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let inQuote = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuote) {
      if (c === "\\" && i + 1 < src.length) {
        cur += src[i + 1];
        i += 1;
        continue;
      }
      if (c === "'") {
        inQuote = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < src.length) {
      cur += src[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    if (c === "'") {
      inQuote = true;
      inWord = true;
      continue;
    }
    if (c === " " || c === "\t") {
      if (inWord) {
        out.push(cur);
        cur = "";
        inWord = false;
      }
      continue;
    }
    cur += c;
    inWord = true;
  }
  if (inWord) {
    out.push(cur);
  }
  return out;
}

export function securityInteractiveCommandByteLength(command: string): number {
  return Buffer.byteLength(command, "utf8");
}

export function securityInteractiveCommandFits(command: string): boolean {
  return securityInteractiveCommandByteLength(command) < SECURITY_INTERACTIVE_LINE_MAX;
}

function assertSecurityInteractiveCommandFits(command: string): void {
  const bytes = securityInteractiveCommandByteLength(command);
  if (bytes < SECURITY_INTERACTIVE_LINE_MAX) {
    return;
  }
  throw new SecretStoreWriteError(
    `${KEYCHAIN_LINE_TOO_LONG_MESSAGE} Details: command is ${bytes} bytes (max ${SECURITY_INTERACTIVE_LINE_MAX - 1}).`
  );
}

/** argv for interactive mode: secret must never appear here. */
export function keychainSecurityInteractiveArgs(): string[] {
  return ["-i"];
}

/**
 * Command fed to `security -i` on stdin. `-w` is last so a password that starts
 * with `-` is not parsed as a flag. Never uses `-w -` as a stdin-password idiom.
 * Words are quoted with `quoteSecurityCliWord` (`\\` / `\'`, not POSIX `'\''`).
 */
export function keychainSecurityStdinCommand(options: {
  service: string;
  account: string;
  value: string;
  update?: boolean;
}): string {
  const update = options.update ? " -U" : "";
  return (
    `add-generic-password${update}` +
    ` -s ${quoteSecurityCliWord(options.service)}` +
    ` -a ${quoteSecurityCliWord(options.account)}` +
    ` -w ${quoteSecurityCliWord(options.value)}\n`
  );
}

export function keychainReadBackMatches(expected: string, actual: string | null): boolean {
  if (actual == null || actual === "") {
    return false;
  }
  if (actual === "-") {
    return false;
  }
  return actual === expected;
}

function describeReadBack(actual: string | null): string {
  if (actual == null || actual === "") {
    return "empty";
  }
  if (actual === "-") {
    return "literal '-' (security -w - stores a dash; it is not stdin)";
  }
  return "a different payload";
}

function keychainWriteFailure(detail?: string): SecretStoreWriteError {
  const trimmed = redactSecrets(detail ?? "").trim().replace(/\s+/g, " ");
  const extra = trimmed ? ` Details: ${trimmed.slice(0, 240)}` : "";
  return new SecretStoreWriteError(`${KEYCHAIN_WRITE_FAILED_MESSAGE}${extra}`);
}

function runSecurityInteractive(options: {
  bin: string;
  stdinCommand: string;
  spawnImpl: SpawnImpl;
}): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = options.spawnImpl(options.bin, keychainSecurityInteractiveArgs(), {
      stdio: ["pipe", "pipe", "pipe"]
    });
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
    child.stdin.on("error", () => {
      /* EPIPE / closed pipe: child close/error settles the promise. */
    });
    child.stdin.write(options.stdinCommand);
    child.stdin.end();
  });
}

async function defaultKeychainReadBack(options: {
  bin: string;
  service: string;
  account: string;
  execFileImpl: ExecFileAsync;
}): Promise<string | null> {
  try {
    const { stdout } = await options.execFileImpl(options.bin, [
      "find-generic-password",
      "-s",
      options.service,
      "-a",
      options.account,
      "-w"
    ]);
    const value = stdout.replace(/\n$/, "");
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Persist a generic password via `/usr/bin/security -i`.
 * Stdin is `add-generic-password … -w '<secret>'` so the secret is not process argv.
 * Apple’s `-w -` is a literal password and must not be used.
 *
 * After a 0 exit, reads the item back and fails if it is empty, `-`, or not the token.
 */
export async function writeKeychainPassword(options: {
  service: string;
  account: string;
  value: string;
  spawnImpl?: SpawnImpl;
  securityBin?: string;
  readBack?: () => Promise<string | null>;
  execFileImpl?: ExecFileAsync;
}): Promise<void> {
  const spawnImpl = options.spawnImpl || spawn;
  const securityBin = options.securityBin || "/usr/bin/security";
  const execFileImpl = options.execFileImpl || execFileAsync;
  const readBack =
    options.readBack ||
    (() =>
      defaultKeychainReadBack({
        bin: securityBin,
        service: options.service,
        account: options.account,
        execFileImpl
      }));

  const addCmd = keychainSecurityStdinCommand({
    service: options.service,
    account: options.account,
    value: options.value
  });
  const updateCmd = keychainSecurityStdinCommand({
    service: options.service,
    account: options.account,
    value: options.value,
    update: true
  });
  assertSecurityInteractiveCommandFits(addCmd);
  assertSecurityInteractiveCommandFits(updateCmd);

  let lastDetail = "";
  try {
    const added = await runSecurityInteractive({
      bin: securityBin,
      stdinCommand: addCmd,
      spawnImpl
    });
    if (added.code !== 0) {
      lastDetail = `security -i add-generic-password exited ${added.code}${added.stderr ? `: ${added.stderr}` : ""}`;
      const updated = await runSecurityInteractive({
        bin: securityBin,
        stdinCommand: updateCmd,
        spawnImpl
      });
      if (updated.code !== 0) {
        lastDetail = `security -i add-generic-password -U exited ${updated.code}${updated.stderr ? `: ${updated.stderr}` : ""}`;
        throw keychainWriteFailure(lastDetail);
      }
    }
  } catch (err) {
    if (isSecretStoreWriteError(err)) {
      throw err;
    }
    lastDetail = err instanceof Error ? err.message : String(err);
    throw keychainWriteFailure(lastDetail);
  }

  const stored = await readBack();
  if (!keychainReadBackMatches(options.value, stored)) {
    throw new SecretStoreWriteError(
      `${KEYCHAIN_READBACK_FAILED_MESSAGE} Details: ${describeReadBack(stored)}.`
    );
  }
}

export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly service: string = KEYCHAIN_SERVICE,
    private readonly securityBin: string = "/usr/bin/security",
    private readonly spawnImpl: SpawnImpl = spawn,
    private readonly execFileImpl: ExecFileAsync = execFileAsync
  ) {}

  describe(): string {
    return `macOS Keychain (service ${this.service} / account ${KEYCHAIN_ACCOUNT_OAUTH})`;
  }

  async get(account: string): Promise<string | null> {
    return defaultKeychainReadBack({
      bin: this.securityBin,
      service: this.service,
      account,
      execFileImpl: this.execFileImpl
    });
  }

  async set(account: string, value: string): Promise<void> {
    await writeKeychainPassword({
      service: this.service,
      account,
      value,
      spawnImpl: this.spawnImpl,
      securityBin: this.securityBin,
      execFileImpl: this.execFileImpl,
      readBack: () => this.get(account)
    });
  }

  async delete(account: string): Promise<void> {
    try {
      await this.execFileImpl(this.securityBin, [
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
