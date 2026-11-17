// The console server end to end, against a fake Trade Connector (no network).

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { loadConfig, type Config } from "../src/config.ts";
import { clearRegisteredSecrets, registerSecret, setLogSink } from "../src/log.ts";
import { createConsoleServer } from "../src/server/console-server.ts";
import { Coverage } from "../src/server/coverage.ts";
import { LiveGuard } from "../src/server/live-guard.ts";
import { flushJsonWrites } from "../src/store/json-file.ts";
import { EventStore } from "../src/webhooks/store.ts";
import { closeServer, listenLocal, send, type TestResponse } from "./helpers/http.ts";
import { makeSecret, sampleJob } from "./helpers/tc-signer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_KEY = `tc_test_${"1a".repeat(24)}`;
const LIVE_KEY = `tc_live_${"2b".repeat(24)}`;
const TEST_SECRET = makeSecret();
const LIVE_SECRET = makeSecret();
const SECRETS = [TEST_KEY, LIVE_KEY, TEST_SECRET, LIVE_SECRET];
const TOKEN = "console-token-for-tests-0123456789";

interface TcCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

let server: Server;
let port: number;
let dataDir: string;
let config: Config;
let guard: LiveGuard;
const tcCalls: TcCall[] = [];
const responses: string[] = [];
const logLines: string[] = [];
let restoreSink: ReturnType<typeof setLogSink>;

function tcError(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error_code: code, error: { code, message, request_id: `req-${code}` } }), {
    status,
    headers: { "content-type": "application/json", "x-request-id": `req-${code}` },
  });
}

/** A fake TC that answers a handful of routes. */
const fakeTc = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const route = url.pathname.replace("/functions/v1/partner-api", "");
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  tcCalls.push({ method, path: route, authorization: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-ok" } });

  if (method === "GET" && route === "/v1/health") return json(200, { status: "ok", version: "v1" });
  if (method === "POST" && route === "/v1/jobs") return json(201, sampleJob({ title: (tcCalls.at(-1)!.body as { title: string }).title }));
  if (method === "GET" && route === "/v1/jobs") return json(200, { data: [sampleJob()], has_more: false, next_cursor: null });
  if (method === "GET" && route === "/v1/reference/trade-types") return tcError(403, "SCOPE_FORBIDDEN", "API key lacks required scope 'reference:read'");
  if (method === "POST" && /\/cancel$/.test(route)) {
    return json(200, { success: true, job_id: "j", status: "CANCELLED", previous_status: "OPEN", cancelled_by_role: "CLIENT", fee_applied: false, fee_amount_cents: 0, gst_cents: 0, cancellation_type: "CLEAN", trade_notified: false, payment_cancelled: false, charge_status: "NONE", invoice_number: null, card_last4: null, decline_reason: null, message: "Job cancelled successfully." });
  }
  return tcError(404, "NOT_FOUND", `Route ${method} ${route} not found`);
}) as typeof fetch;

async function call(
  method: string,
  apiPath: string,
  options: { body?: unknown; headers?: Record<string, string>; env?: string | null; token?: string | null } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token !== null) headers["x-console-token"] = options.token ?? TOKEN;
  if (options.env !== null) headers["x-console-environment"] = options.env ?? guard.environment;
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const res = await send(port, { method, path: apiPath, headers, ...(body !== undefined ? { body } : {}) });
  responses.push(res.text);
  return res;
}

const newJob = { job: { title: "Example job", description: "Example", site: { address: "12 Example St", suburb: "Exampleton", state: "NSW", postcode: "2000" } }, idempotency_key: "idem-1" };

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "tc-console-"));
  config = loadConfig({
    TC_BASE_URL: "https://tc.example.test/functions/v1/partner-api",
    TC_TEST_API_KEY: TEST_KEY,
    TC_TEST_WEBHOOK_SECRET: TEST_SECRET,
    TC_LIVE_API_KEY: LIVE_KEY,
    TC_LIVE_WEBHOOK_SECRET: LIVE_SECRET,
    TC_ALLOW_LIVE: "true",
    DATA_DIR: dataDir,
  });
  for (const s of SECRETS) registerSecret(s);
  restoreSink = setLogSink((_level, line) => logLines.push(line));
  guard = new LiveGuard({ liveAvailable: config.liveAvailable, liveUnavailableReason: config.liveUnavailableReason });
  server = createConsoleServer({
    config,
    guard,
    store: await EventStore.open(dataDir),
    coverage: await Coverage.open(dataDir),
    token: TOKEN,
    publicDir: path.resolve(here, "..", "public"),
    fetch: fakeTc,
  });
  port = await listenLocal(server);
});

after(async () => {
  await closeServer(server);
  await flushJsonWrites();
  setLogSink(restoreSink);
  clearRegisteredSecrets();
  await rm(dataDir, { recursive: true, force: true });
});

describe("console security", () => {
  it("refuses a Host header that is not the console's own (DNS rebinding)", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, `192.168.1.10:${port}`]) {
      const res = await send(port, { path: "/api/status", headers: { host, "x-console-token": TOKEN } });
      assert.equal(res.status, 403, host);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await send(port, { path: "/api/status", headers: { host, "x-console-token": TOKEN } });
      assert.equal(res.status, 200, host);
    }
  });

  it("requires the per-run token on every API call", async () => {
    assert.equal((await call("GET", "/api/status", { token: null })).status, 401);
    assert.equal((await call("GET", "/api/status", { token: "wrong" })).status, 401);
    assert.equal((await call("GET", "/api/status", { token: TOKEN.slice(0, -1) + "X" })).status, 401);
    assert.equal((await call("POST", "/api/jobs", { token: null, body: newJob })).status, 401);
    assert.equal(tcCalls.length, 0, "nothing reached TC");
    assert.equal((await call("GET", "/api/status")).status, 200);
  });

  it("refuses cross-origin requests", async () => {
    const res = await call("GET", "/api/status", { headers: { origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal((await call("GET", "/api/status", { headers: { origin: `http://127.0.0.1:${port}` } })).status, 200);
  });

  it("serves the page without the token, with a strict CSP, and nothing outside the fixed list", async () => {
    const page = await send(port, { path: "/" });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.equal((await send(port, { path: "/../package.json" })).status, 404);
    assert.equal((await send(port, { path: "/.env" })).status, 404);
  });

  it("shows only key prefixes in status", async () => {
    const res = await call("GET", "/api/status");
    assert.equal(res.json.data.environment, "sandbox");
    assert.equal(res.json.data.keys.sandbox.api_key, "tc_test_1a1a…");
    assert.equal(res.json.data.keys.live.api_key, "tc_live_2b2b…");
    assert.equal(res.json.data.keys.sandbox.webhook_secret_configured, true);
  });
});

describe("sandbox mode", () => {
  it("creates a job with the test key and an Idempotency-Key, no confirmation needed", async () => {
    tcCalls.length = 0;
    const res = await call("POST", "/api/jobs", { body: newJob });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.title, "Example job");
    assert.equal(tcCalls[0]!.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(res.json.calls[0].status, 201);
    assert.equal(res.json.calls[0].request_id, "req-ok");
  });

  it("passes TC errors through with code, message, request_id and a hint", async () => {
    const res = await call("GET", "/api/reference/trade-types");
    assert.equal(res.status, 403);
    assert.equal(res.json.error.source, "tc");
    assert.equal(res.json.error.code, "SCOPE_FORBIDDEN");
    assert.equal(res.json.error.request_id, "req-SCOPE_FORBIDDEN");
    assert.match(res.json.error.hint, /reference:read/);
  });

  it("refuses when the page's idea of the environment is stale", async () => {
    tcCalls.length = 0;
    const res = await call("POST", "/api/jobs", { body: newJob, env: "live" });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "ENVIRONMENT_CHANGED");
    assert.equal(tcCalls.length, 0);
  });

  it("refuses installs (they have no sandbox)", async () => {
    tcCalls.length = 0;
    const res = await call("GET", "/api/installs");
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, "LIVE_ONLY");
    assert.equal(tcCalls.length, 0);
  });
});

describe("live mode", () => {
  it("cannot be entered without typing LIVE", async () => {
    const res = await call("POST", "/api/environment", { body: { environment: "live", typed: "yes" } });
    assert.equal(res.status, 400);
    assert.equal(guard.environment, "sandbox");
    const ok = await call("POST", "/api/environment", { body: { environment: "live", typed: "LIVE" } });
    assert.equal(ok.status, 200);
    assert.equal(guard.environment, "live");
  });

  it("refuses a live write that carries no confirmation token, before calling TC", async () => {
    tcCalls.length = 0;
    const res = await call("POST", "/api/jobs", { body: newJob });
    assert.equal(res.status, 428);
    assert.equal(res.json.error.code, "LIVE_CONFIRMATION_REQUIRED");
    assert.equal(tcCalls.length, 0);
  });

  it("issues a token only when LIVE is typed", async () => {
    const res = await call("POST", "/api/live/confirm", { body: { action: "create_job", target: "", body: newJob, typed: "live" } });
    assert.equal(res.status, 400);
  });

  it("refuses a token issued for a different body, then accepts a matching one exactly once", async () => {
    tcCalls.length = 0;
    const wrong = await call("POST", "/api/live/confirm", { body: { action: "create_job", target: "", body: { ...newJob, idempotency_key: "other" }, typed: "LIVE" } });
    const mismatch = await call("POST", "/api/jobs", { body: newJob, headers: { "x-live-confirmation": wrong.json.data.token } });
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.json.error.code, "LIVE_CONFIRMATION_MISMATCH");
    assert.equal(tcCalls.length, 0);

    const good = await call("POST", "/api/live/confirm", { body: { action: "create_job", target: "", body: newJob, typed: "LIVE" } });
    const created = await call("POST", "/api/jobs", { body: newJob, headers: { "x-live-confirmation": good.json.data.token } });
    assert.equal(created.status, 200);
    assert.equal(tcCalls.length, 1);
    assert.equal(tcCalls[0]!.authorization, `Bearer ${LIVE_KEY}`);

    const replay = await call("POST", "/api/jobs", { body: newJob, headers: { "x-live-confirmation": good.json.data.token } });
    assert.equal(replay.status, 403);
    assert.equal(tcCalls.length, 1, "a used token never reaches TC again");
  });

  it("binds a cancel token to that job", async () => {
    tcCalls.length = 0;
    const token = (await call("POST", "/api/live/confirm", { body: { action: "cancel_job", target: "job-A", body: { reason: "x" }, typed: "LIVE" } })).json.data.token;
    const other = await call("POST", "/api/jobs/job-B/cancel", { body: { reason: "x" }, headers: { "x-live-confirmation": token } });
    assert.equal(other.status, 403);
    assert.equal(tcCalls.length, 0);
  });

  it("allows reads without a confirmation", async () => {
    tcCalls.length = 0;
    const res = await call("GET", "/api/jobs?status=OPEN&limit=5");
    assert.equal(res.status, 200);
    assert.equal(tcCalls[0]!.authorization, `Bearer ${LIVE_KEY}`);
  });

  it("never offers simulate", async () => {
    tcCalls.length = 0;
    const res = await call("POST", "/api/jobs/job-A/simulate", { body: { status: "ASSIGNED" } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "SANDBOX_ONLY");
    assert.equal(tcCalls.length, 0);
  });

  it("returns to sandbox without ceremony", async () => {
    const res = await call("POST", "/api/environment", { body: { environment: "sandbox" } });
    assert.equal(res.status, 200);
    assert.equal(guard.environment, "sandbox");
  });
});

describe("secrets", () => {
  it("never appear in any console API response, log line or data file", async () => {
    await flushJsonWrites();
    const files = await readdir(dataDir);
    const fileTexts = await Promise.all(files.map((f) => readFile(path.join(dataDir, f), "utf8")));
    assert.ok(responses.length > 10);
    assert.ok(logLines.length > 0);
    for (const secret of SECRETS) {
      for (const text of [...responses, ...logLines, ...fileTexts]) {
        assert.ok(!text.includes(secret), `a secret leaked into: ${text.slice(0, 120)}`);
      }
      // Not even the base64 part of a webhook secret.
      if (secret.startsWith("whsec_")) {
        const b64 = secret.slice(6);
        for (const text of [...responses, ...logLines, ...fileTexts]) assert.ok(!text.includes(b64));
      }
    }
  });
});
