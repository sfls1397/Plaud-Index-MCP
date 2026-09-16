import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  parseStoredTokenSet,
  refreshTokenSet,
  resolveOAuthEndpoints,
  tokenNeedsRefresh
} from "../../src/auth/oauth.js";
import { generateCodeChallenge } from "../../src/auth/pkce.js";
import { AuthExpiredError, AuthTransportError } from "../../src/auth/errors.js";
import { DEFAULT_MCP_CLIENT_ID, OAUTH_REDIRECT_URI } from "../../src/auth/constants.js";

describe("Plaud MCP OAuth (public client / PKCE)", () => {
  it("builds an authorize URL with PKCE S256 and the loopback redirect", () => {
    const endpoints = resolveOAuthEndpoints({});
    const req = createAuthorizationRequest(endpoints);
    const url = new URL(req.url);
    expect(endpoints.clientId).toBe(DEFAULT_MCP_CLIENT_ID);
    expect(url.origin + url.pathname).toBe("https://web.plaud.ai/platform/oauth");
    expect(url.searchParams.get("client_id")).toBe(DEFAULT_MCP_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(generateCodeChallenge(req.codeVerifier));
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(req.codeVerifier).digest("base64url")
    );
    expect(url.searchParams.get("state")).toBe(req.state);
    expect(req.url).not.toMatch(/client_secret/i);
  });

  it("exchanges a code as a public client (empty secret) and persists token shape", async () => {
    const endpoints = resolveOAuthEndpoints({});
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body ?? "")
      });
      return new Response(
        JSON.stringify({
          access_token: "access-one",
          refresh_token: "refresh-one",
          token_type: "Bearer",
          expires_in: 3600
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };
    const now = 1_700_000_000_000;
    const tokens = await exchangeAuthorizationCode({
      endpoints,
      code: "auth-code",
      codeVerifier: "verifier",
      state: "csrf-state",
      fetchImpl,
      now: () => now
    });
    expect(tokens).toEqual({
      access_token: "access-one",
      refresh_token: "refresh-one",
      token_type: "Bearer",
      expires_at: now + 3600 * 1000
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(endpoints.tokenUrl);
    const params = new URLSearchParams(calls[0].body);
    expect(params.get("code")).toBe("auth-code");
    expect(params.get("code_verifier")).toBe("verifier");
    expect(params.get("state")).toBe("csrf-state");
    expect(params.get("redirect_uri")).toBe(OAUTH_REDIRECT_URI);
    expect(params.get("client_secret")).toBeNull();
    const basic = Buffer.from(`${DEFAULT_MCP_CLIENT_ID}:`).toString("base64");
    expect(calls[0].headers.get("Authorization")).toBe(`Basic ${basic}`);
  });

  it("refreshes headlessly with only refresh_token in the body", async () => {
    const endpoints = resolveOAuthEndpoints({});
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? "");
      expect(body).toBe("refresh_token=refresh-one");
      expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      return new Response(
        JSON.stringify({
          access_token: "access-two",
          token_type: "Bearer",
          expires_in: 1800
        }),
        { status: 200 }
      );
    };
    const now = 1_700_000_000_000;
    const next = await refreshTokenSet({
      endpoints,
      tokenSet: {
        access_token: "access-one",
        refresh_token: "refresh-one",
        expires_at: now - 1
      },
      fetchImpl,
      now: () => now
    });
    expect(next.access_token).toBe("access-two");
    expect(next.refresh_token).toBe("refresh-one");
    expect(next.expires_at).toBe(now + 1800 * 1000);
  });

  it("maps refresh 5xx to AuthTransportError without leaking tokens", async () => {
    const endpoints = resolveOAuthEndpoints({});
    const secret = "refresh-should-not-appear";
    await expect(
      refreshTokenSet({
        endpoints,
        tokenSet: { access_token: "old", refresh_token: secret },
        fetchImpl: async () => new Response(`unavailable ${secret}`, { status: 503 })
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthTransportError);
      expect(String(err)).not.toMatch(/auth expired/i);
      expect(String(err)).not.toContain(secret);
      return true;
    });
  });

  it("maps refresh 401 to AuthExpiredError without leaking tokens", async () => {
    const endpoints = resolveOAuthEndpoints({});
    const secret = "refresh-should-not-appear";
    await expect(
      refreshTokenSet({
        endpoints,
        tokenSet: { access_token: "old", refresh_token: secret },
        fetchImpl: async () => new Response(`invalid ${secret}`, { status: 401 })
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AuthExpiredError);
      expect(String(err)).toMatch(/plaud-index-mcp login/i);
      expect(String(err)).not.toContain(secret);
      return true;
    });
  });

  it("parses the MCP token file shape", () => {
    const parsed = parseStoredTokenSet(
      JSON.stringify({
        access_token: "a",
        refresh_token: "r",
        token_type: "Bearer",
        expires_at: 99
      })
    );
    expect(parsed).toEqual({
      access_token: "a",
      refresh_token: "r",
      token_type: "Bearer",
      expires_at: 99
    });
    expect(tokenNeedsRefresh({ access_token: "a", expires_at: 1000 }, 950, 60)).toBe(true);
    expect(tokenNeedsRefresh({ access_token: "a", expires_at: 10_000 }, 1000, 60)).toBe(false);
  });

  it("ignores non-loopback PLAUD_CALLBACK_URL overrides", () => {
    const hijack = resolveOAuthEndpoints({ PLAUD_CALLBACK_URL: "https://evil.example/auth/callback" });
    expect(hijack.redirectUri).toBe(OAUTH_REDIRECT_URI);
    const ok = resolveOAuthEndpoints({ PLAUD_CALLBACK_URL: "http://127.0.0.1:8199/auth/callback" });
    expect(ok.redirectUri).toBe("http://127.0.0.1:8199/auth/callback");
  });
});
