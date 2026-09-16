import { REFRESH_SKEW_MS, RELLOGIN_MESSAGE } from "./constants.js";
import { AuthExpiredError, isAuthExpiredError, isTransportError } from "./errors.js";
import { refreshTokenSet, resolveOAuthEndpoints, tokenNeedsRefresh } from "./oauth.js";
import { loadOrMigrateTokenSet, type PlaudTokenStore } from "./tokenStore.js";
import type { OAuthEndpoints, PlaudTokenSet, SecretStore } from "./types.js";

export interface PlaudAuthSession {
  endpoints: OAuthEndpoints;
  getAccessToken(): Promise<string | null>;
  refresh(): Promise<string | null>;
  save(tokenSet: PlaudTokenSet): Promise<void>;
  clear(): Promise<void>;
  peek(): PlaudTokenSet | null;
}

export async function createAuthSession(options: {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string) => void;
  mcpTokenPath?: string;
}): Promise<PlaudAuthSession> {
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const endpoints = resolveOAuthEndpoints(env);
  const loaded = await loadOrMigrateTokenSet({
    env,
    store: options.store,
    mcpTokenPath: options.mcpTokenPath,
    log: options.log
  });
  let current: PlaudTokenSet | null = loaded.tokenSet;
  const tokenStore: PlaudTokenStore = loaded.tokenStore;

  async function persist(next: PlaudTokenSet): Promise<void> {
    current = next;
    await tokenStore.save(next);
  }

  async function refresh(): Promise<string | null> {
    if (!current?.refresh_token) {
      throw new AuthExpiredError();
    }
    try {
      const next = await refreshTokenSet({
        endpoints,
        tokenSet: current,
        fetchImpl: options.fetchImpl,
        now
      });
      await persist(next);
      return next.access_token;
    } catch (err) {
      if (isAuthExpiredError(err)) {
        options.log?.(RELLOGIN_MESSAGE);
        throw err;
      }
      if (isTransportError(err)) {
        throw err;
      }
      options.log?.(RELLOGIN_MESSAGE);
      throw new AuthExpiredError();
    }
  }

  async function getAccessToken(): Promise<string | null> {
    if (!current) {
      return null;
    }
    if (tokenNeedsRefresh(current, now(), REFRESH_SKEW_MS)) {
      if (!current.refresh_token) {
        return null;
      }
      try {
        return await refresh();
      } catch (err) {
        if (isTransportError(err) && current?.access_token) {
          return current.access_token;
        }
        if (isAuthExpiredError(err)) {
          return null;
        }
        throw err;
      }
    }
    return current.access_token;
  }

  return {
    endpoints,
    getAccessToken,
    refresh,
    save: persist,
    clear: async () => {
      current = null;
      await tokenStore.clear();
    },
    peek: () => current
  };
}
