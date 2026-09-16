import { describe, expect, it } from "vitest";
import { AUTH_TRANSIENT_MESSAGE, RELLOGIN_MESSAGE } from "../../src/auth/constants.js";
import { createAuthNoticeLog } from "../../src/auth/logOnce.js";

describe("createAuthNoticeLog", () => {
  it("dedupes re-login copy until an index cycle completes", () => {
    const logs: string[] = [];
    const log = createAuthNoticeLog((m) => logs.push(m));
    log(RELLOGIN_MESSAGE);
    log(`Skipping file-1: ${RELLOGIN_MESSAGE}`);
    log(RELLOGIN_MESSAGE);
    expect(logs).toEqual([RELLOGIN_MESSAGE]);
    log("Index cycle complete: examined=1 upserted=1 skipped=0 deleted=0 model=mock");
    log(RELLOGIN_MESSAGE);
    expect(logs.filter((m) => m === RELLOGIN_MESSAGE)).toHaveLength(2);
  });

  it("dedupes transient auth copy separately from expiry", () => {
    const logs: string[] = [];
    const log = createAuthNoticeLog((m) => logs.push(m));
    log(AUTH_TRANSIENT_MESSAGE);
    log(AUTH_TRANSIENT_MESSAGE);
    log(RELLOGIN_MESSAGE);
    expect(logs).toEqual([AUTH_TRANSIENT_MESSAGE, RELLOGIN_MESSAGE]);
  });
});
