// The sandbox check's one-shot 500 switch, in the real webhook listener (loopback only).

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { RetryProbe } from "../src/check/retry-probe.ts";
import { setLogSink } from "../src/log.ts";
import { createWebhookServer } from "../src/server/webhook-listener.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import { EventStore } from "../src/webhooks/store.ts";
import { closeServer, listenLocal, send } from "./helpers/http.ts";
import { makeSecret, sampleJob, tcEnvelope, tcHeaders } from "./helpers/tc-signer.ts";

const SANDBOX_SECRET = makeSecret();
const LIVE_SECRET = makeSecret();
const CHECK_JOB = "c0c0c0c0-1111-4222-8333-444444444444";
const OTHER_JOB = "d0d0d0d0-1111-4222-8333-444444444444";

let server: Server;
let port: number;
let store: EventStore;
let dir: string;
let now = 1_000_000;
const probe = new RetryProbe({ now: () => now });
let restoreSink: ReturnType<typeof setLogSink>;
const statuses: number[] = [];

async function deliver(pathname: string, eventId: string, jobId: string, secret = SANDBOX_SECRET) {
  const body = JSON.stringify(tcEnvelope({ eventId, type: "job.created", job: sampleJob({ id: jobId, is_sandbox: pathname.endsWith("sandbox") }) }));
  const headers = await tcHeaders({ webhookId: eventId, body, secret });
  const res = await send(port, { method: "POST", path: pathname, headers, body });
  statuses.push(res.status);
  return res;
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tc-probe-"));
  restoreSink = setLogSink(() => {});
  store = await EventStore.open(dir);
  server = createWebhookServer({
    config: { test: { apiKey: null, webhookSecret: SANDBOX_SECRET }, live: { apiKey: null, webhookSecret: LIVE_SECRET } },
    store,
    retryProbe: probe,
  });
  port = await listenLocal(server);
});

after(async () => {
  await closeServer(server);
  await flushJsonWrites();
  setLogSink(restoreSink);
  await rm(dir, { recursive: true, force: true });
});

describe("retry probe in the webhook listener", () => {
  it("does nothing until armed", async () => {
    assert.equal((await deliver("/webhooks/tc/sandbox", "evt-unarmed", CHECK_JOB)).status, 200);
  });

  it("answers 500 once to the armed job, records it as refused (not received), then takes the retry normally", async () => {
    probe.arm(CHECK_JOB);
    assert.equal((await deliver("/webhooks/tc/sandbox", "evt-other", OTHER_JOB)).status, 200, "another job is never affected");
    const first = await deliver("/webhooks/tc/sandbox", "evt-retry", CHECK_JOB);
    assert.equal(first.status, 500);
    assert.equal(probe.refused?.webhookId, "evt-retry");
    assert.equal(probe.armed, false, "one shot");
    const refused = store.listEvents().find((e) => e.webhook_id === "evt-retry")!;
    assert.equal(refused.verified, false);
    assert.equal(refused.rejection?.reason, "retry_test");

    const retry = await deliver("/webhooks/tc/sandbox", "evt-retry", CHECK_JOB);
    assert.equal(retry.status, 200);
    const stored = store.listEvents().find((e) => e.webhook_id === "evt-retry" && e.verified)!;
    assert.equal(stored.flags.duplicate, false, "the retry is processed, not flagged duplicate");
  });

  it("never touches the live path, even for the same job id", async () => {
    probe.arm(CHECK_JOB);
    assert.equal((await deliver("/webhooks/tc/live", "evt-live", CHECK_JOB, LIVE_SECRET)).status, 200);
    assert.equal(probe.armed, true, "still waiting for a sandbox delivery");
    probe.disarm();
  });

  it("never refuses an unverified delivery, and still answers it 401", async () => {
    probe.arm(CHECK_JOB);
    assert.equal((await deliver("/webhooks/tc/sandbox", "evt-forged", CHECK_JOB, makeSecret())).status, 401);
    assert.equal(probe.armed, true);
    probe.disarm();
  });

  it("disarms itself when it expires", async () => {
    probe.arm(CHECK_JOB, 60_000);
    now += 61_000;
    assert.equal(probe.armed, false);
    assert.equal((await deliver("/webhooks/tc/sandbox", "evt-late", CHECK_JOB)).status, 200);
  });

  it("only arms for a job UUID", () => {
    assert.throws(() => probe.arm("ext:CHECK-1"), /UUID/);
    assert.throws(() => probe.arm(""), /UUID/);
  });

  it("never answers 410", () => {
    assert.ok(statuses.length >= 6);
    assert.ok(!statuses.includes(410));
  });
});
