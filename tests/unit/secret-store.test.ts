import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  KeychainSecretStore,
  keychainWriteJxa,
  writeKeychainPassword,
  type SpawnImpl
} from "../../src/auth/secretStore.js";
import { KEYCHAIN_ACCOUNT_OAUTH, KEYCHAIN_SERVICE } from "../../src/auth/constants.js";

function captureSpawn(): { spawnImpl: SpawnImpl; captured: { command: string; args: string[]; stdin: string } } {
  const captured = { command: "", args: [] as string[], stdin: "" };
  const spawnImpl: SpawnImpl = (command, args) => {
    captured.command = command;
    captured.args = [...args];
    const stdin = new PassThrough();
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const child = new EventEmitter() as ChildProcess;
    child.stdin = stdin as ChildProcess["stdin"];
    child.stdout = new PassThrough() as ChildProcess["stdout"];
    child.stderr = new PassThrough() as ChildProcess["stderr"];
    stdin.on("finish", () => {
      captured.stdin = Buffer.concat(chunks).toString("utf8");
      child.emit("close", 0);
    });
    return child;
  };
  return { spawnImpl, captured };
}

describe("Keychain secret write", () => {
  it("hands the token to osascript on stdin, not security -w argv", async () => {
    const secret = ["kc", "token", "value"].join("-");
    const { spawnImpl, captured } = captureSpawn();
    await writeKeychainPassword({
      service: KEYCHAIN_SERVICE,
      account: KEYCHAIN_ACCOUNT_OAUTH,
      value: secret,
      spawnImpl
    });
    expect(captured.command).toBe("/usr/bin/osascript");
    expect(captured.args.join(" ")).not.toContain(secret);
    expect(captured.args.join(" ")).not.toMatch(/add-generic-password/);
    expect(captured.args).not.toContain("-w");
    expect(captured.stdin).toBe(secret);
    const jxa = keychainWriteJxa(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_OAUTH);
    expect(jxa).toContain(KEYCHAIN_SERVICE);
    expect(jxa).toContain(KEYCHAIN_ACCOUNT_OAUTH);
    expect(jxa).not.toContain(secret);
  });

  it("KeychainSecretStore.set does not put the secret on argv", async () => {
    const secret = ["store", "token", "value"].join("-");
    const { spawnImpl, captured } = captureSpawn();
    const store = new KeychainSecretStore(KEYCHAIN_SERVICE, "/usr/bin/security", spawnImpl);
    await store.set(KEYCHAIN_ACCOUNT_OAUTH, secret);
    expect(captured.args.join(" ")).not.toContain(secret);
    expect(captured.stdin).toBe(secret);
    expect(store.describe()).toMatch(/macOS Keychain/);
  });
});
