import { describe, expect, it } from "vitest";
import { describeAuthFailure, runLoginCommand, runLogoutCommand } from "../../src/auth/login.js";
import { createSecretStore, MemorySecretStore } from "../../src/auth/secretStore.js";
import { AUTH_TRANSIENT_MESSAGE, KEYCHAIN_ACCOUNT_OAUTH, RELLOGIN_MESSAGE } from "../../src/auth/constants.js";
import { serializeTokenSet } from "../../src/auth/oauth.js";
import { runOAuthCallback } from "../../src/auth/callback.js";
import { AuthExpiredError, AuthTransportError, SecretStoreWriteError } from "../../src/auth/errors.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
    expect(joined).toMatch(/Plaud Index MCP login \(v1\.1\.1\)/);
    expect(joined).toMatch(/Signed in/);
    expect(joined).toMatch(/in-memory store/);
    expect(joined).toMatch(/plaud-mcp/);
    expect(joined).toMatch(/logged-in GUI\/Terminal/);
    expect(joined).toMatch(/8199/);
    expect(joined).not.toMatch(/stored in macOS Keychain/);
    expect(joined).not.toContain("login-access");
    expect(joined).not.toContain("login-refresh");
  });

  it("skips browser login when already signed in", async () => {
    const store = new MemorySecretStore();
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "existing-access",
        refresh_token: "existing-refresh",
        expires_at: Date.now() + 3_600_000
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
    expect(logs.join("\n")).toMatch(/Plaud Index MCP login \(v1\.1\.1\)/);
    expect(logs.join("\n")).toMatch(/Already signed in/);
    expect(logs.join("\n")).toMatch(/in-memory store/);
    expect(logs.join("\n")).not.toMatch(/Keychain/);
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
    expect(logs.join("\n")).toMatch(/Plaud Index MCP logout \(v1\.1\.1\)/);
    expect(logs.join("\n")).toMatch(/Logged out/);
    expect(logs.join("\n")).toMatch(/in-memory store/);
    expect(logs.join("\n")).not.toMatch(/Keychain/);
    expect(logs.join("\n")).not.toContain("bye-access");
  });

  it("names the file store on login when PLAUD_INDEX_HOME is set", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "plaud-login-file-"));
    const store = createSecretStore({ env: { PLAUD_INDEX_HOME: home }, platform: "linux" });
    const logs: string[] = [];
    const code = await runLoginCommand({
      env: { PLAUD_INDEX_HOME: home },
      argv: ["node", "cli.js", "login"],
      store,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/access-token") && !url.includes("refresh")) {
          return new Response(
            JSON.stringify({
              access_token: "file-access",
              refresh_token: "file-refresh",
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
      },
      openBrowser: () => {},
      runCallback: async (opts) => {
        await opts.exchangeCode("auth-code");
        return { status: "success" };
      },
      log: (m) => logs.push(m)
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/file store/);
    expect(logs.join("\n")).toContain(home);
    expect(logs.join("\n")).toMatch(/logged-in GUI\/Terminal/);
    expect(logs.join("\n")).not.toMatch(/stored in macOS Keychain/);
  });

  it("maps transport failures away from the auth-expired copy", () => {
    expect(describeAuthFailure(new AuthExpiredError())).toBe(RELLOGIN_MESSAGE);
    expect(describeAuthFailure(new AuthTransportError("Plaud token refresh failed (503)."))).toBe(
      AUTH_TRANSIENT_MESSAGE
    );
    expect(describeAuthFailure(new AuthTransportError("Plaud token refresh failed (503)."))).not.toMatch(
      /auth expired/i
    );
    expect(describeAuthFailure(new SecretStoreWriteError())).toMatch(/Keychain write failed/);
    expect(describeAuthFailure(new SecretStoreWriteError())).not.toMatch(/Token exchange failed/i);
  });

  it("prints Mini host notes on login --help", async () => {
    const logs: string[] = [];
    const code = await runLoginCommand({
      argv: ["node", "cli.js", "login", "--help"],
      log: (m) => logs.push(m),
      runCallback: async () => {
        throw new Error("should not start OAuth for --help");
      }
    });
    expect(code).toBe(0);
    const joined = logs.join("\n");
    expect(joined).toMatch(/Plaud Index MCP login \(v1\.1\.1\)/);
    expect(joined).toMatch(/signed into Plaud before Allow/);
    expect(joined).toMatch(/2 minutes/);
    expect(joined).toMatch(/8199/);
    expect(joined).toMatch(/logged-in GUI\/Terminal/);
    expect(joined).toMatch(/not via LaunchAgent/);
  });

  it("reports Keychain write failure after a successful token exchange", async () => {
    const store = new MemorySecretStore();
    store.set = async () => {
      throw new SecretStoreWriteError();
    };
    const logs: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/access-token") && !url.includes("refresh")) {
        return new Response(
          JSON.stringify({
            access_token: "persist-access",
            refresh_token: "persist-refresh",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200 }
        );
      }
      return new Response("nope", { status: 404 });
    };
    const code = await runLoginCommand({
      argv: ["node", "cli.js", "login", "--no-browser"],
      store,
      fetchImpl,
      openBrowser: () => {},
      runCallback: async (opts) => {
        try {
          await opts.exchangeCode("auth-code");
          return { status: "success" };
        } catch (err) {
          return {
            status: "persist-failed",
            error: err instanceof Error ? err : new Error(String(err))
          };
        }
      },
      log: (m) => logs.push(m)
    });
    expect(code).toBe(1);
    const joined = logs.join("\n");
    expect(joined).toMatch(/Keychain write failed/);
    expect(joined).toMatch(/connection refused/);
    expect(joined).not.toMatch(/Token exchange failed/i);
    expect(joined).not.toContain("persist-access");
    expect(joined).not.toContain("persist-refresh");
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

  it("shows Keychain write failed on the callback page when persist fails after exchange", async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const pending = runOAuthCallback({
      port,
      expectedState: "persist-state",
      timeoutMs: 5000,
      postSuccessDelayMs: 10,
      onListening: () => listening(),
      exchangeCode: async () => {
        throw new SecretStoreWriteError();
      }
    });
    await Promise.race([
      ready,
      pending.then((r) => {
        throw new Error(`callback ended before listen: ${r.status} ${r.error?.message ?? ""}`);
      })
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=good-code&state=persist-state`);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toMatch(/Keychain write failed/);
    expect(html).not.toMatch(/Token exchange failed/);
    expect(html).not.toContain("good-code");

    const result = await pending;
    expect(result.status).toBe("persist-failed");
    expect(result.error).toBeInstanceOf(SecretStoreWriteError);
  });

  it("keeps Token exchange failed for OAuth HTTP failures", async () => {
    const port = 18000 + Math.floor(Math.random() * 2000);
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const pending = runOAuthCallback({
      port,
      expectedState: "exchange-state",
      timeoutMs: 5000,
      postSuccessDelayMs: 10,
      onListening: () => listening(),
      exchangeCode: async () => {
        throw new Error("token endpoint 400 invalid_grant");
      }
    });
    await Promise.race([
      ready,
      pending.then((r) => {
        throw new Error(`callback ended before listen: ${r.status} ${r.error?.message ?? ""}`);
      })
    ]);

    const res = await fetch(`http://127.0.0.1:${port}/auth/callback?code=bad-code&state=exchange-state`);
    expect(res.status).toBe(500);
    const html = await res.text();
    expect(html).toMatch(/Token exchange failed/);
    expect(html).not.toMatch(/Keychain write failed/);

    const result = await pending;
    expect(result.status).toBe("exchange-failed");
  });
});
