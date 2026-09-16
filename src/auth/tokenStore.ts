import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEYCHAIN_ACCOUNT_OAUTH, PLAUD_MCP_TOKEN_FILENAME, SECRET_STORE_WRITE_FAILED_MESSAGE } from "./constants.js";
import { isSecretStoreWriteError, SecretStoreWriteError } from "./errors.js";
import { parseStoredTokenSet, serializeTokenSet } from "./oauth.js";
import { createSecretStore } from "./secretStore.js";
import type { PlaudTokenSet, SecretStore } from "./types.js";

export function defaultPlaudMcpTokenPath(env: NodeJS.ProcessEnv = process.env, homedir?: () => string): string {
  if (typeof env.PLAUD_MCP_TOKEN_FILE === "string" && env.PLAUD_MCP_TOKEN_FILE.trim()) {
    return path.resolve(env.PLAUD_MCP_TOKEN_FILE);
  }
  const home = env.HOME || (homedir || os.homedir)();
  return path.join(home, ".plaud", PLAUD_MCP_TOKEN_FILENAME);
}

export function readPlaudMcpTokenFile(filePath: string): PlaudTokenSet | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return parseStoredTokenSet(raw);
  } catch {
    return null;
  }
}

export class PlaudTokenStore {
  constructor(
    private readonly store: SecretStore,
    private readonly account: string = KEYCHAIN_ACCOUNT_OAUTH
  ) {}

  async load(): Promise<PlaudTokenSet | null> {
    const raw = await this.store.get(this.account);
    if (!raw) {
      return null;
    }
    return parseStoredTokenSet(raw);
  }

  async save(tokenSet: PlaudTokenSet): Promise<void> {
    try {
      await this.store.set(this.account, serializeTokenSet(tokenSet));
    } catch (err) {
      if (isSecretStoreWriteError(err)) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new SecretStoreWriteError(
        `${SECRET_STORE_WRITE_FAILED_MESSAGE}${detail ? ` Details: ${detail}` : ""}`
      );
    }
  }

  async clear(): Promise<void> {
    await this.store.delete(this.account);
  }
}

export async function loadOrMigrateTokenSet(options: {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  mcpTokenPath?: string;
  log?: (msg: string) => void;
}): Promise<{ tokenSet: PlaudTokenSet | null; migrated: boolean; tokenStore: PlaudTokenStore }> {
  const env = options.env || process.env;
  const secretStore = options.store || createSecretStore({ env });
  const tokenStore = new PlaudTokenStore(secretStore);
  const existing = await tokenStore.load();
  if (existing) {
    return { tokenSet: existing, migrated: false, tokenStore };
  }
  const filePath = options.mcpTokenPath || defaultPlaudMcpTokenPath(env);
  const fromFile = readPlaudMcpTokenFile(filePath);
  if (!fromFile) {
    return { tokenSet: null, migrated: false, tokenStore };
  }
  await tokenStore.save(fromFile);
  const location = secretStore.describe();
  options.log?.(`Migrated Plaud MCP tokens from ${filePath} into ${location}.`);
  return { tokenSet: fromFile, migrated: true, tokenStore };
}
