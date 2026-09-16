import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  KeychainSecretStore,
  keychainSecurityWriteArgs,
  MemorySecretStore,
  writeKeychainPassword,
  type SpawnImpl
} from "../../src/auth/secretStore.js";
import { KEYCHAIN_ACCOUNT_OAUTH, KEYCHAIN_SERVICE, KEYCHAIN_WRITE_FAILED_MESSAGE } from "../../src/auth/constants.js";
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

describe("Keychain secret write", () => {
  it("hands the token to security add-generic-password on stdin (-w -), not argv", async () => {
    const secret = ["kc", "token", "value"].join("-");
    const { spawnImpl, calls } = captureSpawn([0]);
    await writeKeychainPassword({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: secret,
      spawnImpl
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/usr/bin/security");
    expect(calls[0].args).toEqual(
      keychainSecurityWriteArgs({ service: KEYCHAIN_SERVICE, account: KEYCHAIN_ACCOUNT_OAUTH })
    );
    expect(calls[0].args).toContain("add-generic-password");
    expect(calls[0].args).toContain("-w");
    expect(calls[0].args).toContain("-");
    expect(calls[0].args.join(" ")).not.toContain(secret);
    expect(calls[0].args.join(" ")).not.toMatch(/osascript|JavaScript|SecItemAdd/);
    expect(calls[0].stdin).toBe(secret);
  });

  it("retries with -U when the generic password already exists", async () => {
    const secret = ["update", "token", "value"].join("-");
    const { spawnImpl, calls } = captureSpawn([1, 0]);
    await writeKeychainPassword({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: secret,
      spawnImpl
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).not.toContain("-U");
    expect(calls[1].args).toEqual(
      keychainSecurityWriteArgs({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        update: true
      })
    );
    expect(calls[1].args).toContain("-U");
    expect(calls[1].stdin).toBe(secret);
    expect(calls[0].args.join(" ")).not.toContain(secret);
    expect(calls[1].args.join(" ")).not.toContain(secret);
  });

  it("KeychainSecretStore.set uses security CLI and does not put the secret on argv", async () => {
    const secret = ["store", "token", "value"].join("-");
    const { spawnImpl, calls } = captureSpawn([0]);
    const store = new KeychainSecretStore(KEYCHAIN_SERVICE, "/usr/bin/security", spawnImpl);
    await store.set(KEYCHAIN_ACCOUNT_OAUTH, secret);
    expect(calls[0].command).toBe("/usr/bin/security");
    expect(calls[0].args.join(" ")).not.toContain(secret);
    expect(calls[0].stdin).toBe(secret);
    expect(store.describe()).toMatch(/macOS Keychain/);
  });

  it("does not crash with uncaught EPIPE if security exits before stdin drain", async () => {
    const { spawnImpl } = captureSpawn(["epipe", "epipe"]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: ["pipe", "token"].join("-"),
        spawnImpl
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SecretStoreWriteError);
      expect((err as Error).message).toMatch(/Keychain write failed/);
      expect((err as Error).message).toContain(KEYCHAIN_WRITE_FAILED_MESSAGE.slice(0, 40));
      return true;
    });
  });

  it("throws SecretStoreWriteError (not a generic token-exchange error) when both add and update fail", async () => {
    const { spawnImpl, calls } = captureSpawn([2, 3]);
    await expect(
      writeKeychainPassword({
        service: KEYCHAIN_SERVICE,
        account: KEYCHAIN_ACCOUNT_OAUTH,
        value: ["fail", "token"].join("-"),
        spawnImpl
      })
    ).rejects.toBeInstanceOf(SecretStoreWriteError);
    expect(calls).toHaveLength(2);
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
