import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bodyFingerprint, CONFIRMATION_TTL_MS, GuardError, LIVE_ACTIONS, LiveGuard } from "../src/server/live-guard.ts";

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
    assert.doesNotThrow(() => guard.authorizeWrite({ environment: "sandbox", action: "create_job", body: { job: {} } }));
  });

  it("refuses live writes without a token", () => {
    assert.throws(() => liveGuard().authorizeWrite({ environment: "live", action: "create_job", body: {} }), guardCode("LIVE_CONFIRMATION_REQUIRED"));
  });

  it("accepts a token once, for exactly the action, target and body it was issued for", () => {
    const guard = liveGuard();
    const body = { reason: "customer moved", extra: { b: 2, a: 1 } };
    const { token } = guard.issue({ action: "cancel_job", target: "job-1", body, typed: "LIVE" });
    // Same body with keys in another order still matches (canonical hashing).
    guard.authorizeWrite({ environment: "live", action: "cancel_job", target: "job-1", body: { extra: { a: 1, b: 2 }, reason: "customer moved" }, token });
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "cancel_job", target: "job-1", body, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("refuses a token used for a different action, job or body, and burns it", () => {
    const guard = liveGuard();
    const issue = () => guard.issue({ action: "update_job", target: "job-1", body: { patch: { title: "A" } }, typed: "LIVE" }).token;

    let token = issue();
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "cancel_job", target: "job-1", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "update_job", target: "job-1", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_INVALID"));

    token = issue();
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "update_job", target: "job-2", body: { patch: { title: "A" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));

    token = issue();
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "update_job", target: "job-1", body: { patch: { title: "B" } }, token }), guardCode("LIVE_CONFIRMATION_MISMATCH"));
  });

  it("refuses an expired token", () => {
    let now = 1_000_000;
    const guard = liveGuard(() => now);
    const { token } = guard.issue({ action: "add_note", target: "j", body: { body: "hi" }, typed: "LIVE" });
    now += CONFIRMATION_TTL_MS + 1;
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "add_note", target: "j", body: { body: "hi" }, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("refuses a made-up token", () => {
    assert.throws(() => liveGuard().authorizeWrite({ environment: "live", action: "add_note", target: "j", body: {}, token: "forged" }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });

  it("issues tokens only in live mode, only for known actions, only with LIVE typed", () => {
    const sandbox = new LiveGuard({ liveAvailable: true });
    assert.throws(() => sandbox.issue({ action: "create_job", typed: "LIVE" }), guardCode("NOT_IN_LIVE_MODE"));
    const guard = liveGuard();
    assert.throws(() => guard.issue({ action: "drop_tables", typed: "LIVE" }), guardCode("UNKNOWN_ACTION"));
    assert.throws(() => guard.issue({ action: "create_job", typed: "live" }), guardCode("CONFIRMATION_WORD_REQUIRED"));
  });

  it("refuses a live write when the console has switched to sandbox meanwhile (409), without spending the token", () => {
    const guard = liveGuard();
    const body = { patch: { title: "A" } };
    const { token } = guard.issue({ action: "update_job", target: "job-1", body, typed: "LIVE" });
    // Simulates: the call captured "live" (and the live key), then another tab switched to sandbox.
    const switched = new LiveGuard({ liveAvailable: true });
    assert.throws(() => switched.authorizeWrite({ environment: "live", action: "update_job", target: "job-1", body, token }), guardCode("ENVIRONMENT_CHANGED"));
    assert.throws(() => switched.authorizeWrite({ environment: "live", action: "update_job", target: "job-1", body }), guardCode("ENVIRONMENT_CHANGED"));
    // The original guard still holds the token: the refusal elsewhere did not touch it.
    assert.doesNotThrow(() => guard.authorizeWrite({ environment: "live", action: "update_job", target: "job-1", body, token }));
  });

  it("refuses a sandbox write when the console has switched to live meanwhile (409)", () => {
    const guard = liveGuard();
    assert.throws(() => guard.authorizeWrite({ environment: "sandbox", action: "add_note", target: "j", body: { body: "hi" } }), guardCode("ENVIRONMENT_CHANGED"));
  });

  it("requires a token for every live call, whatever the action", () => {
    const guard = liveGuard();
    for (const action of LIVE_ACTIONS) {
      assert.throws(() => guard.authorizeWrite({ environment: "live", action, target: "j", body: {} }), guardCode("LIVE_CONFIRMATION_REQUIRED"), action);
    }
  });

  it("fingerprints bodies independently of key order, but not of values or types", () => {
    assert.equal(bodyFingerprint({ a: 1, b: { d: [1, { y: 2, x: 1 }], c: null } }), bodyFingerprint({ b: { c: null, d: [1, { x: 1, y: 2 }] }, a: 1 }));
    assert.equal(bodyFingerprint({ a: 1, skipped: undefined }), bodyFingerprint({ a: 1 }));
    assert.equal(bodyFingerprint(undefined), bodyFingerprint(null));
    assert.notEqual(bodyFingerprint({ a: 1 }), bodyFingerprint({ a: "1" }));
    assert.notEqual(bodyFingerprint({ a: [1, 2] }), bodyFingerprint({ a: [2, 1] }));
    assert.notEqual(bodyFingerprint({ "a,b": 1 }), bodyFingerprint({ a: 1, b: 1 }));
    assert.notEqual(bodyFingerprint({}), bodyFingerprint([]));
  });

  it("forgets outstanding tokens when switching back to sandbox", () => {
    const guard = liveGuard();
    const { token } = guard.issue({ action: "create_job", body: {}, typed: "LIVE" });
    guard.switchTo("sandbox");
    guard.switchTo("live", "LIVE");
    assert.throws(() => guard.authorizeWrite({ environment: "live", action: "create_job", body: {}, token }), guardCode("LIVE_CONFIRMATION_INVALID"));
  });
});
