import type { PlaudClient } from "./types.js";
import { HttpPlaudClient, type HttpPlaudClientOptions } from "./httpClient.js";
import { MockPlaudClient } from "./mockClient.js";
import { McpPlaudClient } from "./mcpClient.js";
import { createAuthSession } from "../auth/session.js";
import { createSecretStore } from "../auth/secretStore.js";
import { KEYCHAIN_ACCOUNT_BEARER } from "../auth/constants.js";
import { AuthExpiredError } from "../auth/errors.js";
import type { SecretStore } from "../auth/types.js";

export type { PlaudClient } from "./types.js";
export { HttpPlaudClient } from "./httpClient.js";
export { MockPlaudClient } from "./mockClient.js";
export { McpPlaudClient } from "./mcpClient.js";

export function readPlaudToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.PLAUD_API_TOKEN;
  if (typeof token === "string" && token.trim()) {
    return token.trim();
  }
  return null;
}

export async function readOptionalBearerOverride(options: {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
}): Promise<string | null> {
  const env = options.env || process.env;
  const fromEnv = readPlaudToken(env);
  if (fromEnv) {
    return fromEnv;
  }
  if (!options.store) {
    return null;
  }
  const fromKeychain = await options.store.get(KEYCHAIN_ACCOUNT_BEARER);
  return fromKeychain && fromKeychain.trim() ? fromKeychain.trim() : null;
}

/**
 * Auth order:
 * 1. `PLAUD_CLIENT=mock` (tests)
 * 2. `PLAUD_API_TOKEN` env — optional Bearer override, not the shareable path
 * 3. Plaud consumer MCP OAuth (Keychain `plaud-mcp`, migrated from `~/.plaud/tokens-mcp.json`)
 * 4. Keychain account `plaud-api` — leftover Bearer override if no OAuth session
 */
export async function createPlaudClient(
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    store?: SecretStore;
    log?: (msg: string) => void;
  } & HttpPlaudClientOptions = {}
): Promise<PlaudClient> {
  const env = options.env || process.env;
  if (env.PLAUD_CLIENT === "mock" || env.PLAUD_USE_MOCK === "1") {
    return new MockPlaudClient();
  }

  const store = options.store || createSecretStore({ env });
  const envBearer = options.token ?? readPlaudToken(env);
  if (envBearer) {
    options.log?.(
      "Using PLAUD_API_TOKEN Bearer override (not the shareable happy path). Prefer `plaud-index-mcp login`."
    );
    return new HttpPlaudClient({
      env,
      fetchImpl: options.fetchImpl,
      token: envBearer,
      baseUrl: options.baseUrl
    });
  }

  const session = await createAuthSession({
    env,
    store,
    fetchImpl: options.fetchImpl,
    log: options.log
  });
  const mcpToken = await session.getAccessToken();
  if (mcpToken) {
    return new McpPlaudClient({
      session,
      env,
      fetchImpl: options.fetchImpl,
      baseUrl: options.baseUrl
    });
  }

  const keychainBearer = await store.get(KEYCHAIN_ACCOUNT_BEARER);
  if (keychainBearer && keychainBearer.trim()) {
    options.log?.(
      "Using Keychain account `plaud-api` Bearer override (not the shareable happy path). Prefer `plaud-index-mcp login`."
    );
    return new HttpPlaudClient({
      env,
      fetchImpl: options.fetchImpl,
      token: keychainBearer.trim(),
      baseUrl: options.baseUrl
    });
  }

  throw new AuthExpiredError();
}
