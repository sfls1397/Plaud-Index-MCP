import { LOGIN_TIMEOUT_MS, OAUTH_CALLBACK_PORT, RELLOGIN_MESSAGE } from "./constants.js";
import { runOAuthCallback } from "./callback.js";
import { AuthExpiredError, isAuthExpiredError, isTransportError } from "./errors.js";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  resolveOAuthEndpoints
} from "./oauth.js";
import { createSecretStore, openBrowser } from "./secretStore.js";
import { createAuthSession } from "./session.js";
import type { SecretStore } from "./types.js";
import { redactSecrets } from "../sanitize.js";

export function argvHasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

export async function probeCurrentUser(options: {
  token: string;
  apiBase: string;
  fetchImpl?: typeof fetch;
}): Promise<"ok" | "unauthorized" | "error"> {
  const fetchImpl = options.fetchImpl || fetch;
  const url = `${options.apiBase.replace(/\/$/, "")}/open/third-party/users/current`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/json"
      }
    });
    if (response.status === 401 || response.status === 403) {
      return "unauthorized";
    }
    if (!response.ok) {
      return "error";
    }
    return "ok";
  } catch {
    return "error";
  }
}

export async function runLoginCommand(options: {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  store?: SecretStore;
  fetchImpl?: typeof fetch;
  openBrowser?: (url: string) => void;
  runCallback?: typeof runOAuthCallback;
  log?: (msg: string) => void;
  now?: () => number;
}): Promise<number> {
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const log = options.log || ((msg) => console.error(msg));
  const noBrowser = argvHasFlag(argv, "--no-browser") || argvHasFlag(argv, "--print-url");
  const store = options.store || createSecretStore({ env });
  const endpoints = resolveOAuthEndpoints(env);
  const session = await createAuthSession({
    env,
    store,
    fetchImpl: options.fetchImpl,
    now: options.now,
    log
  });

  const existing = await session.getAccessToken();
  if (existing) {
    const probe = await probeCurrentUser({
      token: existing,
      apiBase: endpoints.apiBase,
      fetchImpl: options.fetchImpl
    });
    if (probe === "ok") {
      log(
        "Already signed in. Tokens are in Keychain service `plaud-index-mcp` / account `plaud-mcp`."
      );
      return 0;
    }
    if (probe === "error") {
      log("Cannot reach Plaud to check saved credentials. Try again when the network is up.");
      return 1;
    }
    await session.clear();
  }

  const request = createAuthorizationRequest(endpoints);
  log("Plaud consumer MCP OAuth (public client / PKCE).");
  log(`Open this URL to authorize (same machine as the callback, or SSH-forward port ${OAUTH_CALLBACK_PORT}):`);
  log(request.url);
  log("");
  log(`If this host has no browser, from your laptop: ssh -L ${OAUTH_CALLBACK_PORT}:localhost:${OAUTH_CALLBACK_PORT} USER@HOST`);
  log("then open the URL above. Waiting for callback…");

  if (!noBrowser) {
    try {
      (options.openBrowser || openBrowser)(request.url);
    } catch {
      log("Could not open a browser automatically. Paste the URL above into a browser.");
    }
  }

  const callback = options.runCallback || runOAuthCallback;
  const result = await callback({
    expectedState: request.state,
    timeoutMs: LOGIN_TIMEOUT_MS,
    exchangeCode: async (code) => {
      const tokenSet = await exchangeAuthorizationCode({
        endpoints,
        code,
        codeVerifier: request.codeVerifier,
        state: request.state,
        fetchImpl: options.fetchImpl,
        now: options.now
      });
      await session.save(tokenSet);
    },
    onListening: () => {
      log(`Listening for OAuth callback on localhost:${OAUTH_CALLBACK_PORT}${endpoints.redirectUri.includes("/auth/callback") ? "/auth/callback" : ""}.`);
    }
  });

  switch (result.status) {
    case "success": {
      const token = await session.getAccessToken();
      if (token) {
        const probe = await probeCurrentUser({
          token,
          apiBase: endpoints.apiBase,
          fetchImpl: options.fetchImpl
        });
        if (probe === "unauthorized") {
          await session.clear();
          log(RELLOGIN_MESSAGE);
          return 1;
        }
      }
      log("Signed in. Access + refresh tokens stored in Keychain:");
      log("  service: plaud-index-mcp");
      log("  account: plaud-mcp");
      log("The indexer LaunchAgent will refresh this session headless. Do not copy Grok Bot OAuth.");
      return 0;
    }
    case "timeout":
      log(`Authentication timed out after 2 minutes. If no browser opened, open the printed URL.`);
      log(`Remote hosts: ssh -L ${OAUTH_CALLBACK_PORT}:localhost:${OAUTH_CALLBACK_PORT} USER@HOST`);
      return 1;
    case "denied":
      log("Authorization denied.");
      return 1;
    case "exchange-failed":
      log(redactSecrets(`Authentication failed: ${result.error?.message ?? "token exchange failed"}`));
      return 1;
    case "listen-failed":
      log(result.error?.message ?? "Failed to start OAuth callback server.");
      return 1;
    default:
      log("Authentication failed.");
      return 1;
  }
}

export async function runLogoutCommand(options: {
  env?: NodeJS.ProcessEnv;
  store?: SecretStore;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}): Promise<number> {
  const env = options.env || process.env;
  const log = options.log || ((msg) => console.error(msg));
  const store = options.store || createSecretStore({ env });
  const session = await createAuthSession({ env, store, fetchImpl: options.fetchImpl, log });
  const stored = session.peek();
  if (!stored) {
    log("Already logged out.");
    return 0;
  }
  const token = stored.access_token;
  if (token) {
    try {
      const endpoints = resolveOAuthEndpoints(env);
      const fetchImpl = options.fetchImpl || fetch;
      await fetchImpl(`${endpoints.apiBase.replace(/\/$/, "")}/open/third-party/users/current/revoke`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      });
    } catch {
      /* revoke is best-effort */
    }
  }
  await session.clear();
  log("Logged out. Keychain item plaud-index-mcp / plaud-mcp cleared.");
  log("If Plaud MCP still has ~/.plaud/tokens-mcp.json, delete it only if you also want that client signed out.");
  return 0;
}

export function describeAuthFailure(err: unknown): string {
  if (isAuthExpiredError(err) || err instanceof AuthExpiredError) {
    return RELLOGIN_MESSAGE;
  }
  if (isTransportError(err)) {
    return "Cannot reach Plaud (network). Will retry next cycle; tokens were not cleared.";
  }
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(message);
}
