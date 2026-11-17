import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setLogSink } from "../src/log.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import type { WebhookEnvelope } from "../src/webhooks/events.ts";
import { EventStore, MAX_REJECTED_DELIVERIES, preciseInstant } from "../src/webhooks/store.ts";
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

  it("processes TC's retry in full after a failed write (no lost update, not waved through as a duplicate)", async () => {
    const storeDir = path.join(dir, "write-fails");
    const store = await EventStore.open(storeDir);
    const job = sampleJob({ status: "SCHEDULED", updated_at: "2026-11-17T02:00:00.000Z" });
    const delivery = { environment: "sandbox" as const, webhookId: "evt_retry", ...envelope("evt_retry", "job.scheduled", job) };

    // Force the snapshot write to fail once: a directory where the snapshot file goes.
    const snapshotFile = path.join(storeDir, "job-snapshots.json");
    await mkdir(snapshotFile, { recursive: true });
    await assert.rejects(store.recordVerified(delivery));
    await rm(snapshotFile, { recursive: true });

    // TC retries the same webhook-id: it must be processed, not flagged as a duplicate.
    const retry = await store.recordVerified(delivery);
    assert.equal(retry.flags.duplicate, false);

    // And the update must survive a restart.
    await flushJsonWrites();
    const reopened = await EventStore.open(storeDir);
    assert.equal(reopened.getSnapshot("sandbox", job.id)?.job.status, "SCHEDULED");
  });

  it("keeps no ghost entry when the event-log write fails: TC's retry is the one recorded", async () => {
    const storeDir = path.join(dir, "event-write-fails");
    const store = await EventStore.open(storeDir);
    const seen: string[] = [];
    store.onEvent((event) => seen.push(event.webhook_id ?? ""));
    const job = sampleJob({ status: "ASSIGNED", updated_at: "2026-11-17T03:00:00.000Z" });
    const delivery = { environment: "sandbox" as const, webhookId: "evt_ghost", ...envelope("evt_ghost", "job.assigned", job) };

    const eventsFile = path.join(storeDir, "webhook-events.json");
    await mkdir(eventsFile, { recursive: true });
    await assert.rejects(store.recordVerified(delivery));
    await rm(eventsFile, { recursive: true });
    assert.equal(store.listEvents().filter((e) => e.webhook_id === "evt_ghost").length, 0);
    assert.deepEqual(seen, []);

    const retry = await store.recordVerified(delivery);
    assert.equal(retry.flags.duplicate, false);
    assert.equal(store.listEvents().filter((e) => e.webhook_id === "evt_ghost").length, 1);
    assert.deepEqual(seen, ["evt_ghost"]);

    await flushJsonWrites();
    const reopened = await EventStore.open(storeDir);
    assert.equal(reopened.listEvents().filter((e) => e.webhook_id === "evt_ghost").length, 1);
    assert.equal(reopened.getSnapshot("sandbox", job.id)?.job.status, "ASSIGNED");
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

  it("orders two updates in the same millisecond by their microseconds", async () => {
    const store = await EventStore.open(path.join(dir, "micro"));
    // TC's updated_at carries microseconds. Both of these are .123 at millisecond precision.
    const newer = sampleJob({ status: "SCHEDULED", updated_at: "2026-11-17T01:00:00.123456+00:00" });
    const older = sampleJob({ status: "ASSIGNED", updated_at: "2026-11-17T01:00:00.123123+00:00" });
    await store.recordVerified({ environment: "sandbox", webhookId: "evt_us_new", ...envelope("evt_us_new", "job.status_changed", newer) });
    const late = await store.recordVerified({ environment: "sandbox", webhookId: "evt_us_old", ...envelope("evt_us_old", "job.status_changed", older) });
    assert.equal(late.flags.out_of_order, true);
    assert.equal(store.getSnapshot("sandbox", newer.id)?.job.status, "SCHEDULED");
  });

  it("reads timestamps at full precision, in any offset", () => {
    assert.equal(preciseInstant("2026-11-17T01:00:00Z"), BigInt(Date.parse("2026-11-17T01:00:00Z")) * 1_000_000n);
    assert.equal(preciseInstant("2026-11-17T01:00:00.000001Z")! - preciseInstant("2026-11-17T01:00:00Z")!, 1000n);
    assert.equal(preciseInstant("2026-11-17T11:00:00.5+10:00"), preciseInstant("2026-11-17T01:00:00.500000Z"));
    assert.ok(preciseInstant("2026-11-17T01:00:00.123456+00:00")! > preciseInstant("2026-11-17T01:00:00.123455+00:00")!);
    assert.equal(preciseInstant("not a time"), null);
    assert.equal(preciseInstant(null), null);
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
    const job = sampleJob({ is_sandbox: true });
    const event = await store.recordVerified({ environment: "live", webhookId: "evt_m", ...envelope("evt_m", "job.created", job) });
    assert.equal(event.flags.environment_mismatch, true);
    assert.equal(store.listEvents()[0]?.webhook_id, "evt_m");
    // Stored, not processed: it never becomes the live snapshot of the job.
    assert.equal(store.getSnapshot("live", job.id), null);
    assert.ok(warnings.some((w) => w.includes("is_sandbox does not match") && w.includes("not processed")));
  });

  it("stores an unknown event type without processing it (no snapshot change)", async () => {
    const store = await EventStore.open(path.join(dir, "unknown-type"));
    const job = sampleJob({ status: "OPEN", updated_at: "2026-11-17T01:00:00Z" });
    await store.recordVerified({ environment: "sandbox", webhookId: "evt_k1", ...envelope("evt_k1", "job.created", job) });
    const newer = sampleJob({ status: "ASSIGNED", updated_at: "2026-11-17T02:00:00Z" });
    const odd = await store.recordVerified({ environment: "sandbox", webhookId: "evt_k2", ...envelope("evt_k2", "job.teleported", newer) });
    assert.equal(odd.flags.unknown_type, true);
    assert.equal(odd.job_status, "ASSIGNED", "stored as received");
    assert.equal(store.getSnapshot("sandbox", job.id)?.job.status, "OPEN", "not processed");
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
    assert.ok((await readFile(path.join(sub, "webhook-rejections.json"), "utf8")).includes("evt_bad"));
    assert.ok(!(await readFile(path.join(sub, "webhook-events.json"), "utf8")).includes("evt_bad"));
    // Sequence numbers carry on after a restart, across both logs.
    const next = await reopened.recordRejected({ environment: "sandbox", webhookId: "evt_bad2", reason: "no_matching_signature", message: "x" });
    assert.ok(next.seq > Math.max(...reopened.listEvents().filter((e) => e !== next).map((e) => e.seq)));
  });

  it("keeps refused deliveries in their own small log, so junk cannot push real events out", async () => {
    const sub = path.join(dir, "flood");
    const store = await EventStore.open(sub);
    const real = await store.recordVerified({ environment: "sandbox", webhookId: "evt_real", ...envelope("evt_real", "job.created", sampleJob()) });
    const junk = MAX_REJECTED_DELIVERIES + 50;
    await Promise.all(Array.from({ length: junk }, (_, n) => store.recordRejected({ environment: "sandbox", webhookId: `junk_${n}`, reason: "missing_headers", message: "x" })));
    await flushJsonWrites();

    const all = store.listEvents({ limit: 5000 });
    assert.equal(all.filter((e) => !e.verified).length, MAX_REJECTED_DELIVERIES, "refusals are capped");
    assert.equal(all[0]!.webhook_id, `junk_${junk - 1}`, "newest first, across both logs");
    assert.ok(all.some((e) => e.webhook_id === "evt_real"), "the real event is still listed");
    assert.deepEqual(store.listEvents({ afterSeq: real.seq - 1, limit: 5000 }).at(-1)?.webhook_id, "evt_real");

    const eventsFile = await readFile(path.join(sub, "webhook-events.json"), "utf8");
    assert.ok(eventsFile.includes("evt_real"));
    assert.ok(!eventsFile.includes("junk_"), "refusals never touch the event log");
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
