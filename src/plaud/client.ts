import type { PlaudClient } from "./types.js";
import { HttpPlaudClient, type HttpPlaudClientOptions } from "./httpClient.js";
import { MockPlaudClient } from "./mockClient.js";

export type { PlaudClient } from "./types.js";
export { HttpPlaudClient } from "./httpClient.js";
export { MockPlaudClient } from "./mockClient.js";

/**
 * Auth is PLAUD_API_TOKEN (Keychain/env on Mini). This product never uses
 * Grok's OAuth session or ~/.plaud MCP tokens.
 */
export function createPlaudClient(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} & HttpPlaudClientOptions = {}): PlaudClient {
  const env = options.env || process.env;
  if (env.PLAUD_CLIENT === "mock" || env.PLAUD_USE_MOCK === "1") {
    return new MockPlaudClient();
  }
  return new HttpPlaudClient({
    env,
    fetchImpl: options.fetchImpl,
    token: options.token,
    baseUrl: options.baseUrl
  });
}

export function readPlaudToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.PLAUD_API_TOKEN;
  if (typeof token === "string" && token.trim()) {
    return token.trim();
  }
  return null;
}
