// The webhook listener end to end (loopback only, no network).

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setLogSink } from "../src/log.ts";
import { createWebhookServer } from "../src/server/webhook-listener.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import { EventStore } from "../src/webhooks/store.ts";
import { closeServer, eventually, listenLocal, send } from "./helpers/http.ts";
import { makeSecret, sampleJob, tcEnvelope, tcHeaders } from "./helpers/tc-signer.ts";

const TEST_SECRET = makeSecret();
let server: Server;
let port: number;
let store: EventStore;
let dataDir: string;
let restoreSink: ReturnType<typeof setLogSink>;
const statuses: number[] = [];

async function deliver(pathname: string, eventId: string, options: { secret?: string; job?: ReturnType<typeof sampleJob>; type?: string } = {}) {
  const body = JSON.stringify(tcEnvelope({ eventId, type: options.type ?? "job.status_changed", job: options.job ?? sampleJob(), changes: { job_status: { from: "OPEN", to: "ASSIGNED" } } }));
  const headers = await tcHeaders({ webhookId: eventId, body, secret: options.secret ?? TEST_SECRET });
  const res = await send(port, { method: "POST", path: pathname, headers, body });
  statuses.push(res.status);
  return res;
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "tc-webhooks-"));
  restoreSink = setLogSink(() => {});
  store = await EventStore.open(dataDir);
  // Live secret deliberately not configured.
  server = createWebhookServer({ config: { test: { apiKey: null, webhookSecret: TEST_SECRET }, live: { apiKey: null, webhookSecret: null } }, store });
  port = await listenLocal(server);
});

after(async () => {
  await closeServer(server);
  await flushJsonWrites();
  setLogSink(restoreSink);
  await rm(dataDir, { recursive: true, force: true });
});

describe("webhook listener", () => {
  it("answers 404 to everything except its two POST routes", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/"],
      ["GET", "/webhooks/tc/sandbox"],
      ["PUT", "/webhooks/tc/sandbox"],
      ["POST", "/webhooks/tc/other"],
      ["POST", "/webhooks/tc/sandbox/extra"],
      ["POST", "/webhooks/tc"],
      ["GET", "/api/status"],
      ["POST", "/api/jobs"],
      ["GET", "/index.html"],
      ["GET", "/app.js"],
    ];
    for (const [method, pathname] of cases) {
      const res = await send(port, { method, path: pathname, ...(method === "POST" || method === "PUT" ? { body: "{}" } : {}) });
      statuses.push(res.status);
      assert.equal(res.status, 404, `${method} ${pathname}`);
    }
  });

  it("accepts a correctly signed delivery with 200 and stores it, verified", async () => {
    const res = await deliver("/webhooks/tc/sandbox", "evt_ok_1");
    assert.equal(res.status, 200);
    const event = await eventually(() => store.listEvents().find((e) => e.webhook_id === "evt_ok_1"));
    assert.equal(event.verified, true);
    assert.equal(event.environment, "sandbox");
    assert.equal(event.event_type, "job.status_changed");
  });

  it("answers 200 to a repeat delivery but flags it as a duplicate", async () => {
    await deliver("/webhooks/tc/sandbox", "evt_dup");
    const again = await deliver("/webhooks/tc/sandbox", "evt_dup");
    assert.equal(again.status, 200);
    await eventually(() => store.listEvents().filter((e) => e.webhook_id === "evt_dup").length === 2);
    const [latest] = store.listEvents().filter((e) => e.webhook_id === "evt_dup");
    assert.equal(latest!.flags.duplicate, true);
  });

  it("refuses a bad signature with 401, and records the refusal without the body", async () => {
    const res = await deliver("/webhooks/tc/sandbox", "evt_bad", { secret: makeSecret() });
    assert.equal(res.status, 401);
    const event = await eventually(() => store.listEvents().find((e) => e.webhook_id === "evt_bad"));
    assert.equal(event.verified, false);
    assert.equal(event.raw_body, null);
  });

  it("refuses a delivery with no signature headers with 401", async () => {
    const res = await send(port, { method: "POST", path: "/webhooks/tc/sandbox", headers: { "content-type": "application/json" }, body: "{}" });
    statuses.push(res.status);
    assert.equal(res.status, 401);
  });

  it("answers 503 (not 410) when the path's secret is not configured", async () => {
    const res = await deliver("/webhooks/tc/live", "evt_live");
    assert.equal(res.status, 503);
  });

  it("refuses an oversized body with 413", async () => {
    const res = await send(port, { method: "POST", path: "/webhooks/tc/sandbox", body: Buffer.alloc(1024 * 1024 + 10, 0x20) });
    statuses.push(res.status);
    assert.equal(res.status, 413);
  });

  it("flags an event whose is_sandbox disagrees with the path", async () => {
    await deliver("/webhooks/tc/sandbox", "evt_mismatch", { job: sampleJob({ is_sandbox: false }) });
    const event = await eventually(() => store.listEvents().find((e) => e.webhook_id === "evt_mismatch"));
    assert.equal(event.flags.environment_mismatch, true);
  });

  it("never answers 410, and never writes the secret to data/", async () => {
    assert.ok(statuses.length > 10);
    assert.ok(!statuses.includes(410));
    await flushJsonWrites();
    for (const file of await readdir(dataDir)) {
      const text = await readFile(path.join(dataDir, file), "utf8");
      assert.ok(!text.includes(TEST_SECRET.slice(6)), file);
    }
  });
});
