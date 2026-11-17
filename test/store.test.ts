import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setLogSink } from "../src/log.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import type { WebhookEnvelope } from "../src/webhooks/events.ts";
import { EventStore } from "../src/webhooks/store.ts";
import { sampleJob, tcEnvelope } from "./helpers/tc-signer.ts";

let dir: string;
let restoreSink: ReturnType<typeof setLogSink>;
const warnings: string[] = [];

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tc-store-"));
  restoreSink = setLogSink((level, line) => { if (level === "warn") warnings.push(line); });
});
after(async () => {
  setLogSink(restoreSink);
  await flushJsonWrites();
  await rm(dir, { recursive: true, force: true });
});

function envelope(eventId: string, type: string, job: ReturnType<typeof sampleJob> | null, changes = {}) {
  const env = tcEnvelope({ eventId, type, job, changes }) as unknown as WebhookEnvelope;
  return { envelope: env, rawBody: JSON.stringify(env) };
}

describe("EventStore", () => {
  it("dedupes on webhook-id: a repeat is recorded and flagged but not processed", async () => {
    const store = await EventStore.open(path.join(dir, "dedupe"));
    const job = sampleJob({ updated_at: "2026-11-17T01:00:00.000Z" });
    const first = await store.recordVerified({ environment: "sandbox", webhookId: "evt_1", ...envelope("evt_1", "job.created", job) });
    assert.equal(first.flags.duplicate, false);

    // The repeat carries a NEWER job; because it is a duplicate it must not be applied.
    const newer = sampleJob({ status: "ASSIGNED", updated_at: "2026-11-17T09:00:00.000Z" });
    const repeat = await store.recordVerified({ environment: "sandbox", webhookId: "evt_1", ...envelope("evt_1", "job.created", newer) });
    assert.equal(repeat.flags.duplicate, true);
    assert.equal(store.getSnapshot("sandbox", job.id)?.job.status, "OPEN");
    assert.equal(store.listEvents().length, 2);
  });

  it("does not let an older job overwrite a newer one (unordered delivery)", async () => {
    const store = await EventStore.open(path.join(dir, "order"));
    const newer = sampleJob({ status: "SCHEDULED", updated_at: "2026-11-17T05:00:00.000Z" });
    const older = sampleJob({ status: "ASSIGNED", updated_at: "2026-11-17T04:00:00.000Z" });

    await store.recordVerified({ environment: "sandbox", webhookId: "evt_new", ...envelope("evt_new", "job.status_changed", newer) });
    const late = await store.recordVerified({ environment: "sandbox", webhookId: "evt_old", ...envelope("evt_old", "job.status_changed", older) });

    assert.equal(late.flags.out_of_order, true);
    assert.equal(late.flags.duplicate, false);
    assert.equal(store.getSnapshot("sandbox", newer.id)?.job.status, "SCHEDULED");

    const newest = sampleJob({ status: "IN_PROGRESS", updated_at: "2026-11-17T06:00:00.000Z" });
    const next = await store.recordVerified({ environment: "sandbox", webhookId: "evt_newest", ...envelope("evt_newest", "job.status_changed", newest) });
    assert.equal(next.flags.out_of_order, false);
    assert.equal(store.getSnapshot("sandbox", newer.id)?.job.status, "IN_PROGRESS");
  });

  it("keeps sandbox and live snapshots apart, and dedupes per path", async () => {
    const store = await EventStore.open(path.join(dir, "envs"));
    const job = sampleJob({ is_sandbox: false });
    await store.recordVerified({ environment: "live", webhookId: "evt_x", ...envelope("evt_x", "job.created", job) });
    const again = await store.recordVerified({ environment: "sandbox", webhookId: "evt_x", ...envelope("evt_x", "job.created", sampleJob()) });
    assert.equal(again.flags.duplicate, false);
    assert.ok(store.getSnapshot("live", job.id));
    assert.ok(store.getSnapshot("sandbox", job.id));
  });

  it("flags (does not drop) a job whose is_sandbox disagrees with the path", async () => {
    const store = await EventStore.open(path.join(dir, "mismatch"));
    const event = await store.recordVerified({ environment: "live", webhookId: "evt_m", ...envelope("evt_m", "job.created", sampleJob({ is_sandbox: true })) });
    assert.equal(event.flags.environment_mismatch, true);
    assert.equal(store.listEvents()[0]?.webhook_id, "evt_m");
  });

  it("stores unknown event types and unknown statuses, flagged, without crashing", async () => {
    const store = await EventStore.open(path.join(dir, "unknown"));
    warnings.length = 0;
    const event = await store.recordVerified({
      environment: "sandbox",
      webhookId: "evt_u",
      ...envelope("evt_u", "job.teleported", sampleJob({ status: "ON_THE_MOON" })),
    });
    assert.equal(event.flags.unknown_type, true);
    assert.equal(event.flags.unknown_status, true);
    assert.equal(event.job_status, "ON_THE_MOON");
    assert.ok(warnings.some((w) => w.includes("unknown event type")));
    // PENDING_CUSTOMER_SIG is a real status, missing from TC's published spec.
    const real = await store.recordVerified({ environment: "sandbox", webhookId: "evt_p", ...envelope("evt_p", "job.status_changed", sampleJob({ status: "PENDING_CUSTOMER_SIG", updated_at: "2027-01-01T00:00:00Z" })) });
    assert.equal(real.flags.unknown_status, false);
  });

  it("never lets webhook.test (dummy job) touch snapshots", async () => {
    const store = await EventStore.open(path.join(dir, "test-event"));
    const dummy = sampleJob({ id: "00000000-0000-0000-0000-000000000000", external_reference: "TEST-WEBHOOK-001" });
    const event = await store.recordVerified({ environment: "sandbox", webhookId: "evt_t", ...envelope("evt_t", "webhook.test", dummy) });
    assert.equal(event.flags.test_event, true);
    assert.equal(store.getSnapshot("sandbox", dummy.id), null);
  });

  it("persists events, seen ids and snapshots across restarts", async () => {
    const sub = path.join(dir, "persist");
    const store = await EventStore.open(sub);
    const job = sampleJob();
    await store.recordVerified({ environment: "sandbox", webhookId: "evt_p1", ...envelope("evt_p1", "job.created", job) });
    await store.recordRejected({ environment: "sandbox", webhookId: "evt_bad", reason: "no_matching_signature", message: "x" });
    await flushJsonWrites();

    const reopened = await EventStore.open(sub);
    assert.equal(reopened.listEvents().length, 2);
    assert.ok(reopened.getSnapshot("sandbox", job.id));
    const repeat = await reopened.recordVerified({ environment: "sandbox", webhookId: "evt_p1", ...envelope("evt_p1", "job.created", job) });
    assert.equal(repeat.flags.duplicate, true);
    const file = await readFile(path.join(sub, "webhook-events.json"), "utf8");
    assert.ok(file.includes("evt_bad"));
  });

  it("lists newest first, filters by job and polls after a sequence number", async () => {
    const store = await EventStore.open(path.join(dir, "list"));
    const a = sampleJob({ id: "aaaaaaaa-0000-4000-8000-000000000001" });
    const b = sampleJob({ id: "bbbbbbbb-0000-4000-8000-000000000002" });
    const e1 = await store.recordVerified({ environment: "sandbox", webhookId: "e1", ...envelope("e1", "job.created", a) });
    await store.recordVerified({ environment: "sandbox", webhookId: "e2", ...envelope("e2", "job.created", b) });
    const e3 = await store.recordVerified({ environment: "sandbox", webhookId: "e3", ...envelope("e3", "job.status_changed", { ...a, updated_at: "2026-12-01T00:00:00Z" }) });
    assert.deepEqual(store.listEvents().map((e) => e.webhook_id), ["e3", "e2", "e1"]);
    assert.deepEqual(store.listEvents({ jobId: a.id }).map((e) => e.seq), [e3.seq, e1.seq]);
    assert.deepEqual(store.listEvents({ afterSeq: e1.seq }).map((e) => e.webhook_id), ["e3", "e2"]);
  });
});
