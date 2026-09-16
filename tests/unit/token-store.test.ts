import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEYCHAIN_ACCOUNT_OAUTH, RELLOGIN_MESSAGE } from "../../src/auth/constants.js";
import { AuthExpiredError } from "../../src/auth/errors.js";
import { createAuthSession } from "../../src/auth/session.js";
import { MemorySecretStore } from "../../src/auth/secretStore.js";
import { loadOrMigrateTokenSet } from "../../src/auth/tokenStore.js";
import { serializeTokenSet } from "../../src/auth/oauth.js";

describe("token store + session", () => {
  it("migrates ~/.plaud/tokens-mcp.json into the secret store once", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plaud-migrate-"));
    const file = path.join(dir, "tokens-mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        access_token: "file-access",
        refresh_token: "file-refresh",
        token_type: "Bearer",
        expires_at: Date.now() + 60_000
      }),
      "utf8"
    );
    const store = new MemorySecretStore();
    const logs: string[] = [];
    const first = await loadOrMigrateTokenSet({
      store,
      mcpTokenPath: file,
      log: (m) => logs.push(m)
    });
    expect(first.migrated).toBe(true);
    expect(first.tokenSet?.access_token).toBe("file-access");
    expect(await store.get(KEYCHAIN_ACCOUNT_OAUTH)).toContain("file-refresh");
    expect(logs.join("\n")).toMatch(/Migrated Plaud MCP tokens/);
    expect(logs.join("\n")).not.toContain("file-access");
    expect(logs.join("\n")).not.toContain("file-refresh");

    const second = await loadOrMigrateTokenSet({ store, mcpTokenPath: file });
    expect(second.migrated).toBe(false);
    expect(second.tokenSet?.access_token).toBe("file-access");
  });

  it("refreshes when expiry is within skew and persists the new set", async () => {
    const store = new MemorySecretStore();
    const now = 5_000_000;
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "old-access",
        refresh_token: "refresh-keep",
        expires_at: now + 1_000
      })
    );
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("refresh")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({ access_token: "new-access", refresh_token: "refresh-keep", expires_in: 3600 }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected ${String(input)}`);
    };
    const session = await createAuthSession({
      store,
      fetchImpl,
      now: () => now
    });
    const token = await session.getAccessToken();
    expect(token).toBe("new-access");
    expect(refreshCalls).toBe(1);
    const stored = JSON.parse((await store.get(KEYCHAIN_ACCOUNT_OAUTH)) || "{}") as { access_token?: string };
    expect(stored.access_token).toBe("new-access");
  });

  it("does not clear tokens on refresh network errors", async () => {
    const store = new MemorySecretStore();
    const now = 5_000_000;
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "still-valid-enough",
        refresh_token: "refresh-keep",
        expires_at: now + 1_000
      })
    );
    const session = await createAuthSession({
      store,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      now: () => now
    });
    const token = await session.getAccessToken();
    expect(token).toBe("still-valid-enough");
    expect(await store.get(KEYCHAIN_ACCOUNT_OAUTH)).toContain("refresh-keep");
  });

  it("logs re-login on invalid refresh without dumping secrets", async () => {
    const store = new MemorySecretStore();
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "expired-access",
        refresh_token: "secret-refresh",
        expires_at: 1
      })
    );
    const logs: string[] = [];
    const session = await createAuthSession({
      store,
      log: (m) => logs.push(m),
      fetchImpl: async () => new Response("nope secret-refresh", { status: 401 }),
      now: () => 10_000
    });
    await expect(session.refresh()).rejects.toBeInstanceOf(AuthExpiredError);
    expect(logs.join("\n")).toBe(RELLOGIN_MESSAGE);
    expect(logs.join("\n")).not.toContain("secret-refresh");
    expect(logs.join("\n")).not.toContain("expired-access");
  });

  it("uses PLAUD_INDEX_HOME file store in tests (not Keychain)", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "plaud-file-store-"));
    mkdirSync(path.join(home, "secrets"), { recursive: true });
    const { createSecretStore } = await import("../../src/auth/secretStore.js");
    const store = createSecretStore({ env: { PLAUD_INDEX_HOME: home }, platform: "linux" });
    await store.set(KEYCHAIN_ACCOUNT_OAUTH, serializeTokenSet({ access_token: "disk-access" }));
    expect(await store.get(KEYCHAIN_ACCOUNT_OAUTH)).toContain("disk-access");
  });
});
