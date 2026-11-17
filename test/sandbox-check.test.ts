// The sandbox check's logic against a fake TC on a virtual clock: no network and no real waiting.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { CheckHistory, MAX_KEPT_RUNS } from "../src/check/history.ts";
import { formatReport, summaryLine } from "../src/check/report.ts";
import { RetryProbe } from "../src/check/retry-probe.ts";
import {
  applyManualEvent,
  DEFAULT_TIMINGS,
  EXPECTED_EVENTS,
  MANUAL_ROWS,
  newCheckRun,
  startSandboxCheck,
  webhookWaitMs,
  type SandboxCheckDeps,
} from "../src/check/sandbox-check.ts";
import { tinyPng } from "../src/check/png.ts";
import type { CheckRow, CheckRun } from "../src/check/types.ts";
import { setLogSink } from "../src/log.ts";
import { createWebhookServer, WEBHOOK_PATHS } from "../src/server/webhook-listener.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import { EventStore, type StoredEvent } from "../src/webhooks/store.ts";
import { FAKE_BASE, FakeClock, FakeTc, refusingListener, type FakeTcOptions } from "./helpers/fake-tc.ts";
import { closeServer, listenLocal } from "./helpers/http.ts";
import { makeSecret, sampleJob } from "./helpers/tc-signer.ts";

const KEY = `tc_test_${"3c".repeat(24)}`;
let restoreSink: ReturnType<typeof setLogSink>;
const dirs: string[] = [];

before(() => {
  restoreSink = setLogSink(() => {});
});
after(async () => {
  await flushJsonWrites();
  setLogSink(restoreSink);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface Harness {
  run: CheckRun;
  tc: FakeTc;
  clock: FakeClock;
  store: EventStore;
  probe: RetryProbe | null;
  startedAt: number;
  updates: number;
  row(id: string): CheckRow;
}

async function runCheck(
  options: {
    fake?: Omit<FakeTcOptions, "clock">;
    deps?: Partial<SandboxCheckDeps>;
    retries?: boolean;
    probe?: "real" | "none";
    /** Runs just before the check starts (e.g. to leave state from an earlier run). */
    beforeStart?: (setup: { tc: FakeTc; probe: RetryProbe | null }) => void;
  } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), "tc-check-"));
  dirs.push(dir);
  const clock = new FakeClock();
  const store = await EventStore.open(dir);
  const tc = new FakeTc({ clock, ...options.fake });
  tc.seedOwnersJob();
  const probe = options.probe === "none" ? null : new RetryProbe({ now: () => clock.now() });
  tc.retryProbe = probe;
  options.beforeStart?.({ tc, probe });
  let updates = 0;
  const startedAt = clock.now();
  const { run, finished } = startSandboxCheck({
    source: "cli",
    baseUrl: FAKE_BASE,
    apiKey: KEY,
    fetch: tc.fetch,
    events: tc.eventSource(store),
    webhookSecretConfigured: true,
    listenerUrl: "http://127.0.0.1:9/webhooks/tc/sandbox",
    listenerFetch: refusingListener,
    retryProbe: probe,
    retryUnavailableReason: "npm start owns the webhook port.",
    clock,
    options: { testRetries: options.retries ?? false },
    onUpdate: () => {
      updates++;
    },
    uniqueTag: "t3st",
    ...options.deps,
  });
  assert.equal(run.state, "running");
  const done = await finished;
  assert.equal(done, run, "the same run object, updated in place");
  return {
    run: done,
    tc,
    clock,
    store,
    probe,
    startedAt,
    get updates() {
      return updates;
    },
    row: (id) => {
      const row = done.rows.find((r) => r.id === id);
      assert.ok(row, `row ${id}`);
      return row;
    },
  };
}

function statuses(run: CheckRun, status: CheckRow["status"]): string[] {
  return run.rows.filter((r) => r.status === status).map((r) => r.id);
}

describe("sandbox check: a well-behaved sandbox", () => {
  let h: Harness;
  before(async () => {
    h = await runCheck();
  });

  it("passes every automatic row and leaves only the three manual items amber", () => {
    assert.deepEqual(statuses(h.run, "fail"), []);
    assert.deepEqual(statuses(h.run, "skipped"), []);
    assert.deepEqual(statuses(h.run, "needs_you").sort(), Object.values(MANUAL_ROWS).sort());
    assert.equal(h.run.state, "finished");
    assert.ok(h.run.finished_at);
    assert.equal(h.run.summary.failed, 0);
    assert.equal(h.run.summary.needs_you, 3);
    assert.equal(h.run.summary.passed, h.run.rows.length - 3);
    assert.ok(h.updates > h.run.rows.length, "onUpdate fires as rows change");
  });

  it("uses its own two uniquely referenced jobs and never writes to any other job", () => {
    assert.match(h.run.jobs.a!.external_reference!, /^CHECK-2026-11-17-t3st-A$/);
    assert.match(h.run.jobs.b!.external_reference!, /^CHECK-2026-11-17-t3st-B$/);
    const ours = new Set([h.run.jobs.a!.id, h.run.jobs.b!.id]);
    for (const write of h.tc.writes) assert.ok(write.jobId && ours.has(write.jobId), `${write.route} touched ${write.jobId}`);
    assert.equal(h.tc.jobs.get("0d0d0d0d-1111-4222-8333-444444444444")!.status, "OPEN", "the owner's job is untouched");
    assert.equal(h.run.jobs.a!.status, "PAID");
    assert.equal(h.run.jobs.b!.status, "CANCELLED");
  });

  it("only ever sends the sandbox key, and never sends it to storage", () => {
    assert.deepEqual([...h.tc.authorizations].sort(), [`Bearer ${KEY}`, "storage:none"].sort());
  });

  it("makes one simulate call per step, in order", () => {
    const simulates = h.tc.requests.filter((r) => r.endsWith("/simulate"));
    assert.equal(simulates.length, 6, "five for job A, one for job B");
    const bodies = h.row("lifecycle.assigned").exchanges.map((e) => e.request_body);
    assert.deepEqual(bodies, [{ status: "ASSIGNED" }]);
  });

  it("replays the create: HTTP 200 and the same job", () => {
    const row = h.row("jobs.replay");
    assert.equal(row.exchanges[0]!.status, 200);
    assert.equal(row.exchanges[0]!.request_headers["Idempotency-Key"], h.row("jobs.create_draft").exchanges[0]!.request_headers["Idempotency-Key"]);
    assert.equal((row.exchanges[0]!.response_body as { id: string }).id, h.run.jobs.a!.id);
  });

  it("gets 409 JOB_LOCKED for a PATCH after ASSIGNED", () => {
    const row = h.row("jobs.patch_locked");
    assert.equal(row.status, "pass");
    assert.equal(row.exchanges[0]!.status, 409);
    assert.equal(row.exchanges[0]!.error_code, "JOB_LOCKED");
    assert.match(row.reason!, /409 JOB_LOCKED/);
  });

  it("pages the list with limit 1 and finds both jobs", () => {
    const row = h.row("jobs.list");
    assert.ok(row.exchanges.length >= 2, "more than one page");
    assert.ok(row.exchanges.slice(1).every((e) => e.path.includes("cursor=")), "follows next_cursor");
    assert.ok(row.exchanges.every((e) => e.path.includes("updated_since=")));
  });

  it("uploads a private SITE_PHOTO in three steps and masks the signed upload URL in the record", () => {
    const [step1, step2, step3] = ["attachments.create", "attachments.upload", "attachments.complete"].map((id) => h.row(id));
    const issued = step1!.exchanges[0]!.response_body as { upload_url: string; token: string };
    assert.doesNotMatch(issued.upload_url, /signed-secret-token/);
    assert.equal(issued.token, "[masked]");
    assert.equal(step2!.exchanges[0]!.path, "(signed upload URL)");
    assert.equal((step3!.exchanges[0]!.request_body as { is_public: boolean }).is_public, false);
    assert.equal((step3!.exchanges[0]!.request_body as { category: string }).category, "SITE_PHOTO");
    assert.ok(!JSON.stringify(h.run).includes("signed-secret-token"));
  });

  it("checks every expected webhook: verified, the right job and status", () => {
    for (const spec of EXPECTED_EVENTS) {
      const row = h.row(spec.rowId);
      assert.equal(row.status, "pass", `${spec.rowId}: ${row.reason}`);
      assert.match(row.reason!, /signature verified/);
    }
    assert.equal(h.row("webhooks.a.matches_get").status, "pass");
    assert.equal(h.row("webhooks.b.matches_get").status, "pass");
    assert.match(h.row("webhooks.unexpected").reason!, /^None.*plus 1 extra job\.price_changed/);
  });

  it("cancels the second job after ASSIGNED, free, and keeps the reason", () => {
    assert.equal(h.row("lifecycle.b_assigned").status, "pass");
    assert.deepEqual(h.row("lifecycle.b_assigned").exchanges.map((e) => e.request_body), [{ status: "ASSIGNED" }]);
    const row = h.row("lifecycle.cancel");
    assert.equal(row.status, "pass");
    assert.match(row.reason!, /^ASSIGNED → CANCELLED, no fee \(fee_applied false, sandbox\), reason kept$/);
    const answer = row.exchanges[0]!.response_body as { previous_status: string; fee_applied: boolean };
    assert.equal(answer.previous_status, "ASSIGNED");
    assert.equal(answer.fee_applied, false);
    for (const id of ["webhooks.b.status_assigned", "webhooks.b.assigned", "webhooks.b.status_cancelled", "webhooks.b.cancelled"]) {
      assert.equal(h.row(id).status, "pass", id);
    }
  });

  it("infers each scope from the calls that need it", () => {
    for (const scope of ["jobs:read", "jobs:write", "jobs:cancel", "attachments:write", "reference:read"]) {
      assert.equal(h.row(`keys.scope.${scope}`).status, "pass", scope);
    }
    assert.match(h.row("keys.scope.jobs:cancel").reason!, /jobs\.cancel/);
  });

  it("fills a timeline: every step reached, every webhook dot green", () => {
    const [a, b] = h.run.timeline;
    assert.deepEqual(a!.steps.map((s) => s.status), ["DRAFT", "OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID"]);
    assert.ok(a!.steps.every((s) => s.reached));
    assert.deepEqual(a!.steps.find((s) => s.status === "WORK_COMPLETE")!.events.map((e) => e.type), ["job.status_changed", "job.completed", "job.evidence_ready"]);
    assert.ok([...a!.steps, ...b!.steps].flatMap((s) => s.events).every((e) => e.status === "pass"));
    assert.deepEqual(b!.steps.map((s) => s.status), ["OPEN", "ASSIGNED", "CANCELLED"]);
    assert.deepEqual(b!.steps.find((s) => s.status === "ASSIGNED")!.events.map((e) => e.type), ["job.status_changed", "job.assigned"]);
  });

  it("never records the API key", () => {
    assert.ok(!JSON.stringify(h.run).includes(KEY));
    assert.equal(h.run.key_prefix, "tc_test_3c3c…");
  });

  it("is quick when TC is quick: it stops waiting once every webhook is in", () => {
    assert.ok(h.clock.now() - h.startedAt < 60_000, `${h.clock.now() - h.startedAt} ms`);
  });
});

describe("sandbox check: webhooks that do not come", () => {
  it("fails a missing webhook after the wait, with the reason, and passes the rest", async () => {
    const h = await runCheck({ fake: { drop: (type) => type === "job.evidence_ready" } });
    const row = h.row("webhooks.a.evidence_ready");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /No job\.evidence_ready arrived within 4 minutes of the last step, although other events for job A did/);
    assert.match(row.reason!, /TC sends only the event types your endpoint subscribes to: check that job\.evidence_ready is ticked for your sandbox endpoint/);
    assert.deepEqual(statuses(h.run, "fail"), ["webhooks.a.evidence_ready"]);
    const waited = h.clock.now() - h.startedAt;
    assert.ok(waited >= 4 * 60_000 && waited < 4 * 60_000 + 5_000, `waited ${waited} ms`);
  });

  it("waits one minute per 8 expected deliveries, plus one, after the last step, and never past the bound", () => {
    assert.equal(webhookWaitMs(8, false), 2 * 60_000);
    assert.equal(webhookWaitMs(9, false), 3 * 60_000);
    assert.equal(webhookWaitMs(18, false), 4 * 60_000, "the 17 expected events and job B's price change at create");
    assert.equal(webhookWaitMs(19, true), 6 * 60_000, "plus the refused delivery and the retry allowance");
    assert.equal(webhookWaitMs(500, true), DEFAULT_TIMINGS.overallMs);
    assert.ok(webhookWaitMs(EXPECTED_EVENTS.length + 2, true) < DEFAULT_TIMINGS.overallMs, "the check's own wait fits inside the bound");
  });

  it("times an early step's missing webhook from the last step, not from its own step", async () => {
    // The steps take about 16 s here; job A's job.created belongs to the first of them.
    const h = await runCheck({ fake: { requestMs: 600, drop: (type, job) => type === "job.created" && job.status === "DRAFT" } });
    const row = h.row("webhooks.a.created");
    assert.equal(row.status, "fail");
    const lastStep = Date.parse(h.row("lifecycle.cancel").finished_at!);
    const ownStep = Date.parse(h.row("jobs.create_draft").finished_at!);
    assert.ok(lastStep - ownStep > 10_000, "the last step is well after job A's create");
    const failedAt = Date.parse(row.finished_at!);
    assert.ok(failedAt - lastStep >= 4 * 60_000 && failedAt - lastStep < 4 * 60_000 + 5_000, `failed ${failedAt - lastStep} ms after the last step`);
  });

  it("says to check the tunnel when nothing arrives at all, and stays bounded", async () => {
    const h = await runCheck({ fake: { drop: () => true } });
    for (const spec of EXPECTED_EVENTS) {
      const row = h.row(spec.rowId);
      assert.equal(row.status, "fail", spec.rowId);
      assert.match(row.reason!, /Is the tunnel running/);
    }
    assert.equal(h.row("webhooks.a.matches_get").status, "skipped");
    assert.ok(h.clock.now() - h.startedAt <= DEFAULT_TIMINGS.overallMs, "bounded");
  });

  it("fails the comparison with a fresh GET when the last status change never came", async () => {
    const h = await runCheck({ fake: { drop: (type, _job, changes) => type === "job.status_changed" && (changes.job_status as { to: string }).to === "PAID" } });
    const row = h.row("webhooks.a.matches_get");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /status "WORK_COMPLETE" vs "PAID"/);
  });

  it("explains a near miss: the right type, but the wrong status inside", async () => {
    // A price change that only lands once the job is OPEN (simulated by dropping the DRAFT one
    // and emitting another at publish).
    const h = await runCheck({
      fake: {
        drop: (type, job) => type === "job.price_changed" && job.status === "DRAFT",
        extraOnPublish: [{ type: "job.price_changed" }],
      },
    });
    const row = h.row("webhooks.a.price_changed");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /A job\.price_changed arrived, but the job inside it was OPEN/);
    assert.equal(h.row("webhooks.unexpected").status, "pass", "an extra job.price_changed is never unexpected");
  });

  it("reports an unexpected event as needing you, not as a failure", async () => {
    const h = await runCheck({ fake: { extraOnPublish: [{ type: "job.surprise" }] } });
    const row = h.row("webhooks.unexpected");
    assert.equal(row.status, "needs_you");
    assert.match(row.reason!, /job\.surprise for job A/);
    assert.equal(h.run.summary.failed, 0);
  });

  it("fails every webhook row at once, without waiting, when no webhook secret is set", async () => {
    const h = await runCheck({ deps: { webhookSecretConfigured: false } });
    assert.equal(h.row("keys.webhook_secret").status, "fail");
    for (const spec of EXPECTED_EVENTS) {
      if (h.row(spec.rowId).status === "pass") continue; // arrived before the wait (the fake delivers anyway)
      assert.match(h.row(spec.rowId).reason!, /TC_TEST_WEBHOOK_SECRET is not set/);
    }
    assert.ok(h.clock.now() - h.startedAt < 60_000, "no webhook wait");
  });
});

describe("sandbox check: TC errors", () => {
  it("fails the JOB_LOCKED row when TC accepts a PATCH after ASSIGNED", async () => {
    const h = await runCheck({ fake: { patchAfterAssignedWorks: true } });
    const row = h.row("jobs.patch_locked");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /TC accepted a PATCH on an ASSIGNED job\. Expected 409 JOB_LOCKED/);
    assert.equal(row.exchanges[0]!.status, 200);
  });

  it("names a missing scope clearly, fails what needs it, and skips what depends on that", async () => {
    const h = await runCheck({ fake: { scopes: ["jobs:read", "jobs:write", "attachments:write"] } });
    const reference = h.row("reference.trade_types");
    assert.equal(reference.status, "fail");
    assert.equal(reference.error?.code, "SCOPE_FORBIDDEN");
    assert.ok(reference.error?.request_id);
    assert.match(h.row("keys.scope.reference:read").reason!, /does not have the 'reference:read' scope.*Settings → API & Webhooks → API keys/);
    assert.equal(h.row("keys.scope.jobs:cancel").status, "fail");
    assert.equal(h.row("lifecycle.cancel").status, "fail");
    assert.equal(h.row("webhooks.b.status_cancelled").status, "skipped");
    assert.equal(h.row("webhooks.b.created").status, "pass", "job B's create still sent its event");
    assert.equal(h.row("jobs.create_draft").status, "pass", "jobs carry on without trade codes");
  });

  it("skips everything, manual items included, when TC does not answer the health check", async () => {
    const h = await runCheck({ fake: { healthDown: true } });
    assert.equal(h.row("keys.health").status, "fail");
    assert.match(h.row("keys.health").reason!, /NETWORK_ERROR/);
    assert.equal(h.run.summary.needs_you, 0);
    assert.equal(h.run.summary.passed, 1, "only the key prefix");
    assert.equal(h.tc.requests.length, 1);
  });

  it("refuses to run with anything but a tc_test_ key, and sends nothing at all", async () => {
    const h = await runCheck({ deps: { apiKey: `tc_live_${"3c".repeat(24)}` } });
    assert.equal(h.row("keys.prefix").status, "fail");
    assert.equal(h.row("keys.health").status, "skipped");
    assert.deepEqual(h.tc.requests, [], "not even the health route: the client would send the key with it");
    assert.equal(h.tc.authorizations.size, 0);
  });

  it("charges nothing for the cancel after ASSIGNED, or fails the row", async () => {
    const h = await runCheck({ fake: { feeAfterAssigned: true } });
    const row = h.row("lifecycle.cancel");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /TC applied a cancellation fee to a sandbox job cancelled from ASSIGNED/);
  });

  it("fails the cancel row when TC's answer says the job was not ASSIGNED before the cancel", async () => {
    const h = await runCheck({ fake: { cancelPreviousStatus: "OPEN" } });
    assert.equal(h.row("lifecycle.b_assigned").status, "pass", "the job really was ASSIGNED");
    const row = h.row("lifecycle.cancel");
    assert.equal(row.status, "fail");
    assert.match(row.reason!, /previous_status is "OPEN", expected ASSIGNED\./);
  });
});

describe("sandbox check: the retry test", () => {
  it("answers 500 once to a delivery for job A and sees TC deliver the same webhook-id again", async () => {
    const h = await runCheck({ retries: true });
    const row = h.row("webhooks.retry");
    assert.equal(row.status, "pass", row.reason ?? "");
    assert.equal(h.tc.refused.length, 1, "exactly one delivery refused");
    const refused = h.tc.refused[0]!;
    assert.equal(refused.job.id, h.run.jobs.a!.id, "only the check's job");
    assert.match(row.reason!, new RegExp(`webhook-id ${refused.webhookId}`));
    assert.match(row.reason!, /again 6\d s later/);
    assert.equal(h.tc.delivered.filter((d) => d.webhookId === refused.webhookId).length, 1, "delivered once, after the retry");
    assert.deepEqual(statuses(h.run, "fail"), []);
    // The refusal was logged as refused (not received), so the retry was not a duplicate.
    const stored = h.store.listEvents().filter((e) => e.webhook_id === refused.webhookId);
    assert.deepEqual(stored.map((e) => [e.verified, e.flags.duplicate]).sort(), [[false, false], [true, false]]);
  });

  it("disarms the probe when the run finishes, even when nothing arrived to refuse", async () => {
    const h = await runCheck({ retries: true, fake: { drop: () => true } });
    assert.equal(h.row("webhooks.retry").status, "fail");
    assert.equal(h.tc.refused.length, 0, "nothing was refused");
    const armedFor = h.clock.now() - h.startedAt;
    assert.ok(armedFor < 10 * 60_000, `the run ended ${armedFor} ms in, before the probe's own expiry`);
    assert.equal(h.probe!.armed, false, "disarmed by the end of the run, not left for its expiry");
  });

  it("fails the retry row when TC never sends it again", async () => {
    const h = await runCheck({ retries: true, fake: { neverRetry: true } });
    const row = h.row("webhooks.retry");
    assert.equal(row.status, "fail");
    // The retry waits as long as the other webhooks (6 minutes after the last step with the retry
    // test on), since the retried delivery queues behind them.
    assert.match(row.reason!, /did not deliver it again within 5 min 5\d s\./);
    assert.ok(h.clock.now() - h.startedAt <= DEFAULT_TIMINGS.overallMs + 5_000);
  });

  it("ignores TC's retry of a delivery an earlier run refused: only this run's own retry counts", async () => {
    const earlierJob = "0e0e0e0e-1111-4222-8333-444444444444";
    const h = await runCheck({
      retries: true,
      // This run's own refused delivery is never sent again, so its retry row must fail.
      fake: { neverRetry: true },
      beforeStart: ({ tc, probe }) => {
        // An earlier run's probe refused a delivery for that run's job A...
        probe!.arm(earlierJob);
        assert.equal(probe!.take("sandbox", earlierJob, "evt-earlier-run"), true);
        // ...and TC's retry of it lands as this run starts, before this run arms the probe.
        tc.pending.push({
          webhookId: "evt-earlier-run",
          type: "job.created",
          job: sampleJob({ id: earlierJob, external_reference: "CHECK-2026-11-16-e4r1-A", is_sandbox: true }),
          changes: {},
          deliverAt: tc.clock.now(),
        });
      },
    });
    const earlier = h.store.listEvents().find((e) => e.webhook_id === "evt-earlier-run" && e.verified);
    assert.ok(earlier, "the earlier run's retry arrived during this run");
    assert.ok(earlier.seq > h.run.start_seq, "after this run started");
    const row = h.row("webhooks.retry");
    assert.equal(row.status, "fail", row.reason ?? "");
    assert.doesNotMatch(row.reason!, /evt-earlier-run/);
    assert.match(row.reason!, /did not deliver it again/);
    assert.equal(h.tc.refused.length, 1, "this run refused one delivery of its own");
  });

  it("is amber with the reason when this process does not own the listener", async () => {
    const h = await runCheck({ retries: true, probe: "none" });
    const row = h.row("webhooks.retry");
    assert.equal(row.status, "needs_you");
    assert.match(row.reason!, /npm start owns the webhook port/);
    assert.equal(h.tc.refused.length, 0);
  });

  it("has no retry row unless asked", async () => {
    const run = newCheckRun({ source: "console", baseUrl: FAKE_BASE, apiKey: KEY, testRetries: false });
    assert.ok(!run.rows.some((r) => r.id === "webhooks.retry"));
  });
});

describe("sandbox check: TC's batched delivery (8 a minute per endpoint, oldest first)", () => {
  // When TC's first dispatcher run lands, in seconds after the check starts. Each API call takes
  // 0.6 s here, so the steps take about 16 s and make 18 deliveries (17 expected, plus job B's
  // price change at create): some runs land during the steps, some after.
  const OFFSETS_S = [2, 8, 20, 40, 59];
  const batched = (firstRunS: number): Omit<FakeTcOptions, "clock"> => ({ dispatcher: { firstRunMs: firstRunS * 1000 }, requestMs: 600 });

  for (const offset of OFFSETS_S) {
    it(`passes every webhook row when TC's first run is ${offset} s in`, async () => {
      const h = await runCheck({ fake: batched(offset) });
      for (const spec of EXPECTED_EVENTS) {
        const row = h.row(spec.rowId);
        assert.equal(row.status, "pass", `${spec.rowId}: ${row.reason}`);
        assert.doesNotMatch(row.reason!, /late/, `${spec.rowId} was given up on, then arrived`);
      }
      assert.deepEqual(statuses(h.run, "fail"), []);
      assert.equal(h.row("webhooks.b.matches_get").status, "pass", h.row("webhooks.b.matches_get").reason ?? "");
      // The fake really batched: 18 deliveries need three runs, so they spread over at least a minute.
      assert.equal(h.tc.delivered.length, 18);
      const received = h.store.listEvents().filter((e) => e.verified).map((e) => Date.parse(e.received_at));
      assert.ok(Math.max(...received) - Math.min(...received) >= 60_000, "spread over more than one run");
    });

    it(`passes the retry test too when TC's first run is ${offset} s in`, async () => {
      const h = await runCheck({ fake: batched(offset), retries: true });
      assert.equal(h.row("webhooks.retry").status, "pass", h.row("webhooks.retry").reason ?? "");
      assert.deepEqual(statuses(h.run, "fail"), []);
      // Not given up on and then let off: a row failed at its deadline turns "Arrived late" if
      // the run is still waiting for something else when it comes.
      for (const spec of EXPECTED_EVENTS) assert.doesNotMatch(h.row(spec.rowId).reason!, /late/, spec.rowId);
      assert.equal(h.tc.refused.length, 1);
    });
  }

  it("says honestly what it is waiting for while TC's batches come in", async () => {
    const notes: string[] = [];
    await runCheck({
      fake: batched(40),
      deps: {
        onUpdate: (_run, row) => {
          if (row?.group === "webhooks" && row.status === "running" && row.reason && notes.at(-1) !== row.reason) notes.push(row.reason);
        },
      },
    });
    assert.ok(notes.length >= 2, notes.join("\n"));
    const counts = notes.map((note) => {
      const match = /^Waiting for TC's webhooks: (\d+) of 17 so far\. TC sends up to 8 a minute, so this can take about 3 minutes; the check waits up to 4 minutes after the last step\.$/.exec(note);
      assert.ok(match, note);
      return Number(match[1]);
    });
    assert.ok(counts.every((n, i) => i === 0 || n > counts[i - 1]!), `counts only go up: ${counts.join(", ")}`);
  });
});

describe("sandbox check: manual items", () => {
  it("ticks Replay, job.rescheduled and webhook.test when they really arrive during the run", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tc-check-"));
    dirs.push(dir);
    const clock = new FakeClock();
    const store = await EventStore.open(dir);
    const tc = new FakeTc({ clock });
    const source = tc.eventSource(store);
    let replayed = false;
    const { finished } = startSandboxCheck({
      source: "cli",
      baseUrl: FAKE_BASE,
      apiKey: KEY,
      fetch: tc.fetch,
      events: {
        latestSeq: () => source.latestSeq(),
        since: async (after) => {
          // Once a delivery has gone through, press "Replay" on it, and send the other two.
          if (!replayed && tc.delivered.length) {
            replayed = true;
            tc.replay(tc.delivered[0]!.webhookId);
            const dummy = { ...tc.delivered[0]!.job, id: "00000000-0000-0000-0000-000000000000", external_reference: "TEST-WEBHOOK-001" };
            tc.queue("webhook.test", dummy);
            tc.queue("job.rescheduled", { ...tc.delivered[0]!.job, status: "SCHEDULED" });
          }
          return source.since(after);
        },
      },
      webhookSecretConfigured: true,
      listenerUrl: "http://127.0.0.1:9/webhooks/tc/sandbox",
      listenerFetch: refusingListener,
      retryProbe: null,
      clock,
      options: { testRetries: false },
    });
    const run = await finished;
    for (const id of Object.values(MANUAL_ROWS)) assert.equal(run.rows.find((r) => r.id === id)!.status, "pass", id);
    assert.match(run.rows.find((r) => r.id === MANUAL_ROWS.replay)!.reason!, /flagged duplicate/);
  });

  it("applyManualEvent ignores live, refused and earlier deliveries", () => {
    const run = newCheckRun({ source: "console", baseUrl: FAKE_BASE, apiKey: KEY, testRetries: false });
    run.start_seq = 10;
    const event = (overrides: Partial<StoredEvent>): StoredEvent => ({
      seq: 11,
      received_at: "2026-11-17T01:00:00.000Z",
      environment: "sandbox",
      verified: true,
      rejection: null,
      webhook_id: "w1",
      event_type: "webhook.test",
      event_created_at: null,
      api_version: null,
      job_id: null,
      external_reference: null,
      job_status: null,
      job_updated_at: null,
      changes: null,
      flags: { duplicate: false, out_of_order: false, environment_mismatch: false, unknown_type: false, unknown_status: false, test_event: true },
      raw_body: null,
      ...overrides,
    });
    assert.equal(applyManualEvent(run, event({ environment: "live" })), false);
    assert.equal(applyManualEvent(run, event({ verified: false })), false);
    assert.equal(applyManualEvent(run, event({ seq: 10 })), false);
    assert.equal(applyManualEvent(run, event({})), true);
    assert.equal(run.rows.find((r) => r.id === MANUAL_ROWS.testEvent)!.status, "pass");
    assert.equal(run.summary.needs_you, 2);
  });
});

describe("sandbox check: the security self-test against the real listener", () => {
  let server: Server;
  let port: number;
  let dir: string;

  afterEach(async () => {
    if (server?.listening) await closeServer(server);
  });

  async function selfTest(secret: string | null): Promise<Harness> {
    dir = await mkdtemp(path.join(tmpdir(), "tc-check-"));
    dirs.push(dir);
    const store = await EventStore.open(dir);
    server = createWebhookServer({ config: { test: { apiKey: null, webhookSecret: secret }, live: { apiKey: null, webhookSecret: null } }, store });
    port = await listenLocal(server);
    return runCheck({ deps: { listenerUrl: `http://127.0.0.1:${port}${WEBHOOK_PATHS.sandbox}`, listenerFetch: globalThis.fetch } });
  }

  it("posts a forged and an unsigned delivery to the listener and gets 401 for both", async () => {
    const h = await selfTest(makeSecret());
    assert.equal(h.row("security.forged").status, "pass");
    assert.equal(h.row("security.unsigned").status, "pass");
    assert.equal(h.row("security.forged").exchanges[0]!.status, 401);
    assert.match(String(h.row("security.forged").exchanges[0]!.request_headers["webhook-signature"]), /^v1,/);
    assert.equal(h.row("security.unsigned").exchanges[0]!.request_headers["webhook-signature"], undefined);
  });

  it("fails both, saying why, when the listener has no secret (503)", async () => {
    const h = await selfTest(null);
    for (const id of ["security.forged", "security.unsigned"]) {
      assert.equal(h.row(id).status, "fail");
      assert.match(h.row(id).reason!, /503: TC_TEST_WEBHOOK_SECRET is not set/);
    }
  });
});

describe("sandbox check: report and history", () => {
  it("writes a plain-text report with no markdown, ready to paste into WhatsApp", async () => {
    const h = await runCheck({ fake: { drop: (type) => type === "job.evidence_ready" } });
    const text = formatReport(h.run);
    assert.match(text, /^Trade Connector sandbox check\n/);
    assert.match(text, /Result: \d+ passed · 3 need you · 1 failed/);
    assert.match(text, /Keys & health: all 8 passed/);
    assert.match(text, /\n {2}Failed: job\.evidence_ready \(job A, simulate\)\. No job\.evidence_ready arrived/);
    assert.match(text, /Sandbox jobs used: A CHECK-2026-11-17-t3st-A \(PAID\), B CHECK-2026-11-17-t3st-B \(CANCELLED\)/);
    for (const line of text.split("\n")) {
      assert.doesNotMatch(line, /^\s*([-*#>]|\d+\.)\s/, `markdown-looking line: ${line}`);
      assert.doesNotMatch(line, /[`*~]|(^|\s)_\S/, `markdown emphasis: ${line}`);
    }
    assert.ok(!text.includes(KEY));
  });

  it("says one 'needs you', several 'need you'", () => {
    assert.equal(summaryLine({ total: 3, passed: 1, needs_you: 1, failed: 1, skipped: 0, pending: 0 }), "1 passed · 1 needs you · 1 failed");
    assert.equal(summaryLine({ total: 9, passed: 4, needs_you: 3, failed: 0, skipped: 1, pending: 1 }), "4 passed · 3 need you · 0 failed · 1 skipped · 1 to go");
  });

  it("keeps the newest five runs, newest first, and replaces a run saved again", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "tc-check-"));
    dirs.push(dir);
    const history = new CheckHistory(dir);
    const runs = Array.from({ length: 7 }, (_, i) => {
      const run = newCheckRun({ source: "cli", baseUrl: FAKE_BASE, apiKey: KEY, testRetries: false, now: Date.parse("2026-11-17T01:00:00Z") + i * 60_000 });
      run.state = "finished";
      return run;
    });
    for (const run of runs) await history.save(run);
    const kept = await history.list();
    assert.equal(kept.length, MAX_KEPT_RUNS);
    assert.deepEqual(kept.map((r) => r.id), runs.slice(2).reverse().map((r) => r.id));
    runs[6]!.rows[0]!.status = "pass";
    await history.save(runs[6]!);
    assert.equal((await history.list()).length, MAX_KEPT_RUNS);
    assert.equal((await history.get(runs[6]!.id))!.run.rows[0]!.status, "pass");
    assert.equal((await history.get(runs[6]!.id))!.previous!.id, runs[5]!.id);
  });

  it("generates a real PNG", () => {
    const png = tinyPng();
    assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.byteLength < 100);
    assert.equal(Buffer.from(png.slice(12, 16)).toString("ascii"), "IHDR");
  });
});
