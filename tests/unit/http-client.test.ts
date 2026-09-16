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

  it("refuses path-like file ids", async () => {
    const client = new HttpPlaudClient({ token: "x", fetchImpl: async () => new Response("{}") as Response });
    await expect(client.getFile("../etc/passwd")).rejects.toThrow(/Invalid Plaud file id/);
  });
});
