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
import { findRoute, runRoute } from "../src/server/console-api.ts";
import { createConsoleServer } from "../src/server/console-server.ts";
import { Coverage } from "../src/server/coverage.ts";
import { LiveGuard, type LiveAction } from "../src/server/live-guard.ts";
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
const JOB_ID = "6f1c2a8e-1111-4c4c-9d9d-000000000001";
const OTHER_JOB_ID = "6f1c2a8e-1111-4c4c-9d9d-000000000009";
const UPLOAD_ID = "11111111-2222-4333-8444-555555555555";
const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

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
let store: EventStore;
let coverage: Coverage;
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

/** A fake TC (and its storage, for attachment uploads) that answers a handful of routes. */
const fakeTc = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  if (url.host === "storage.example.test") {
    tcCalls.push({ method, path: `storage:${url.pathname}`, authorization: headers.get("authorization"), body: null });
    return new Response(JSON.stringify({ Key: "x" }), { status: 200 });
  }
  const route = url.pathname.replace("/functions/v1/partner-api", "");
  tcCalls.push({ method, path: route, authorization: headers.get("authorization"), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-ok" } });

  if (method === "GET" && route === "/v1/health") return json(200, { status: "ok", version: "v1" });
  if (method === "POST" && route === "/v1/jobs") return json(201, sampleJob({ title: (tcCalls.at(-1)!.body as { title: string }).title }));
  if (method === "GET" && route === "/v1/jobs") return json(200, { data: [sampleJob()], has_more: false, next_cursor: null });
  if (method === "GET" && route === "/v1/reference/trade-types") return tcError(403, "SCOPE_FORBIDDEN", "API key lacks required scope 'reference:read'");
  if (method === "PATCH" && /^\/v1\/jobs\/[^/]+$/.test(route)) return json(200, sampleJob());
  if (method === "POST" && /^\/v1\/jobs\/[^/]+\/notes$/.test(route)) {
    return json(201, { id: "n1", audit_log_id: 1, message_id: null, job_id: JOB_ID, body: "x", note: "x", author_user_id: null, author_source: "partner_api", created_at: "2026-11-17T01:00:00Z" });
  }
  if (method === "POST" && /^\/v1\/jobs\/[^/]+\/attachments$/.test(route)) {
    const req = tcCalls.at(-1)!.body as { filename: string; content_type: string; size_bytes: number };
    return json(201, { attachment_id: UPLOAD_ID, job_id: JOB_ID, bucket: "job-documents", storage_path: `${JOB_ID}/c1/partner-api/${UPLOAD_ID}_${req.filename}`, upload_url: "https://storage.example.test/upload/sign/x?token=t", token: "t", expires_in: 7200, filename: req.filename, content_type: req.content_type, size_bytes: req.size_bytes });
  }
  if (method === "POST" && /\/attachments\/[^/]+\/complete$/.test(route)) {
    const req = tcCalls.at(-1)!.body as { filename: string; is_public?: boolean };
    return json(201, { id: UPLOAD_ID, job_id: JOB_ID, filename: req.filename, file_name: req.filename, mime_type: "image/png", file_type: "image/png", file_size: 8, category: null, storage_path: "x", is_public: req.is_public ?? true, created_at: "2026-11-17T01:00:00Z" });
  }
  if (method === "POST" && route === "/v1/installs") return json(201, { serial_number: "SN-1", status: "REGISTERED" });
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
  store = await EventStore.open(dataDir);
  coverage = await Coverage.open(dataDir);
  server = createConsoleServer({
    config,
    guard,
    store,
    coverage,
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

  it("uploads an attachment only with an explicit is_public, and passes it to step 3", async () => {
    tcCalls.length = 0;
    const file = { filename: "invoice.png", content_type: "image/png", data_base64: PNG_BASE64, category: "INVOICE" };
    const missing = await call("POST", `/api/jobs/${JOB_ID}/attachments`, { body: file });
    assert.equal(missing.status, 400);
    assert.match(missing.json.error.message, /is_public/);
    assert.equal(tcCalls.length, 0, "TC would have made the file public: nothing sent");

    const ok = await call("POST", `/api/jobs/${JOB_ID}/attachments`, { body: { ...file, is_public: false } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.data.is_public, false);
    const [step1, , step3] = tcCalls;
    assert.equal((step1!.body as Record<string, unknown>).is_public, undefined, "step 1 refuses is_public");
    assert.equal((step3!.body as Record<string, unknown>).is_public, false);
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
    const token = (await call("POST", "/api/live/confirm", { body: { action: "cancel_job", target: JOB_ID, body: { reason: "x" }, typed: "LIVE" } })).json.data.token;
    const other = await call("POST", `/api/jobs/${OTHER_JOB_ID}/cancel`, { body: { reason: "x" }, headers: { "x-live-confirmation": token } });
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
    const res = await call("POST", `/api/jobs/${JOB_ID}/simulate`, { body: { status: "ASSIGNED" } });
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

interface WriteRoute {
  action: LiveAction;
  method: "POST" | "PATCH";
  path: string;
  /** Bound to a job (the token's target is the job id) or not (target ""). */
  target: string;
  body: Record<string, unknown>;
  /** The same request with one value changed: a token for this must not work for `body`. */
  changed: Record<string, unknown>;
  /** The requests one confirmed write makes ("storage:" = the signed upload URL, not TC). */
  expected: string[];
}

const WRITE_ROUTES: WriteRoute[] = [
  { action: "create_job", method: "POST", path: "/api/jobs", target: "", body: newJob, changed: { ...newJob, idempotency_key: "idem-2" }, expected: ["POST /v1/jobs"] },
  { action: "update_job", method: "PATCH", path: `/api/jobs/${JOB_ID}`, target: JOB_ID, body: { patch: { title: "New title" } }, changed: { patch: { title: "Other title" } }, expected: [`PATCH /v1/jobs/${JOB_ID}`] },
  { action: "publish_job", method: "POST", path: `/api/jobs/${JOB_ID}/publish`, target: JOB_ID, body: {}, changed: { publish: true }, expected: [`PATCH /v1/jobs/${JOB_ID}`] },
  { action: "add_note", method: "POST", path: `/api/jobs/${JOB_ID}/notes`, target: JOB_ID, body: { body: "Gate code changed" }, changed: { body: "Gate code unchanged" }, expected: [`POST /v1/jobs/${JOB_ID}/notes`] },
  {
    action: "upload_attachment",
    method: "POST",
    path: `/api/jobs/${JOB_ID}/attachments`,
    target: JOB_ID,
    body: { filename: "site.png", content_type: "image/png", data_base64: PNG_BASE64, title: "Site", is_public: false },
    changed: { filename: "site.png", content_type: "image/png", data_base64: PNG_BASE64, title: "Site", is_public: true },
    expected: [`POST /v1/jobs/${JOB_ID}/attachments`, "PUT storage:/upload/sign/x", `POST /v1/jobs/${JOB_ID}/attachments/${UPLOAD_ID}/complete`],
  },
  { action: "cancel_job", method: "POST", path: `/api/jobs/${JOB_ID}/cancel`, target: JOB_ID, body: { reason: "Customer moved" }, changed: { reason: "Customer stayed" }, expected: [`POST /v1/jobs/${JOB_ID}/cancel`] },
  { action: "upsert_install", method: "POST", path: "/api/installs", target: "", body: { install: { serial_number: "SN-1" } }, changed: { install: { serial_number: "SN-2" } }, expected: ["POST /v1/installs"] },
];

describe("live mode: every write route needs its own confirmation", () => {
  before(async () => {
    assert.equal((await call("POST", "/api/environment", { body: { environment: "live", typed: "LIVE" } })).status, 200);
  });
  after(async () => {
    assert.equal((await call("POST", "/api/environment", { body: { environment: "sandbox" } })).status, 200);
  });

  it("covers all seven write actions", () => {
    assert.deepEqual(WRITE_ROUTES.map((r) => r.action).sort(), ["add_note", "cancel_job", "create_job", "publish_job", "update_job", "upload_attachment", "upsert_install"]);
  });

  for (const r of WRITE_ROUTES) {
    it(`${r.action}: no token 428; a token for another action, job or body 403; a matching one makes the call with the live key`, async () => {
      const confirm = async (overrides: Record<string, unknown> = {}) => {
        const res = await call("POST", "/api/live/confirm", { body: { action: r.action, target: r.target, body: r.body, typed: "LIVE", ...overrides } });
        assert.equal(res.status, 200, res.text);
        return res.json.data.token as string;
      };
      tcCalls.length = 0;

      const none = await call(r.method, r.path, { body: r.body });
      assert.equal(none.status, 428, none.text);
      assert.equal(none.json.error.code, "LIVE_CONFIRMATION_REQUIRED");

      const otherAction = r.action === "add_note" ? "cancel_job" : "add_note";
      const wrongs: Array<[string, Record<string, unknown>]> = [
        ["another action", { action: otherAction }],
        ["another job", { target: OTHER_JOB_ID }],
        ["another body", { body: r.changed }],
      ];
      for (const [label, overrides] of wrongs) {
        const token = await confirm(overrides);
        const res = await call(r.method, r.path, { body: r.body, headers: { "x-live-confirmation": token } });
        assert.equal(res.status, 403, `${label}: ${res.text}`);
        assert.equal(res.json.error.code, "LIVE_CONFIRMATION_MISMATCH", label);
      }
      assert.equal(tcCalls.length, 0, "nothing reached TC without a matching confirmation");

      const ok = await call(r.method, r.path, { body: r.body, headers: { "x-live-confirmation": await confirm() } });
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual(tcCalls.map((c) => `${c.method} ${c.path}`), r.expected);
      for (const c of tcCalls) {
        assert.equal(c.authorization, c.path.startsWith("storage:") ? null : `Bearer ${LIVE_KEY}`, `${c.method} ${c.path}`);
      }
    });
  }
});

describe("live mode: a switch while a write is being handled", () => {
  it("refuses the write (409) and sends nothing, although the call already holds the live key", async () => {
    const raceGuard = new LiveGuard({ liveAvailable: true });
    raceGuard.switchTo("live", "LIVE");
    const body = { body: "hello" };
    const token = raceGuard.issue({ action: "add_note", target: JOB_ID, body, typed: "LIVE" }).token;
    // Building the call's TC client reads config.baseUrl. Switching to sandbox there puts the
    // switch exactly between the call capturing "live" (and the live key) and the guard check,
    // as another tab could if a handler ever awaited something first.
    const racingConfig: Config = { ...config, get baseUrl() { raceGuard.switchTo("sandbox"); return config.baseUrl; } };
    const found = findRoute("POST", `/api/jobs/${JOB_ID}/notes`)!;
    tcCalls.length = 0;
    const result = await runRoute({ config: racingConfig, guard: raceGuard, store, coverage, fetch: fakeTc }, found, {
      method: "POST",
      query: new URLSearchParams(),
      body,
      liveToken: token,
    });
    assert.equal(raceGuard.environment, "sandbox");
    assert.equal(result.status, 409);
    assert.equal((result.body as { error: { code: string } }).error.code, "ENVIRONMENT_CHANGED");
    assert.equal(tcCalls.length, 0);
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
