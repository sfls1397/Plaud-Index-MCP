import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpPlaudClient } from "../../src/plaud/mcpClient.js";
import { createPlaudClient } from "../../src/plaud/client.js";
import { HttpPlaudClient } from "../../src/plaud/httpClient.js";
import { MockPlaudClient } from "../../src/plaud/mockClient.js";
import { MemorySecretStore } from "../../src/auth/secretStore.js";
import { KEYCHAIN_ACCOUNT_OAUTH, RELLOGIN_MESSAGE } from "../../src/auth/constants.js";
import { serializeTokenSet } from "../../src/auth/oauth.js";
import { AuthExpiredError } from "../../src/auth/errors.js";
import type { PlaudAuthSession } from "../../src/auth/session.js";
import { resolveOAuthEndpoints } from "../../src/auth/oauth.js";
import { runOneRefresh } from "../../src/indexer/daemon.js";

function fakeSession(options: {
  token: string | null;
  refreshToken?: string;
  onRefresh?: () => Promise<string | null>;
}): PlaudAuthSession {
  let access = options.token;
  return {
    endpoints: resolveOAuthEndpoints({}),
    getAccessToken: async () => access,
    refresh: async () => {
      if (options.onRefresh) {
        const next = await options.onRefresh();
        access = next;
        return next;
      }
      throw new AuthExpiredError();
    },
    save: async () => {},
    clear: async () => {
      access = null;
    },
    peek: () => (access ? { access_token: access, refresh_token: options.refreshToken } : null)
  };
}

describe("McpPlaudClient", () => {
  it("calls the MCP third-party data plane and loads notes/transcripts", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/open/third-party/files/?page=")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "file-1", name: "Standup", created_at: "2026-09-15T15:00:00.000Z", duration: 1000 }]
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/open/third-party/files/file-1")) {
        return new Response(
          JSON.stringify({
            id: "file-1",
            name: "Standup",
            created_at: "2026-09-15T15:00:00.000Z",
            duration: 1000,
            note_list: [{ data_type: "auto_sum_note", title: "Summary", data_content: "Ship the indexer." }],
            source_list: [
              {
                data_type: "transaction",
                data_content: JSON.stringify([{ speaker: "Alice", text: "Let's ship it." }])
              }
            ]
          }),
          { status: 200 }
        );
      }
      return new Response("nope", { status: 404 });
    };
    const client = new McpPlaudClient({
      session: fakeSession({ token: "mcp-access" }),
      fetchImpl
    });
    const files = await client.listFiles({ page: 1, pageSize: 50 });
    expect(files[0]?.id).toBe("file-1");
    const record = await client.loadRecord("file-1");
    expect(record.notes[0]?.markdown).toBe("Ship the indexer.");
    expect(record.transcriptText).toContain("Let's ship it.");
    expect(urls.some((u) => u.includes("/open/third-party/files/"))).toBe(true);
    expect(urls.join("\n")).not.toContain("mcp-access");
  });

  it("refreshes once on 401 and retries without leaking the token", async () => {
    let listCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/open/third-party/files/?")) {
        listCalls += 1;
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer stale") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({ data: [{ id: "file-2", name: "Retry" }] }), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };
    const client = new McpPlaudClient({
      session: fakeSession({
        token: "stale",
        onRefresh: async () => "fresh"
      }),
      fetchImpl
    });
    const files = await client.listFiles();
    expect(files[0]?.id).toBe("file-2");
    expect(listCalls).toBe(2);
  });

  it("throws AuthExpiredError on 401 after refresh fails", async () => {
    const client = new McpPlaudClient({
      session: fakeSession({ token: "stale" }),
      fetchImpl: async () => new Response("nope", { status: 401 })
    });
    await expect(client.listFiles()).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(client.listFiles()).rejects.toThrow(RELLOGIN_MESSAGE);
  });
});

describe("createPlaudClient auth order", () => {
  it("uses mock when PLAUD_CLIENT=mock", async () => {
    const client = await createPlaudClient({ env: { PLAUD_CLIENT: "mock" } });
    expect(client).toBeInstanceOf(MockPlaudClient);
  });

  it("uses Bearer override when PLAUD_API_TOKEN is set", async () => {
    const logs: string[] = [];
    const override = ["override", "token"].join("-");
    const client = await createPlaudClient({
      env: { PLAUD_API_TOKEN: override },
      store: new MemorySecretStore(),
      log: (m) => logs.push(m)
    });
    expect(client).toBeInstanceOf(HttpPlaudClient);
    expect(logs.join("\n")).toMatch(/Bearer override/);
    expect(logs.join("\n")).not.toContain(override);
  });

  it("uses MCP OAuth when Keychain has a token set", async () => {
    const store = new MemorySecretStore();
    await store.set(
      KEYCHAIN_ACCOUNT_OAUTH,
      serializeTokenSet({
        access_token: "mcp-access",
        refresh_token: "mcp-refresh",
        expires_at: Date.now() + 60_000
      })
    );
    const client = await createPlaudClient({
      env: {},
      store,
      fetchImpl: async () => new Response(JSON.stringify({ data: [] }), { status: 200 })
    });
    expect(client).toBeInstanceOf(McpPlaudClient);
  });

  it("asks the operator to re-run login when the indexer has no credentials", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "plaud-noauth-"));
    const logs: string[] = [];
    await runOneRefresh({
      env: { PLAUD_INDEX_HOME: home, PLAUD_EMBEDDER: "mock" },
      log: (m) => logs.push(m)
    });
    expect(logs.join("\n")).toBe(RELLOGIN_MESSAGE);
  });
});
