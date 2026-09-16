import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { KEYCHAIN_ACCOUNT_OAUTH, KEYCHAIN_SERVICE } from "./constants.js";
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
 * JXA: SecItemAdd with the password on stdin so it never appears in `security -w` argv.
 */
export function keychainWriteJxa(service: string, account: string): string {
  return `
ObjC.import("Foundation");
ObjC.import("Security");
function ns(s) { return $.NSString.stringWithString(s); }
var service = ${JSON.stringify(service)};
var account = ${JSON.stringify(account)};
var raw = $.NSString.alloc.initWithDataEncoding(
  $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile,
  $.NSUTF8StringEncoding
).js;
var query = $.NSMutableDictionary.new;
query.setObjectForKey($.kSecClassGenericPassword, $.kSecClass);
query.setObjectForKey(ns(service), $.kSecAttrService);
query.setObjectForKey(ns(account), $.kSecAttrAccount);
$.SecItemDelete(query);
query.setObjectForKey(ns(raw).dataUsingEncoding($.NSUTF8StringEncoding), $.kSecValueData);
var status = $.SecItemAdd(query, null);
if (status !== 0) {
  throw new Error("SecItemAdd " + status);
}
`;
}

export function writeKeychainPassword(options: {
  service: string;
  account: string;
  value: string;
  spawnImpl?: SpawnImpl;
  osascriptBin?: string;
}): Promise<void> {
  const spawnImpl = options.spawnImpl || spawn;
  const osascriptBin = options.osascriptBin || "/usr/bin/osascript";
  const args = ["-l", "JavaScript", "-e", keychainWriteJxa(options.service, options.account)];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(osascriptBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", () => {
      reject(new Error("Keychain write failed. Run `plaud-index-mcp login` from a logged-in user session."));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error("Keychain write failed. Run `plaud-index-mcp login` from a logged-in user session."));
    });
    if (!child.stdin) {
      reject(new Error("Keychain write failed. Run `plaud-index-mcp login` from a logged-in user session."));
      return;
    }
    child.stdin.write(options.value);
    child.stdin.end();
  });
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
      spawnImpl: this.spawnImpl
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
