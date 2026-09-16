import { describe, expect, it } from "vitest";
import { runLoginCommand, runLogoutCommand } from "../../src/auth/login.js";
import { MemorySecretStore } from "../../src/auth/secretStore.js";
import { KEYCHAIN_ACCOUNT_OAUTH } from "../../src/auth/constants.js";
import { serializeTokenSet } from "../../src/auth/oauth.js";
import { runOAuthCallback } from "../../src/auth/callback.js";

describe("plaud-index-mcp login / logout", () => {
  it("completes PKCE login and stores tokens without logging secrets", async () => {
    const store = new MemorySecretStore();
    const logs: string[] = [];
    const opened: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/access-token") && !url.includes("refresh")) {
        const body = String(init?.body ?? "");
        expect(body).toContain("code=auth-code");
        expect(body).toContain("code_verifier=");
        return new Response(
          JSON.stringify({
            access_token: "login-access",
            refresh_token: "login-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/open/third-party/users/current")) {
        return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };

    const code = await runLoginCommand({
      env: {},
      argv: ["node", "cli.js", "login"],
      store,
      fetchImpl,
      openBrowser: (url) => {
        opened.push(url);
      },
      runCallback: async (opts) => {
        await opts.exchangeCode("auth-code");
        return { status: "success" };
      },
      log: (m) => logs.push(m)
    });

    expect(code).toBe(0);
    expect(opened[0]).toContain("https://web.plaud.ai/platform/oauth");
    expect(opened[0]).toContain("code_challenge");
    const stored = JSON.parse((await store.get(KEYCHAIN_ACCOUNT_OAUTH)) || "{}") as {
      access_token?: string;
      refresh_token?: string;
    };
    expect(stored.access_token).toBe("login-access");
    expect(stored.refresh_token).toBe("login-refresh");
    const joined = logs.join("\n");
    expect(joined).toMatch(/Signed in/);
    expect(joined).toMatch(/plaud-index-mcp/);
    expect(joined).toMatch(/plaud-mcp/);
    expect(joined).not.toContain("login-access");
    expect(joined).not.toContain("login-refresh");
    expect(joined).toMatch(/8199/);
  });

  it("skips browser login when already signed in", async () => {
    const store = new MemorySecretStore();
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "existing-access",
        refresh_token: "existing-refresh",
        expires_at: Date.now() + 120_000
      })
    );
    const logs: string[] = [];
    let exchanged = false;
    const code = await runLoginCommand({
      store,
      argv: ["node", "cli.js", "login"],
      fetchImpl: async (input) => {
        if (String(input).endsWith("/open/third-party/users/current")) {
          return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
        }
        return new Response("nope", { status: 500 });
      },
      runCallback: async () => {
        exchanged = true;
        return { status: "success" };
      },
      log: (m) => logs.push(m)
    });
    expect(code).toBe(0);
    expect(exchanged).toBe(false);
    expect(logs.join("\n")).toMatch(/Already signed in/);
  });

  it("clears Keychain on logout", async () => {
    const store = new MemorySecretStore();
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({ access_token: "bye-access", refresh_token: "bye-refresh" })
    );
    const logs: string[] = [];
    const code = await runLogoutCommand({
      store,
      fetchImpl: async () => new Response("{}", { status: 200 }),
      log: (m) => logs.push(m)
    });
    expect(code).toBe(0);
    expect(await store.get(KEYCHAIN_ACCOUNT_OAUTH)).toBeNull();
    expect(logs.join("\n")).toMatch(/Logged out/);
    expect(logs.join("\n")).not.toContain("bye-access");
  });
});

describe("OAuth callback server", () => {
  it("exchanges only the expected state and ignores other paths", async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    let exchanged: string | null = null;
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const pending = runOAuthCallback({
      port,
      expectedState: "good-state",
      timeoutMs: 5000,
      postSuccessDelayMs: 10,
      onListening: () => listening(),
      exchangeCode: async (code) => {
        exchanged = code;
      }
    });
    await Promise.race([
      ready,
      pending.then((r) => {
        throw new Error(`callback ended before listen: ${r.status} ${r.error?.message ?? ""}`);
      })
    ]);

    const other = await fetch(`http://127.0.0.1:${port}/not-callback`);
    expect(other.status).toBe(404);

    const wrong = await fetch(`http://127.0.0.1:${port}/auth/callback?code=stolen&state=wrong`);
    expect(wrong.status).toBe(200);
    expect(exchanged).toBeNull();

    const ok = await fetch(`http://127.0.0.1:${port}/auth/callback?code=good-code&state=good-state`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toMatch(/Authorization successful/);
    expect(html).not.toContain("good-code");

    const result = await pending;
    expect(result.status).toBe("success");
    expect(exchanged).toBe("good-code");
  });
});
