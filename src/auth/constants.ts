/**
 * Plaud consumer MCP OAuth — same public-client defaults as `@plaud-ai/mcp`.
 * These are published identifiers/URLs, not secrets. Override with env.
 */

/** macOS Keychain service for this product. */
export const KEYCHAIN_SERVICE = "plaud-index-mcp";

/** OAuth token-set JSON (access + refresh). Shareable happy path. */
export const KEYCHAIN_ACCOUNT_OAUTH = "plaud-mcp";

/** Optional Bearer-only override (`PLAUD_API_TOKEN`). Not the shareable path. */
export const KEYCHAIN_ACCOUNT_BEARER = "plaud-api";

/**
 * Public OAuth client id shipped by `@plaud-ai/mcp` (stdio login).
 * Not a client secret. Override: `PLAUD_MCP_CLIENT_ID` or `PLAUD_CLIENT_ID`.
 */
export const DEFAULT_MCP_CLIENT_ID = "client_9c501dad-8a0d-40b2-a7b0-d1cb8787f674";

export const DEFAULT_AUTHORIZATION_URL = "https://web.plaud.ai/platform/oauth";
export const DEFAULT_TOKEN_URL =
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token";
export const DEFAULT_REFRESH_URL =
  "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh";

/** MCP tools (`list_files` / `get_file` / `get_note` / `get_transcript`) use this API. */
export const DEFAULT_MCP_API_BASE = "https://platform.plaud.ai/developer/api";

/** Web/Bearer override client (`PLAUD_API_TOKEN`) default. */
export const DEFAULT_WEB_API_BASE = "https://api.plaud.ai";

export const OAUTH_CALLBACK_PORT = 8199;
export const OAUTH_CALLBACK_PATH = "/auth/callback";
export const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

export const LOGIN_TIMEOUT_MS = 120_000;
export const REFRESH_SKEW_MS = 60_000;

export const RELLOGIN_MESSAGE = "Plaud auth expired. Re-run: plaud-index-mcp login";

/** Persist failure after a successful OAuth token exchange (CLI). */
export const KEYCHAIN_WRITE_FAILED_MESSAGE =
  "Keychain write failed. Authorization succeeded, but tokens could not be saved. Run `plaud-index-mcp login` from a logged-in GUI/Terminal session on the host — not via LaunchAgent. Re-run login for a fresh authorize URL (clicking Allow again will get connection refused because the callback listener has exited).";

/** Persist failure after a successful OAuth token exchange (browser callback page). */
export const KEYCHAIN_WRITE_FAILED_PAGE =
  "Keychain write failed. Authorization succeeded, but tokens could not be saved. Re-run plaud-index-mcp login from a logged-in Terminal session on this host (not LaunchAgent). Do not click Allow again — the callback listener has stopped.";

export const SECRET_STORE_WRITE_FAILED_MESSAGE =
  "Token store write failed. Authorization succeeded, but tokens could not be saved. Re-run `plaud-index-mcp login`.";

/**
 * Mini-side login host notes (always-on host). Shown in `login --help` and during login.
 */
export const LOGIN_HOST_NOTES = [
  "Host browser must already be signed into Plaud before Allow (otherwise login/workspace walls; localhost callback never completes).",
  "Login waits about 2 minutes; if the URL expires, re-run `plaud-index-mcp login` for a fresh URL.",
  "Allow/callback must reach the same machine as the :8199 listener (or `ssh -L 8199:localhost:8199` when authorizing remotely).",
  "`plaud-index-mcp login` must run in a logged-in GUI/Terminal session — not via LaunchAgent (OAuth can complete then Keychain write fails)."
].join("\n");

export const AUTH_TRANSIENT_MESSAGE =
  "Cannot reach Plaud (network or server error). Will retry next cycle; tokens were not cleared.";

export const PLAUD_MCP_TOKEN_FILENAME = "tokens-mcp.json";
