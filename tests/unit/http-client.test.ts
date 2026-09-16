import { describe, expect, it } from "vitest";
import { HttpPlaudClient } from "../../src/plaud/httpClient.js";

describe("HttpPlaudClient", () => {
  it("does not include the token in thrown errors", async () => {
    const secret = "test-token-value-not-a-real-secret";
    const client = new HttpPlaudClient({
      token: secret,
      baseUrl: "https://api.plaud.ai",
      fetchImpl: async () =>
        new Response("nope", { status: 401, statusText: "Unauthorized" }) as Response
    });
    await expect(client.listFiles()).rejects.toThrow(/Plaud API 401/);
    await expect(client.listFiles()).rejects.not.toThrow(secret);
  });

  it("loadRecord fetches the file payload once when notes and transcript are inline", async () => {
    const urls: string[] = [];
    const client = new HttpPlaudClient({
      token: "x",
      baseUrl: "https://api.plaud.ai",
      fetchImpl: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/file/detail/file-1") || url.endsWith("/files/file-1")) {
          return new Response(
            JSON.stringify({
              id: "file-1",
              name: "Standup",
              note_list: [{ title: "Summary", data_content: "Ship it." }],
              source_list: [{ speaker: "Alice", text: "Let's ship it." }]
            }),
            { status: 200 }
          );
        }
        return new Response("nope", { status: 404 });
      }
    });
    const record = await client.loadRecord("file-1");
    expect(record.notes[0]?.markdown).toBe("Ship it.");
    expect(record.transcriptText).toContain("Let's ship it.");
    const fileFetches = urls.filter((u) => u.endsWith("/file/detail/file-1") || u.endsWith("/files/file-1"));
    expect(fileFetches).toHaveLength(1);
    expect(urls.filter((u) => u.includes("/transcript") || u.includes("/note"))).toHaveLength(0);
  });

  it("refuses path-like file ids", async () => {
    const client = new HttpPlaudClient({ token: "x", fetchImpl: async () => new Response("{}") as Response });
    await expect(client.getFile("../etc/passwd")).rejects.toThrow(/Invalid Plaud file id/);
  });
});
