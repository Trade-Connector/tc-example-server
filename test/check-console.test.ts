// The console's sandbox check routes, end to end over HTTP, against a fake TC that delivers its
// webhooks into the server's real event store. Virtual clock: no network, no real waiting.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { CheckHistory } from "../src/check/history.ts";
import { RetryProbe } from "../src/check/retry-probe.ts";
import { MANUAL_ROWS, newCheckRun } from "../src/check/sandbox-check.ts";
import type { CheckRun } from "../src/check/types.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { clearRegisteredSecrets, registerSecret, setLogSink } from "../src/log.ts";
import { CheckManager } from "../src/server/check-manager.ts";
import { createConsoleServer } from "../src/server/console-server.ts";
import { Coverage } from "../src/server/coverage.ts";
import { LiveGuard } from "../src/server/live-guard.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import { EventStore } from "../src/webhooks/store.ts";
import { FAKE_BASE, FakeClock, FakeTc, refusingListener } from "./helpers/fake-tc.ts";
import { closeServer, listenLocal, send, type TestResponse } from "./helpers/http.ts";
import { makeSecret } from "./helpers/tc-signer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_KEY = `tc_test_${"4d".repeat(24)}`;
const LIVE_KEY = `tc_live_${"5e".repeat(24)}`;
const TEST_SECRET = makeSecret();
const TOKEN = "check-console-token-0123456789";

let dir: string;
let config: Config;
let guard: LiveGuard;
let store: EventStore;
let coverage: Coverage;
let checks: CheckManager;
let tc: FakeTc;
let clock: FakeClock;
let server: Server;
let port: number;
let restoreSink: ReturnType<typeof setLogSink>;
const responses: string[] = [];

async function call(method: string, apiPath: string, body?: unknown, env: string = guard.environment): Promise<TestResponse> {
  const headers: Record<string, string> = { "x-console-token": TOKEN, "x-console-environment": env };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await send(port, { method, path: apiPath, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  responses.push(res.text);
  return res;
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tc-check-console-"));
  restoreSink = setLogSink(() => {});
  config = loadConfig({
    TC_BASE_URL: FAKE_BASE,
    TC_TEST_API_KEY: TEST_KEY,
    TC_TEST_WEBHOOK_SECRET: TEST_SECRET,
    TC_LIVE_API_KEY: LIVE_KEY,
    TC_ALLOW_LIVE: "true",
    DATA_DIR: dir,
  });
  for (const s of [TEST_KEY, LIVE_KEY, TEST_SECRET]) registerSecret(s);
  guard = new LiveGuard({ liveAvailable: true });
  store = await EventStore.open(dir);
  coverage = await Coverage.open(dir);
  store.onEvent((event) => coverage.recordEvent(event));
  clock = new FakeClock();
  tc = new FakeTc({ clock });
  const probe = new RetryProbe({ now: () => clock.now() });
  tc.retryProbe = probe;
  checks = new CheckManager({
    config,
    store,
    events: tc.eventSource(store),
    coverage,
    retryProbe: probe,
    listenerUrl: "http://127.0.0.1:9/webhooks/tc/sandbox",
    fetch: tc.fetch,
    listenerFetch: refusingListener,
    clock,
  });
  server = createConsoleServer({ config, guard, store, coverage, checks, token: TOKEN, publicDir: path.resolve(here, "..", "public"), fetch: tc.fetch });
  port = await listenLocal(server);
});

after(async () => {
  await checks.settled();
  await closeServer(server);
  await flushJsonWrites();
  setLogSink(restoreSink);
  clearRegisteredSecrets();
  await rm(dir, { recursive: true, force: true });
});

describe("console: the sandbox check", () => {
  it("has no run before the first one", async () => {
    const res = await call("GET", "/api/check/current");
    assert.equal(res.status, 200);
    assert.equal(res.json.data.run, null);
    assert.equal(res.json.data.retry_available, true);
    assert.deepEqual((await call("GET", "/api/check/runs")).json.data.runs, []);
  });

  it("does not run in live mode, and calls nothing", async () => {
    assert.equal((await call("POST", "/api/environment", { environment: "live", typed: "LIVE" })).status, 200);
    const before = tc.requests.length;
    const res = await call("POST", "/api/check/run", { test_retries: false });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "SANDBOX_ONLY");
    assert.equal(tc.requests.length, before);
    assert.equal((await call("POST", "/api/environment", { environment: "sandbox" })).status, 200);
  });

  it("refuses a page that still thinks it is in live mode", async () => {
    const res = await call("POST", "/api/check/run", {}, "live");
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "ENVIRONMENT_CHANGED");
  });

  let runId: string;

  it("starts a run in sandbox mode, refuses a second one while it runs, and finishes", async () => {
    const res = await call("POST", "/api/check/run", { test_retries: true });
    assert.equal(res.status, 200, res.text);
    const run = res.json.data.run as CheckRun;
    runId = run.id;
    assert.equal(run.source, "console");
    assert.equal(run.options.test_retries, true);
    assert.ok(run.rows.length > 40);

    const second = await call("POST", "/api/check/run", {});
    assert.equal(second.status, 409);
    assert.equal(second.json.error.code, "CHECK_RUNNING");

    await checks.settled();
    const current = await call("GET", "/api/check/current");
    const done = current.json.data.run as CheckRun;
    assert.equal(done.id, runId);
    assert.equal(done.state, "finished");
    assert.equal(current.json.data.running, false);
    assert.equal(done.summary.failed, 0, JSON.stringify(done.rows.filter((r) => r.status === "fail").map((r) => [r.id, r.reason])));
    assert.equal(done.rows.find((r) => r.id === "webhooks.retry")!.status, "pass");
    assert.match(current.json.data.report, /^Trade Connector sandbox check\n/);
  });

  it("uses only the sandbox key", () => {
    assert.ok(tc.authorizations.has(`Bearer ${TEST_KEY}`));
    assert.ok(!tc.authorizations.has(`Bearer ${LIVE_KEY}`));
  });

  it("keeps the run in data/ and lists it", async () => {
    const runs = (await call("GET", "/api/check/runs")).json.data.runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, runId);
    const one = await call("GET", `/api/check/runs/${runId}`);
    assert.equal(one.json.data.run.id, runId);
    assert.equal(one.json.data.previous, null);
    assert.equal((await call("GET", "/api/check/runs/nope")).status, 404);
    const saved = JSON.parse(await readFile(path.join(dir, "sandbox-check-runs.json"), "utf8"));
    assert.equal(saved.runs[0].id, runId);
  });

  it("ticks the Test coverage checklist as it goes", async () => {
    const report = (await call("GET", "/api/coverage")).json.data;
    for (const op of ["jobs.create", "jobs.update", "jobs.cancel", "jobs.notes", "attachments.complete", "sandbox.simulate", "reference.accreditations"]) {
      assert.ok(report.endpoints.find((e: { operation: string }) => e.operation === op).sandbox?.ok_at, op);
    }
    assert.ok(report.events.find((e: { type: string }) => e.type === "job.evidence_ready").sandbox, "events too");
  });

  it("keeps watching after the run: a replayed delivery ticks the manual item, and it is saved", async () => {
    tc.replay(tc.delivered[0]!.webhookId);
    await tc.deliverDue(store);
    const current = (await call("GET", "/api/check/current")).json.data.run as CheckRun;
    assert.equal(current.rows.find((r) => r.id === "webhooks.manual.replay")!.status, "pass");
    await checks.settled();
    const saved = JSON.parse(await readFile(path.join(dir, "sandbox-check-runs.json"), "utf8"));
    assert.equal(saved.runs[0].rows.find((r: { id: string }) => r.id === "webhooks.manual.replay").status, "pass");
  });

  it("compares a second run with the first", async () => {
    const res = await call("POST", "/api/check/run", { test_retries: false });
    assert.equal(res.status, 200);
    await checks.settled();
    const current = (await call("GET", "/api/check/current")).json.data;
    assert.notEqual(current.run.id, runId);
    assert.equal(current.previous.id, runId);
    assert.equal(current.previous.statuses["webhooks.manual.replay"], "pass");
    assert.equal((await call("GET", "/api/check/runs")).json.data.runs.length, 2);
  });

  it("shows a newer run from npm run check:sandbox as the latest, and ticks manual items on it", async () => {
    await checks.settled();
    const consoleRunId = (await call("GET", "/api/check/current")).json.data.run.id as string;
    // npm run check:sandbox, run while npm start is up, saves its finished run into the same file.
    const cli = newCheckRun({ source: "cli", baseUrl: FAKE_BASE, apiKey: TEST_KEY, testRetries: false, now: clock.now() + 60_000 });
    cli.state = "finished";
    cli.finished_at = new Date(clock.now() + 120_000).toISOString();
    cli.start_seq = store.listEvents({ limit: 1 })[0]?.seq ?? 0;
    await new CheckHistory(dir).save(cli);

    const current = (await call("GET", "/api/check/current")).json.data;
    assert.equal(current.run.id, cli.id, "the newest run, not the one this server ran last");
    assert.equal(current.run.source, "cli");
    assert.equal(current.previous.id, consoleRunId, "compared with the console's run before it");
    const runs = (await call("GET", "/api/check/runs")).json.data.runs as Array<{ id: string }>;
    assert.deepEqual(runs.map((r) => r.id).slice(0, 2), [cli.id, consoleRunId], "newest first, each with its own id");
    assert.equal((await call("GET", `/api/check/runs/${cli.id}`)).json.data.run.id, cli.id, "it can be opened by its id");

    // Send test event in TC: the tick goes to the newest run (the command line's), not the console's.
    tc.queue("webhook.test", { ...tc.delivered[0]!.job, id: "00000000-0000-0000-0000-000000000000" });
    await tc.deliverDue(store);
    const ticked = (await call("GET", "/api/check/current")).json.data.run as CheckRun;
    assert.equal(ticked.id, cli.id);
    assert.equal(ticked.rows.find((r) => r.id === MANUAL_ROWS.testEvent)!.status, "pass");
    await checks.settled();
    const saved = JSON.parse(await readFile(path.join(dir, "sandbox-check-runs.json"), "utf8")) as { runs: CheckRun[] };
    const status = (id: string) => saved.runs.find((r) => r.id === id)!.rows.find((r) => r.id === MANUAL_ROWS.testEvent)!.status;
    assert.equal(status(cli.id), "pass", "saved on the command line's run");
    assert.equal(status(consoleRunId), "needs_you", "the console's older run is left alone");
  });

  it("never sends a key or secret to the page", () => {
    for (const text of responses) {
      for (const secret of [TEST_KEY, LIVE_KEY, TEST_SECRET, TEST_SECRET.slice(6)]) assert.ok(!text.includes(secret));
    }
  });
});

describe("console: the sandbox check without a test key", () => {
  it("answers 400 NO_API_KEY and calls nothing", async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), "tc-check-console-"));
    const cfg = loadConfig({ TC_BASE_URL: FAKE_BASE, DATA_DIR: localDir });
    const localStore = await EventStore.open(localDir);
    const localCoverage = await Coverage.open(localDir);
    const fake = new FakeTc({ clock: new FakeClock() });
    const manager = new CheckManager({ config: cfg, store: localStore, events: fake.eventSource(localStore), retryProbe: null, listenerUrl: "http://127.0.0.1:9/x", fetch: fake.fetch });
    const localServer = createConsoleServer({ config: cfg, guard: new LiveGuard({ liveAvailable: false }), store: localStore, coverage: localCoverage, checks: manager, token: TOKEN, publicDir: path.resolve(here, "..", "public") });
    const localPort = await listenLocal(localServer);
    try {
      const res = await send(localPort, {
        method: "POST",
        path: "/api/check/run",
        headers: { "x-console-token": TOKEN, "x-console-environment": "sandbox", "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 400);
      assert.equal(res.json.error.code, "NO_API_KEY");
      assert.equal(fake.requests.length, 0);
      const current = await send(localPort, { path: "/api/check/current", headers: { "x-console-token": TOKEN } });
      assert.equal(current.json.data.retry_available, false);
    } finally {
      await closeServer(localServer);
      await rm(localDir, { recursive: true, force: true });
    }
  });
});
