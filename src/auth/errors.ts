import { KEYCHAIN_WRITE_FAILED_MESSAGE, RELLOGIN_MESSAGE } from "./constants.js";

export class AuthExpiredError extends Error {
  readonly code = "AUTH_EXPIRED";

  constructor(message: string = RELLOGIN_MESSAGE) {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export class AuthTransportError extends Error {
  readonly code = "AUTH_TRANSPORT";

  constructor(message: string) {
    super(message);
    this.name = "AuthTransportError";
  }
}

export class SecretStoreWriteError extends Error {
  readonly code = "SECRET_STORE_WRITE";

  constructor(message: string = KEYCHAIN_WRITE_FAILED_MESSAGE) {
    super(message);
    this.name = "SecretStoreWriteError";
  }
}

export function isSecretStoreWriteError(err: unknown): err is SecretStoreWriteError {
  return (
    err instanceof SecretStoreWriteError || (err instanceof Error && err.name === "SecretStoreWriteError")
  );
}

export function isAuthExpiredError(err: unknown): boolean {
  return err instanceof AuthExpiredError || (err instanceof Error && err.name === "AuthExpiredError");
}

export function isTransportError(err: unknown): boolean {
  if (err instanceof AuthTransportError) {
    return true;
  }
  const e = err instanceof Error ? err : undefined;
  const msg = e ? e.message : String(err ?? "");
  const name = e ? e.name : "";
  if (name === "AbortError" || /\btimeout\b|ETIMEDOUT/i.test(msg)) {
    return true;
  }
  return (
    err instanceof TypeError ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|network/i.test(msg)
  );
}
