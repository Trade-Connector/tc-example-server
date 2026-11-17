import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIRMATION_TTL_MS, GuardError, LiveGuard } from "../src/server/live-guard.ts";

function liveGuard(now = () => Date.now()) {
  const guard = new LiveGuard({ liveAvailable: true, now });
  guard.switchTo("live", "LIVE");
  return guard;
}

const guardCode = (code: string) => (e: unknown) => e instanceof GuardError && e.code === code;

describe("LiveGuard", () => {
  it("always starts in sandbox", () => {
    assert.equal(new LiveGuard({ liveAvailable: true }).environment, "sandbox");
  });

  it("refuses to switch to live when live mode is not enabled", () => {
    const guard = new LiveGuard({ liveAvailable: false, liveUnavailableReason: "TC_ALLOW_LIVE is not true." });
    assert.throws(() => guard.switchTo("live", "LIVE"), guardCode("LIVE_NOT_AVAILABLE"));
    assert.equal(guard.environment, "sandbox");
  });

  it("needs the word LIVE to switch", () => {
    const guard = new LiveGuard({ liveAvailable: true });
    for (const typed of [undefined, "", "live", "yes", " LIVE"]) {
      assert.throws(() => guard.switchTo("live", typed), guardCode("CONFIRMATION_WORD_REQUIRED"));
    }
    guard.switchTo("live", "LIVE");
    assert.equal(guard.environment, "live");
  });

  it("lets sandbox writes through without a token", () => {
    const guard = new LiveGuard({ liveAvailable: true });
    assert.doesNotThrow(() => guard.authorizeWrite({ action: "create_job", body: { job: {} } }));
  });

  it("refuses live writes without a token", () => {
    assert.throws(() => liveGuard().authorizeWrite({ action: "create_job", body: {} }), guardCode("LIVE_CONFIRMATION_REQUIRED"));
  });

  it("accepts a token once, for exactly the action, target and body it was issued for", () => {
    const guard = liveGuard();
    const body = { reason: "customer moved", extra: { b: 2, a: 1 } };
    const { token } = guard.issue({ action: "cancel_job", target: "job-1", body, typed: "LIVE" });
    // Same body with keys in another order still matches (canonical hashing).
    guard.authorizeWrite({ action: "cancel_job", target: "job-1", body: { extra: { a: 1, b: 2 }, reason: "customer moved" }, token });
    assert.throws(() => guard.authorizeWrite({ action: "cancel_job", target: "job-1", body, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("refuses a token used for a different action, job or body, and burns it", () => {
    const guard = liveGuard();
    const issue = () => guard.issue({ action: "update_job", target: "job-1", body: { patch: { title: "A" } }, typed: "LIVE" }).token;

    let token = issue();
    assert.throws(() => guard.authorizeWrite({ action: "cancel_job", target: "job-1", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));
    assert.throws(() => guard.authorizeWrite({ action: "update_job", target: "job-1", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_INVALID"));

    token = issue();
    assert.throws(() => guard.authorizeWrite({ action: "update_job", target: "job-2", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));

    token = issue();
    assert.throws(() => guard.authorizeWrite({ action: "update_job", target: "job-1", body: { patch: { title: "B" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));
  });

  it("refuses an expired token", () => {
    let now = 1_000_000;
    const guard = liveGuard(() => now);
    const { token } = guard.issue({ action: "add_note", target: "j", body: { body: "hi" }, typed: "LIVE" });
    now += CONFIRMATION_TTL_MS + 1;
    assert.throws(() => guard.authorizeWrite({ action: "add_note", target: "j", body: { body: "hi" }, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("refuses a made-up token", () => {
    assert.throws(() => liveGuard().authorizeWrite({ action: "add_note", target: "j", body: {}, token: "forged" }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("issues tokens only in live mode, only for known actions, only with LIVE typed", () => {
    const sandbox = new LiveGuard({ liveAvailable: true });
    assert.throws(() => sandbox.issue({ action: "create_job", typed: "LIVE" }), guardCode("NOT_IN_LIVE_MODE"));
    const guard = liveGuard();
    assert.throws(() => guard.issue({ action: "drop_tables", typed: "LIVE" }), guardCode("UNKNOWN_ACTION"));
    assert.throws(() => guard.issue({ action: "create_job", typed: "live" }), guardCode("CONFIRMATION_WORD_REQUIRED"));
  });

  it("forgets outstanding tokens when switching back to sandbox", () => {
    const guard = liveGuard();
    const { token } = guard.issue({ action: "create_job", body: {}, typed: "LIVE" });
    guard.switchTo("sandbox");
    guard.switchTo("live", "LIVE");
    assert.throws(() => guard.authorizeWrite({ action: "create_job", body: {}, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });
});
