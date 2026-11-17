import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jobIdSegment, paginate, TcClient, type ResponseInfo } from "../src/tc/client.ts";
import { parseRetryAfter, TcApiError } from "../src/tc/errors.ts";
import { sampleJob } from "./helpers/tc-signer.ts";

const BASE = "https://tc.example.test/functions/v1/partner-api";
const KEY = `tc_test_${"ab".repeat(24)}`;

interface Captured {
  url: URL;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A fake fetch: each call takes the next scripted response. No network. */
function scripted(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Captured[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    const text = next.body === undefined ? "" : typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(text, { status: next.status, headers: { "content-type": "application/json", ...next.headers } });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function tcError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error_code: code, error: { code, message, request_id: "req-123", ...extra } };
}

describe("TcClient", () => {
  it("sends the key as a Bearer token and never to other hosts", async () => {
    const { calls, fetchFn } = scripted([{ status: 200, body: sampleJob() }]);
    const tc = new TcClient({ baseUrl: BASE + "/", apiKey: KEY, fetch: fetchFn });
    await tc.getJob("6f1c2a8e-1111-4c4c-9d9d-000000000001");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(calls[0]!.url.href, `${BASE}/v1/jobs/6f1c2a8e-1111-4c4c-9d9d-000000000001`);
  });

  it("parses TC errors into TcApiError with code, message, details and request_id", async () => {
    const { fetchFn } = scripted([
      {
        status: 400,
        body: tcError("VALIDATION_ERROR", "site.postcode: postcode must be a 4-digit Australian postcode", {
          details: { issues: [{ path: "site.postcode", message: "postcode must be a 4-digit Australian postcode", code: "invalid_format" }] },
        }),
        headers: { "x-request-id": "req-123" },
      },
    ]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await assert.rejects(
      tc.createJob({ title: "t", description: "d", site: { address: "a", suburb: "s", state: "NSW", postcode: "20" } }),
      (error: unknown) => {
        assert.ok(error instanceof TcApiError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "VALIDATION_ERROR");
        assert.match(error.message, /postcode/);
        assert.deepEqual((error.details as { issues: unknown[] }).issues.length, 1);
        assert.equal(error.requestId, "req-123");
        return true;
      },
    );
  });

  it("explains SCOPE_FORBIDDEN for reference data (new keys lack reference:read)", async () => {
    const { fetchFn } = scripted([{ status: 403, body: tcError("SCOPE_FORBIDDEN", "API key lacks required scope 'reference:read'") }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await assert.rejects(tc.listTradeTypes(), (error: unknown) => {
      assert.ok(error instanceof TcApiError);
      assert.equal(error.code, "SCOPE_FORBIDDEN");
      assert.match(error.hint ?? "", /tick|ticked/i);
      assert.match(error.hint ?? "", /reference:read/);
      return true;
    });
  });

  it("gives an environment hint, not a scope hint, for simulate with the wrong key", async () => {
    const { fetchFn } = scripted([{ status: 403, body: tcError("SCOPE_FORBIDDEN", "Sandbox simulation is only available with sandbox (tc_test_) API keys") }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await assert.rejects(tc.simulate("x", "ASSIGNED"), (error: TcApiError) => /one environment/.test(error.hint ?? ""));
  });

  it("handles a non-JSON error body (e.g. a proxy page)", async () => {
    const { fetchFn } = scripted([{ status: 502, body: "<html>Bad gateway</html>", headers: { "content-type": "text/html", "x-request-id": "edge-9" } }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await assert.rejects(tc.health(), (error: TcApiError) => error.code === "UNEXPECTED_RESPONSE" && error.status === 502 && error.requestId === "edge-9");
  });

  it("sends Idempotency-Key on create and reports a replay", async () => {
    const { calls, fetchFn } = scripted([{ status: 200, body: { ...sampleJob(), replayed: true }, headers: { "idempotent-replayed": "true" } }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const job = await tc.createJob({ title: "t", description: "d", site: { address: "a", suburb: "s", state: "NSW", postcode: "2000" } }, { idempotencyKey: "key-1" });
    assert.equal(calls[0]!.headers.get("idempotency-key"), "key-1");
    assert.equal(calls[0]!.headers.get("content-type"), "application/json");
    assert.equal(job.replayed, true);
  });

  it("URL-encodes ext: references", async () => {
    assert.equal(jobIdSegment("ext:SH-10042"), "ext:SH-10042");
    assert.equal(jobIdSegment("ext:WO 10/42?x#y"), "ext:WO%2010%2F42%3Fx%23y");
    assert.equal(jobIdSegment("../../v1/installs"), "..%2F..%2Fv1%2Finstalls");
    const { calls, fetchFn } = scripted([{ status: 200, body: sampleJob() }, { status: 201, body: { id: "n1" } }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await tc.getJob("ext:WO 10/42");
    await tc.addNote("ext:A&B", "hello");
    assert.equal(calls[0]!.url.pathname, "/functions/v1/partner-api/v1/jobs/ext:WO%2010%2F42");
    assert.equal(calls[1]!.url.pathname, "/functions/v1/partner-api/v1/jobs/ext:A%26B/notes");
    assert.deepEqual(JSON.parse(calls[1]!.body!), { body: "hello" });
  });

  it("walks keyset pages with next_cursor (which contains a | and must be encoded)", async () => {
    const cursor1 = "2026-11-17T01:00:00.000000Z|6f1c2a8e-1111-4c4c-9d9d-000000000003";
    const { calls, fetchFn } = scripted([
      { status: 200, body: { data: [sampleJob({ id: "j1" }), sampleJob({ id: "j2" })], has_more: true, next_cursor: cursor1 } },
      { status: 200, body: { data: [sampleJob({ id: "j3" })], has_more: false, next_cursor: null } },
    ]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const ids: string[] = [];
    for await (const job of tc.iterateJobs({ status: ["OPEN", "ASSIGNED"], updated_since: "2026-11-01T00:00:00Z", limit: 2 })) ids.push(job.id);
    assert.deepEqual(ids, ["j1", "j2", "j3"]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url.searchParams.get("status"), "OPEN,ASSIGNED");
    assert.equal(calls[0]!.url.searchParams.get("updated_since"), "2026-11-01T00:00:00Z");
    assert.equal(calls[0]!.url.searchParams.get("limit"), "2");
    assert.equal(calls[0]!.url.searchParams.has("cursor"), false);
    assert.equal(calls[1]!.url.searchParams.get("cursor"), cursor1);
    assert.ok(calls[1]!.url.search.includes("%7C"), "the | in the cursor is percent-encoded");
  });

  it("paginate() stops at maxPages", async () => {
    let n = 0;
    const pages: string[] = [];
    for await (const item of paginate(async () => ({ data: [`p${++n}`], has_more: true, next_cursor: `c${n}` }), { maxPages: 3 })) pages.push(item);
    assert.deepEqual(pages, ["p1", "p2", "p3"]);
  });

  it("waits for Retry-After on 429 and retries, a bounded number of times", async () => {
    const slept: number[] = [];
    const { calls, fetchFn } = scripted([
      { status: 429, body: tcError("RATE_LIMITED", "Rate limit exceeded."), headers: { "retry-after": "2" } },
      { status: 429, body: tcError("RATE_LIMITED", "Rate limit exceeded."), headers: { "retry-after": "1" } },
      { status: 200, body: { status: "ok", version: "v1" } },
    ]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn, sleep: async (ms) => { slept.push(ms); } });
    assert.deepEqual(await tc.health(), { status: "ok", version: "v1" });
    assert.deepEqual(slept, [2000, 1000]);
    assert.equal(calls.length, 3);
  });

  it("gives up after maxRetries, or when Retry-After is too long", async () => {
    const limited = { status: 429, body: tcError("RATE_LIMITED", "Rate limit exceeded."), headers: { "retry-after": "1" } };
    const a = scripted([limited, limited, limited]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: a.fetchFn, maxRetries: 2, sleep: async () => {} });
    await assert.rejects(tc.listJobs(), (error: TcApiError) => error.code === "RATE_LIMITED" && error.retryAfterSeconds === 1);
    assert.equal(a.calls.length, 3);

    const b = scripted([{ ...limited, headers: { "retry-after": "3600" } }]);
    const slow = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: b.fetchFn, sleep: async () => assert.fail("must not wait an hour") });
    await assert.rejects(slow.listJobs(), (error: TcApiError) => error.code === "RATE_LIMITED");
    assert.equal(b.calls.length, 1);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    assert.equal(parseRetryAfter("7"), 7);
    assert.equal(parseRetryAfter(new Date(Date.UTC(2026, 10, 17, 0, 0, 30)).toUTCString(), Date.UTC(2026, 10, 17, 0, 0, 0)), 30);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter(null), null);
  });

  it("reports each exchange to onResponse without the key", async () => {
    const seen: ResponseInfo[] = [];
    const { fetchFn } = scripted([
      { status: 404, body: tcError("NOT_FOUND", "Job with external_reference 'NOPE' not found"), headers: { "x-request-id": "r-404", "x-ratelimit-limit": "120", "x-ratelimit-remaining": "119", "x-ratelimit-reset": "1800000000" } },
    ]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn, onResponse: (i) => seen.push(i) });
    await assert.rejects(tc.getJob("ext:NOPE"));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.operation, "jobs.get");
    assert.equal(seen[0]!.status, 404);
    assert.equal(seen[0]!.errorCode, "NOT_FOUND");
    assert.equal(seen[0]!.requestId, "r-404");
    assert.deepEqual(seen[0]!.rateLimit, { limit: 120, remaining: 119, resetEpochSeconds: 1800000000 });
    assert.ok(!JSON.stringify(seen).includes(KEY));
  });

  it("wraps network failures as NETWORK_ERROR without leaking the key", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await assert.rejects(tc.health(), (error: TcApiError) => error.code === "NETWORK_ERROR" && error.status === 0 && !error.message.includes(KEY));
  });

  it("uploads an attachment in three steps, sending the key only to TC", async () => {
    const upload = {
      attachment_id: "11111111-2222-4333-8444-555555555555",
      job_id: "j1",
      bucket: "job-documents",
      storage_path: "j1/c1/partner-api/11111111-2222-4333-8444-555555555555_site.png",
      upload_url: "https://storage.example.test/upload/sign/job-documents/x?token=abc",
      token: "abc",
      expires_in: 7200,
      filename: "site.png",
      content_type: "image/png",
      size_bytes: 4,
    };
    const { calls, fetchFn } = scripted([
      { status: 201, body: upload },
      { status: 200, body: { Key: "x" } },
      { status: 201, body: { id: upload.attachment_id, filename: "site.png" } },
    ]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    const record = await tc.uploadAttachment("j1", { filename: "site.png", content_type: "image/png", category: "SITE_PHOTO", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), is_public: false });
    assert.equal(record.id, upload.attachment_id);
    // Step 1 refuses is_public (strict body), so it must not be sent there.
    assert.deepEqual(JSON.parse(calls[0]!.body!), { filename: "site.png", content_type: "image/png", category: "SITE_PHOTO", size_bytes: 4 });
    assert.equal(calls[1]!.method, "PUT");
    assert.equal(calls[1]!.url.host, "storage.example.test");
    assert.equal(calls[1]!.headers.get("content-type"), "image/png");
    assert.equal(calls[1]!.headers.get("authorization"), null, "the API key never goes to the storage URL");
    assert.equal(calls[2]!.url.pathname.endsWith(`/v1/jobs/j1/attachments/${upload.attachment_id}/complete`), true);
    assert.deepEqual(JSON.parse(calls[2]!.body!), { filename: "site.png", content_type: "image/png", size_bytes: 4, storage_path: upload.storage_path, category: "SITE_PHOTO", is_public: false });
  });

  it("sends is_public: true in step 3 when asked, and refuses an upload that does not choose", async () => {
    const upload = { attachment_id: "11111111-2222-4333-8444-555555555555", job_id: "j1", bucket: "job-documents", storage_path: "p", upload_url: "https://storage.example.test/u", token: "t", expires_in: 7200, filename: "plan.pdf", content_type: "application/pdf", size_bytes: 4 };
    const { calls, fetchFn } = scripted([{ status: 201, body: upload }, { status: 200, body: {} }, { status: 201, body: { id: upload.attachment_id } }]);
    const tc = new TcClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn });
    await tc.uploadAttachment("j1", { filename: "plan.pdf", content_type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), is_public: true });
    assert.equal(JSON.parse(calls[2]!.body!).is_public, true);

    // A JavaScript caller (no type checking) that forgets the flag gets an error, not TC's public default.
    const forgetful = { filename: "invoice.pdf", content_type: "application/pdf", bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } as unknown as Parameters<TcClient["uploadAttachment"]>[1];
    await assert.rejects(tc.uploadAttachment("j1", forgetful), TypeError);
    assert.equal(calls.length, 3, "nothing was sent for the upload that did not choose");
  });

  it("works without a key for the open health route", async () => {
    const { calls, fetchFn } = scripted([{ status: 200, body: { status: "ok", version: "v1" } }]);
    await new TcClient({ baseUrl: BASE, fetch: fetchFn }).health();
    assert.equal(calls[0]!.headers.get("authorization"), null);
  });
});
