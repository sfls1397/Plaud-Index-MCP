import { AUTH_TRANSIENT_MESSAGE, RELLOGIN_MESSAGE } from "./constants.js";

export function authNoticeKey(message: string): string | null {
  if (message.includes(RELLOGIN_MESSAGE) || /Plaud auth expired/i.test(message)) {
    return RELLOGIN_MESSAGE;
  }
  if (message.includes(AUTH_TRANSIENT_MESSAGE) || message.includes("Cannot reach Plaud")) {
    return AUTH_TRANSIENT_MESSAGE;
  }
  return null;
}

export function isAuthNotice(message: string): boolean {
  return authNoticeKey(message) !== null;
}

/**
 * Log auth-expired / transient-auth notices once until a successful index cycle.
 */
export function createAuthNoticeLog(log: (msg: string) => void): (msg: string) => void {
  const seen = new Set<string>();
  return (msg: string) => {
    const key = authNoticeKey(msg);
    if (key) {
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
    } else if (/Index cycle complete/.test(msg)) {
      seen.clear();
    }
    log(msg);
  };
}
