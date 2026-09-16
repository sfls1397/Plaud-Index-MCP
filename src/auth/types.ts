/**
 * Token document persisted in Keychain (and compatible with
 * `~/.plaud/tokens-mcp.json` from `@plaud-ai/mcp`).
 *
 * Shape:
 * ```
 * {
 *   "access_token": "<jwt>",
 *   "refresh_token": "<opaque>",
 *   "token_type": "Bearer",
 *   "expires_at": 1710000000000   // epoch ms; omitted if Plaud did not send expires_in
 * }
 * ```
 */
export interface PlaudTokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
}

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export interface OAuthEndpoints {
  clientId: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  apiBase: string;
}

export interface AuthorizationRequest {
  url: string;
  codeVerifier: string;
  state: string;
}
