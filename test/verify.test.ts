import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeWebhookSecret, verifyWebhook } from "../src/webhooks/verify.ts";
import { makeSecret, sampleJob, tcEnvelope, tcHeaders, tcSignature } from "./helpers/tc-signer.ts";

const NOW = new Date("2026-11-17T03:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

async function signedDelivery(secret = makeSecret()) {
  // Unicode on purpose: a verifier that re-serialised or mis-decoded the body would fail.
  const job = sampleJob({ title: "Batterie – Größe 13.5 kWh ✓", notes: "Line\nbreak   and \"quotes\"" });
  const body = JSON.stringify(tcEnvelope({ eventId: "evt_1f0c", type: "job.status_changed", job, changes: { job_status: { from: "OPEN", to: "ASSIGNED" } } }));
  const headers = await tcHeaders({ webhookId: "evt_1f0c", body, secret, now: NOW });
  return { secret, body, headers };
}

describe("verifyWebhook", () => {
  it("accepts a delivery signed the way TC signs it", async () => {
    const { secret, body, headers } = await signedDelivery();
    const result = verifyWebhook({ secret, headers, rawBody: Buffer.from(body, "utf8"), nowSeconds: NOW_S });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.webhookId, "evt_1f0c");
      assert.equal(result.timestamp, NOW_S);
    }
  });

  it("matches the published Standard Webhooks test vector", () => {
    // From the Standard Webhooks specification; also checked with openssl when this test was written.
    const result = verifyWebhook({
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      headers: {
        "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
        "webhook-timestamp": "1614265330",
        "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
      },
      rawBody: '{"test": 2432232314}',
      nowSeconds: 1614265330,
    });
    assert.equal(result.ok, true);
  });

  it("refuses a tampered body", async () => {
    const { secret, body, headers } = await signedDelivery();
    const tampered = body.replace('"ASSIGNED"', '"CANCELLED"');
    assert.notEqual(tampered, body);
    const result = verifyWebhook({ secret, headers, rawBody: tampered, nowSeconds: NOW_S });
    assert.deepEqual(result.ok ? null : result.reason, "no_matching_signature");
  });

  it("refuses a body that was parsed and re-serialised (verify the RAW bytes)", async () => {
    const { secret, body, headers } = await signedDelivery();
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const result = verifyWebhook({ secret, headers, rawBody: reserialised, nowSeconds: NOW_S });
    assert.equal(result.ok, false);
  });

  it("refuses the wrong secret", async () => {
    const { body, headers } = await signedDelivery();
    const result = verifyWebhook({ secret: makeSecret(), headers, rawBody: body, nowSeconds: NOW_S });
    assert.equal(result.ok ? null : result.reason, "no_matching_signature");
  });

  it("refuses a timestamp more than 5 minutes old or ahead", async () => {
    const { secret, body, headers } = await signedDelivery();
    const old = verifyWebhook({ secret, headers, rawBody: body, nowSeconds: NOW_S + 301 });
    assert.equal(old.ok ? null : old.reason, "timestamp_out_of_tolerance");
    const ahead = verifyWebhook({ secret, headers, rawBody: body, nowSeconds: NOW_S - 301 });
    assert.equal(ahead.ok ? null : ahead.reason, "timestamp_out_of_tolerance");
    // Exactly at the edge is still accepted, as TC's own check does.
    assert.equal(verifyWebhook({ secret, headers, rawBody: body, nowSeconds: NOW_S + 300 }).ok, true);
  });

  it("accepts either signature while TC dual-signs during secret rotation", async () => {
    const newSecret = makeSecret();
    const oldSecret = makeSecret();
    const body = JSON.stringify(tcEnvelope({ eventId: "evt_rot", type: "job.created", job: sampleJob() }));
    const headers = await tcHeaders({
      webhookId: "evt_rot",
      body,
      secret: newSecret,
      previousSecret: oldSecret,
      previousExpiresAt: new Date(NOW.getTime() + 3600_000),
      now: NOW,
    });
    assert.equal(headers["webhook-signature"]!.split(" ").length, 2);
    // A receiver still holding the old secret, and one already on the new secret, both accept.
    assert.equal(verifyWebhook({ secret: oldSecret, headers, rawBody: body, nowSeconds: NOW_S }).ok, true);
    assert.equal(verifyWebhook({ secret: newSecret, headers, rawBody: body, nowSeconds: NOW_S }).ok, true);
    assert.equal(verifyWebhook({ secret: makeSecret(), headers, rawBody: body, nowSeconds: NOW_S }).ok, false);
  });

  it("accepts a valid entry wherever it sits among other entries", async () => {
    const { secret, body, headers } = await signedDelivery();
    const good = headers["webhook-signature"]!;
    for (const sig of [`v1,AAAA ${good}`, `v2,whatever ${good}`, `${good}   v1,bm90LXRoaXM=`, `garbage ${good}`]) {
      const result = verifyWebhook({ secret, headers: { ...headers, "webhook-signature": sig }, rawBody: body, nowSeconds: NOW_S });
      assert.equal(result.ok, true, sig);
    }
  });

  it("refuses malformed or missing headers without throwing", async () => {
    const { secret, body, headers } = await signedDelivery();
    const sig = headers["webhook-signature"]!.slice(3);
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...headers, "webhook-signature": undefined }, "missing_headers"],
      [{ ...headers, "webhook-id": undefined }, "missing_headers"],
      [{ ...headers, "webhook-timestamp": undefined }, "missing_headers"],
      [{ ...headers, "webhook-signature": "" }, "missing_headers"],
      [{ ...headers, "webhook-timestamp": "17e8" }, "invalid_timestamp"],
      [{ ...headers, "webhook-timestamp": "-5" }, "invalid_timestamp"],
      [{ ...headers, "webhook-signature": sig }, "no_matching_signature"], // no "v1," prefix
      [{ ...headers, "webhook-signature": `v2,${sig}` }, "no_matching_signature"],
      [{ ...headers, "webhook-signature": "v1," }, "no_matching_signature"],
      [{ ...headers, "webhook-signature": "v1,!!!not-base64!!!" }, "no_matching_signature"],
      [{ ...headers, "webhook-signature": `v1,${sig.slice(0, -4)}` }, "no_matching_signature"], // truncated
    ];
    for (const [h, reason] of cases) {
      const result = verifyWebhook({ secret, headers: h, rawBody: body, nowSeconds: NOW_S });
      assert.equal(result.ok ? null : result.reason, reason, JSON.stringify(h));
    }
  });

  it("refuses a signature made over a different webhook-id", async () => {
    const { secret, body, headers } = await signedDelivery();
    const result = verifyWebhook({ secret, headers: { ...headers, "webhook-id": "evt_other" }, rawBody: body, nowSeconds: NOW_S });
    assert.equal(result.ok, false);
  });

  it("works with a Headers object too", async () => {
    const { secret, body, headers } = await signedDelivery();
    assert.equal(verifyWebhook({ secret, headers: new Headers(headers), rawBody: body, nowSeconds: NOW_S }).ok, true);
  });

  it("matches TC's signature string exactly (same bytes as the TC-style signer)", async () => {
    const secret = makeSecret();
    const sig = await tcSignature(secret, "evt_x", NOW_S, "{}");
    const result = verifyWebhook({
      secret,
      headers: { "webhook-id": "evt_x", "webhook-timestamp": String(NOW_S), "webhook-signature": sig },
      rawBody: "{}",
      nowSeconds: NOW_S,
    });
    assert.equal(result.ok, true);
  });
});

describe("the TC-style test signer", () => {
  it("produces the published Standard Webhooks test vector (the scheme TC signs with)", async () => {
    const sig = await tcSignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
    assert.equal(sig, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("adds the previous secret's signature only while it is unexpired, and never twice", async () => {
    const [current, previous] = [makeSecret(), makeSecret()];
    const base = { webhookId: "evt_r", body: "{}", secret: current, now: NOW };
    const one = (await tcHeaders(base))["webhook-signature"]!;
    assert.equal(one, await tcSignature(current, "evt_r", NOW_S, "{}"));
    const live = await tcHeaders({ ...base, previousSecret: previous, previousExpiresAt: new Date(NOW.getTime() + 1000) });
    assert.equal(live["webhook-signature"], `${one} ${await tcSignature(previous, "evt_r", NOW_S, "{}")}`);
    const expired = await tcHeaders({ ...base, previousSecret: previous, previousExpiresAt: NOW });
    assert.equal(expired["webhook-signature"], one);
    const same = await tcHeaders({ ...base, previousSecret: current, previousExpiresAt: new Date(NOW.getTime() + 1000) });
    assert.equal(same["webhook-signature"], one);
  });

  it("builds the envelope as TC does: job without replayed, with client_status_label last", () => {
    const body = tcEnvelope({ eventId: "evt_e", type: "job.created", job: { ...sampleJob(), replayed: true }, statusLabel: "Booked", createdAt: "2026-11-17T00:00:00.000Z" });
    const job = (body.data as { job: Record<string, unknown> }).job;
    assert.equal("replayed" in job, false);
    assert.equal(Object.keys(job).at(-1), "client_status_label");
    assert.equal(job.client_status_label, "Booked");
    assert.deepEqual(Object.keys(body), ["id", "type", "created_at", "api_version", "data"]);
    assert.deepEqual((body.data as { changes: unknown }).changes, {});
  });
});

describe("decodeWebhookSecret", () => {
  it("rejects secrets TC would reject", () => {
    for (const bad of ["", "abc", "whsec_", "whsec_not base64", "whsec_abc", "whsec_ab=c", "sk_live_123"]) {
      assert.throws(() => decodeWebhookSecret(bad), Error, bad);
    }
  });
  it("decodes a valid secret, ignoring surrounding whitespace", () => {
    assert.equal(decodeWebhookSecret("  whsec_AAECAw==  ").toString("hex"), "00010203");
  });
});
