import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  KeychainSecretStore,
  keychainReadBackMatches,
  keychainSecurityInteractiveArgs,
  keychainSecurityStdinCommand,
  MemorySecretStore,
  quoteSecurityCliWord,
  SECURITY_INTERACTIVE_LINE_MAX,
  securityArgvUsesLiteralDashPassword,
  securityInteractiveCommandFits,
  tokenizeSecurityInteractiveLine,
  writeKeychainPassword,
  type ExecFileAsync,
  type SpawnImpl
} from "../../src/auth/secretStore.js";
import {
  KEYCHAIN_ACCOUNT_OAUTH,
  KEYCHAIN_LINE_TOO_LONG_MESSAGE,
  KEYCHAIN_READBACK_FAILED_MESSAGE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_WRITE_FAILED_MESSAGE
} from "../../src/auth/constants.js";
import { SecretStoreWriteError } from "../../src/auth/errors.js";
import { PlaudTokenStore } from "../../src/auth/tokenStore.js";
import { serializeTokenSet } from "../../src/auth/oauth.js";

function captureSpawn(exits: Array<number | "epipe"> = [0]): {
  spawnImpl: SpawnImpl;
  calls: Array<{ command: string; args: string[]; stdin: string }>;
} {
  const calls: Array<{ command: string; args: string[]; stdin: string }> = [];
  let i = 0;
  const spawnImpl: SpawnImpl = (command, args) => {
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const call = { command, args: [...args], stdin: "" };
    calls.push(call);
    const child = new EventEmitter() as ChildProcess;
    child.stdin = stdin as ChildProcess["stdin"];
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    const exit = exits[i++] ?? 1;
    if (exit === "epipe") {
      stdin.write = (() => {
        const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        queueMicrotask(() => {
          stdin.emit("error", err);
          child.emit("close", 1);
        });
        return false;
      }) as typeof stdin.write;
      return child;
    }
    stdin.on("finish", () => {
      call.stdin = Buffer.concat(chunks).toString("utf8");
      child.emit("close", exit);
    });
    return child;
  };
  return { spawnImpl, calls };
}

function execFileReturning(stored: string): ExecFileAsync {
  return async (_file, args) => {
    if (args.includes("find-generic-password") && args.includes("-w")) {
      return { stdout: `${stored}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
}

describe("Keychain secret write", () => {
  it("never treats -w - as stdin (Apple stores the character dash)", () => {
    expect(securityArgvUsesLiteralDashPassword(["add-generic-password", "-w", "-"])).toBe(true);
    expect(securityArgvUsesLiteralDashPassword(keychainSecurityInteractiveArgs())).toBe(false);
    expect(keychainSecurityInteractiveArgs()).toEqual(["-i"]);
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/auth/secretStore.ts"),
      "utf8"
    );
    expect(src).not.toMatch(/"-w",\s*"-"/);
    expect(src).not.toMatch(/-w -"/);
  });

  it("quotes for security -i (\\\\ and \\') not POSIX shell '\\'' concatenation", () => {
    expect(quoteSecurityCliWord("plain")).toBe("'plain'");
    expect(quoteSecurityCliWord("a'b")).toBe("'a\\'b'");
    expect(quoteSecurityCliWord("a'b")).not.toBe("'a'\\''b'");
    expect(quoteSecurityCliWord("a\\b")).toBe("'a\\\\b'");
    expect(quoteSecurityCliWord("a\\'b")).toBe("'a\\\\\\'b'");
    const samples = ["plain", "a'b", "a\\b", "a\\'b", '{"k":"v\'"}', "it's", "", "space in json"];
    for (const sample of samples) {
      const quoted = quoteSecurityCliWord(sample);
      const tokens = tokenizeSecurityInteractiveLine(`cmd ${quoted}\n`);
      expect(tokens).toEqual(["cmd", sample]);
    }
    const json = serializeTokenSet({ access_token: "x'y\\z", refresh_token: "r" });
    const line = keychainSecurityStdinCommand({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: json
    });
    const words = tokenizeSecurityInteractiveLine(line);
    expect(words[0]).toBe("add-generic-password");
    expect(words.at(-1)).toBe(json);
    expect(words).toContain(KEYCHAIN_SERVICE);
    expect(words).toContain(KEYCHAIN_ACCOUNT_OAUTH);
  });

  it("preflight-rejects security -i commands at the 4096-byte line limit before spawn", async () => {
    const { spawnImpl, calls } = captureSpawn([0]);
    const oversized = "A".repeat(SECURITY_INTERACTIVE_LINE_MAX);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: oversized,
        spawnImpl,
        readBack: async () => {
          throw new Error("read-back should not run after preflight");
        }
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SecretStoreWriteError);
      expect((err as Error).message).toMatch(/Keychain write failed/);
      expect((err as Error).message).toContain(KEYCHAIN_LINE_TOO_LONG_MESSAGE.slice(0, 40));
      expect((err as Error).message).toMatch(/4096/);
      expect((err as Error).message).not.toContain(oversized);
      expect((err as Error).message).not.toMatch(/Token exchange failed/i);
      return true;
    });
    expect(calls).toHaveLength(0);

    const fitting = serializeTokenSet({ access_token: "fits" });
    const cmd = keychainSecurityStdinCommand({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: fitting,
      update: true
    });
    expect(securityInteractiveCommandFits(cmd)).toBe(true);
    expect(Buffer.byteLength(cmd, "utf8")).toBeLessThan(SECURITY_INTERACTIVE_LINE_MAX);
  });

  it("feeds add-generic-password -w '<secret>' to security -i stdin, not argv", async () => {
    const secret = serializeTokenSet({
      access_token: ["kc", "token"].join("-"),
      refresh_token: ["kc", "refresh"].join("-")
    });
    const { spawnImpl, calls } = captureSpawn([0]);
    await writeKeychainPassword({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: secret,
      spawnImpl,
      readBack: async () => secret
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/usr/bin/security");
    expect(calls[0].args).toEqual(["-i"]);
    expect(securityArgvUsesLiteralDashPassword(calls[0].args)).toBe(false);
    expect(calls[0].args.join(" ")).not.toContain(secret);
    expect(calls[0].args).not.toContain("-w");
    expect(calls[0].args).not.toContain("-");
    expect(calls[0].stdin).toBe(
      keychainSecurityStdinCommand({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: secret
      })
    );
    expect(calls[0].stdin).toContain(`-w ${quoteSecurityCliWord(secret)}`);
    expect(calls[0].stdin).not.toMatch(/-w\s+-(?:\s|$)/);
    expect(calls[0].stdin).toContain(secret);
    expect(calls[0].stdin).toMatch(/add-generic-password/);
  });

  it("retries with -U on stdin when the generic password already exists", async () => {
    const secret = serializeTokenSet({ access_token: ["update", "token"].join("-") });
    const { spawnImpl, calls } = captureSpawn([1, 0]);
    await writeKeychainPassword({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: secret,
      spawnImpl,
      readBack: async () => secret
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(["-i"]);
    expect(calls[1].args).toEqual(["-i"]);
    expect(calls[0].stdin).not.toContain(" -U ");
    expect(calls[1].stdin).toContain(" -U ");
    expect(calls[1].stdin).toContain(secret);
    expect(securityArgvUsesLiteralDashPassword(calls[0].args)).toBe(false);
    expect(securityArgvUsesLiteralDashPassword(calls[1].args)).toBe(false);
  });

  it("KeychainSecretStore.set uses security -i and verifies read-back", async () => {
    const secret = serializeTokenSet({ access_token: ["store", "token"].join("-") });
    const { spawnImpl, calls } = captureSpawn([0]);
    const store = new KeychainSecretStore(
      KEYCHAIN_SERVICE,
      "/usr/bin/security",
      spawnImpl,
      execFileReturning(secret)
    );
    await store.set(KEYCHAIN_ACCOUNT_OAUTH, secret);
    expect(calls[0].args).toEqual(["-i"]);
    expect(calls[0].args.join(" ")).not.toContain(secret);
    expect(calls[0].stdin).toContain(secret);
    expect(await store.get(KEYCHAIN_ACCOUNT_OAUTH)).toBe(secret);
    expect(store.describe()).toMatch(/macOS Keychain/);
  });

  it("fails login persist when read-back is the literal dash from -w -", async () => {
    const secret = serializeTokenSet({ access_token: ["real", "token"].join("-") });
    const { spawnImpl } = captureSpawn([0]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: secret,
        spawnImpl,
        readBack: async () => "-"
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SecretStoreWriteError);
      expect((err as Error).message).toMatch(/Keychain write failed/);
      expect((err as Error).message).toContain(KEYCHAIN_READBACK_FAILED_MESSAGE.slice(0, 40));
      expect((err as Error).message).toMatch(/literal '-'/);
      expect((err as Error).message).not.toMatch(/Token exchange failed/i);
      expect((err as Error).message).not.toContain(secret);
      return true;
    });
  });

  it("fails when read-back is empty", async () => {
    const secret = serializeTokenSet({ access_token: ["empty", "check"].join("-") });
    const { spawnImpl } = captureSpawn([0]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: secret,
        spawnImpl,
        readBack: async () => null
      })
    ).rejects.toBeInstanceOf(SecretStoreWriteError);
  });

  it("KeychainSecretStore.set fails when find-generic-password returns dash", async () => {
    const secret = serializeTokenSet({ access_token: ["dash", "store"].join("-") });
    const { spawnImpl } = captureSpawn([0]);
    const store = new KeychainSecretStore(
      KEYCHAIN_SERVICE,
      "/usr/bin/security",
      spawnImpl,
      execFileReturning("-")
    );
    await expect(store.set(KEYCHAIN_ACCOUNT_OAUTH, secret)).rejects.toBeInstanceOf(SecretStoreWriteError);
  });

  it("does not crash with uncaught EPIPE if security exits before stdin drain", async () => {
    const { spawnImpl } = captureSpawn(["epipe", "epipe"]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: serializeTokenSet({ access_token: ["pipe", "token"].join("-") }),
        spawnImpl,
        readBack: async () => {
          throw new Error("read-back should not run after write failure");
        }
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SecretStoreWriteError);
      expect((err as Error).message).toMatch(/Keychain write failed/);
      expect((err as Error).message).toContain(KEYCHAIN_WRITE_FAILED_MESSAGE.slice(0, 40));
      return true;
    });
  });

  it("throws SecretStoreWriteError when both add and update fail", async () => {
    const { spawnImpl, calls } = captureSpawn([2, 3]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: serializeTokenSet({ access_token: ["fail", "token"].join("-") }),
        spawnImpl,
        readBack: async () => "-"
      })
    ).rejects.toBeInstanceOf(SecretStoreWriteError);
    expect(calls).toHaveLength(2);
  });

  it("keychainReadBackMatches rejects dash and empty", () => {
    const token = serializeTokenSet({ access_token: "abc" });
    expect(keychainReadBackMatches(token, token)).toBe(true);
    expect(keychainReadBackMatches(token, "-")).toBe(false);
    expect(keychainReadBackMatches(token, "")).toBe(false);
    expect(keychainReadBackMatches(token, null)).toBe(false);
    expect(keychainReadBackMatches(token, "other")).toBe(false);
  });
});

describe("token store persist errors", () => {
  it("wraps non-Keychain store.set failures as SecretStoreWriteError", async () => {
    const store = new MemorySecretStore();
    store.set = async () => {
      throw new Error("disk full");
    };
    const tokens = new PlaudTokenStore(store);
    await expect(
      tokens.save(JSON.parse(serializeTokenSet({ access_token: "persist-access", refresh_token: "persist-refresh" })))
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SecretStoreWriteError);
      expect((err as Error).message).toMatch(/Token store write failed/);
      expect((err as Error).message).toMatch(/disk full/);
      expect((err as Error).message).not.toMatch(/Token exchange failed/i);
      return true;
    });
  });
});
