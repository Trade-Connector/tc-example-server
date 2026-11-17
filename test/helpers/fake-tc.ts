// A fake Trade Connector sandbox for testing the sandbox check: it keeps jobs in memory, follows
// TC's sandbox rules (statuses, JOB_LOCKED, idempotency, scopes, simulate) and emits the webhooks
// TC's triggers would, then "delivers" them into a real EventStore when the virtual clock says
// they are due. No network, no real waiting.

import { randomUUID } from "node:crypto";
import type { CheckEventSource } from "../../src/check/event-source.ts";
import { storeEventSource } from "../../src/check/event-source.ts";
import type { RetryProbe } from "../../src/check/retry-probe.ts";
import type { CheckClock } from "../../src/check/sandbox-check.ts";
import type { Job } from "../../src/tc/types.ts";
import type { WebhookEnvelope } from "../../src/webhooks/events.ts";
import { preciseInstant, type EventStore } from "../../src/webhooks/store.ts";
import { sampleJob, tcEnvelope } from "./tc-signer.ts";

export const FAKE_BASE = "https://tc.fake.test/functions/v1/partner-api";

/** Virtual time: sleep() moves the clock on at once. */
export class FakeClock implements CheckClock {
  #now: number;
  constructor(start = Date.parse("2026-11-17T01:00:00.000Z")) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  async sleep(ms: number): Promise<void> {
    this.#now += ms;
    await new Promise((resolve) => setImmediate(resolve));
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

interface Pending {
  webhookId: string;
  type: string;
  job: Job;
  changes: Record<string, unknown>;
  deliverAt: number;
  duplicate?: boolean;
}

export interface FakeTcOptions {
  clock: FakeClock;
  /** Scopes the key has. Default: all five. */
  scopes?: string[];
  /** How long after a change its webhooks arrive. Default 5 s. */
  deliveryDelayMs?: number;
  /** Return true to never deliver this event. */
  drop?: (type: string, job: Job, changes: Record<string, unknown>) => boolean;
  /** A bug to test: PATCH works after ASSIGNED (TC must answer 409 JOB_LOCKED). */
  patchAfterAssignedWorks?: boolean;
  /** A bug to test: after a 500, TC never retries. */
  neverRetry?: boolean;
  /** Extra events to emit (to test "unexpected"). */
  extraOnPublish?: Array<{ type: string }>;
  /** Accreditations carry trade_type_codes. */
  accreditationTrades?: boolean;
  /** The health route fails (no response). */
  healthDown?: boolean;
}

const SCOPE_OF: Array<[RegExp, string, string]> = [
  [/^GET \/v1\/reference\//, "reference:read", ""],
  [/^POST \/v1\/jobs\/[^/]+\/cancel$/, "jobs:cancel", ""],
  [/^POST \/v1\/jobs\/[^/]+\/attachments/, "attachments:write", ""],
  [/^GET \/v1\/jobs/, "jobs:read", ""],
  [/^(POST|PATCH) \/v1\/(jobs|sandbox)/, "jobs:write", ""],
];

const LIFECYCLE = ["DRAFT", "OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID"];

export class FakeTc {
  readonly clock: FakeClock;
  readonly options: FakeTcOptions;
  readonly jobs = new Map<string, Job>();
  /** Every request: "METHOD /path". */
  readonly requests: string[] = [];
  /** Every write and the job it targeted. */
  readonly writes: Array<{ route: string; jobId: string | null }> = [];
  readonly authorizations = new Set<string | null>();
  readonly pending: Pending[] = [];
  readonly delivered: Pending[] = [];
  readonly refused: Pending[] = [];
  #idempotency = new Map<string, { body: string; jobId: string }>();
  #micros = 0;
  #requestNo = 0;
  retryProbe: RetryProbe | null = null;

  constructor(options: FakeTcOptions) {
    this.clock = options.clock;
    this.options = options;
  }

  /** An existing job that is NOT the check's: the check must never change it. */
  seedOwnersJob(): Job {
    const job = sampleJob({
      id: "0d0d0d0d-1111-4222-8333-444444444444",
      external_reference: "OWNER-1",
      status: "OPEN",
      updated_at: this.#stamp(),
      created_at: this.#stamp(),
    });
    this.jobs.set(job.id, job);
    return job;
  }

  #stamp(): string {
    const micros = String((this.#micros++ % 1000) + 1000).slice(1);
    return new Date(this.clock.now()).toISOString().replace("Z", `${micros}+00:00`);
  }

  #emit(type: string, job: Job, changes: Record<string, unknown>): void {
    if (this.options.drop?.(type, job, changes)) return;
    this.pending.push({
      webhookId: randomUUID(),
      type,
      job: structuredClone(job),
      changes,
      deliverAt: this.clock.now() + (this.options.deliveryDelayMs ?? 5_000),
    });
  }

  /** Sends a delivered event again with the same webhook-id (TC's Replay button). */
  replay(webhookId: string): void {
    const original = this.delivered.find((d) => d.webhookId === webhookId);
    if (!original) throw new Error(`no delivery ${webhookId}`);
    this.pending.push({ ...original, deliverAt: this.clock.now() });
  }

  /** Queues any event (e.g. webhook.test or job.rescheduled from the TC web app). */
  queue(type: string, job: Job, changes: Record<string, unknown> = {}): string {
    const webhookId = randomUUID();
    this.pending.push({ webhookId, type, job, changes, deliverAt: this.clock.now() });
    return webhookId;
  }

  /** Delivers everything due into the store, through the retry probe like the real listener. */
  async deliverDue(store: EventStore): Promise<void> {
    const now = this.clock.now();
    const due = this.pending.filter((p) => p.deliverAt <= now).sort((a, b) => a.deliverAt - b.deliverAt);
    for (const delivery of due) {
      this.pending.splice(this.pending.indexOf(delivery), 1);
      if (this.retryProbe?.take("sandbox", delivery.job.id, delivery.webhookId)) {
        this.refused.push(delivery);
        await store.recordRejected({ environment: "sandbox", webhookId: delivery.webhookId, reason: "retry_test", message: "500 on purpose" });
        // TC retries a failed delivery after one minute.
        if (!this.options.neverRetry) this.pending.push({ ...delivery, deliverAt: now + 60_000 });
        continue;
      }
      const envelope = tcEnvelope({
        eventId: delivery.webhookId,
        type: delivery.type,
        job: delivery.job,
        changes: delivery.changes,
        createdAt: new Date(delivery.deliverAt).toISOString(),
      });
      const rawBody = JSON.stringify(envelope);
      await store.recordVerified({
        environment: "sandbox",
        webhookId: delivery.webhookId,
        envelope: envelope as unknown as WebhookEnvelope,
        rawBody,
        receivedAt: new Date(now),
      });
      this.delivered.push(delivery);
    }
  }

  /** An event source that delivers what is due, then reads the real store. */
  eventSource(store: EventStore): CheckEventSource {
    const inner = storeEventSource(store);
    return {
      latestSeq: () => inner.latestSeq(),
      since: async (afterSeq) => {
        await this.deliverDue(store);
        return inner.since(afterSeq);
      },
    };
  }

  #json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": `req-${++this.#requestNo}`, ...headers },
    });
  }

  #error(status: number, code: string, message: string): Response {
    const requestId = `req-${++this.#requestNo}`;
    return new Response(JSON.stringify({ error_code: code, error: { code, message, request_id: requestId } }), {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    });
  }

  #find(segment: string): Job | null {
    const decoded = decodeURIComponent(segment);
    if (decoded.startsWith("ext:")) return [...this.jobs.values()].find((j) => j.external_reference === decoded.slice(4)) ?? null;
    return this.jobs.get(decoded) ?? null;
  }

  #touch(job: Job): void {
    job.updated_at = this.#stamp();
  }

  #setPrice(job: Job, exGst: number | null): void {
    const before = { total: job.price.total_cents, gst: job.price.gst_cents };
    const gst = exGst === null ? null : Math.round(exGst / 10);
    job.price = {
      ...job.price,
      ex_gst_cents: exGst,
      gst_cents: gst,
      inc_gst_cents: exGst === null ? null : exGst + gst!,
      subtotal_cents: exGst,
      total_cents: exGst === null ? null : exGst + gst!,
    };
    if (before.total !== job.price.total_cents || before.gst !== job.price.gst_cents) {
      this.#emit("job.price_changed", job, { client_total_cents: { from: before.total, to: job.price.total_cents } });
    }
  }

  #setStatus(job: Job, to: string): void {
    const from = job.status;
    job.status = to;
    if (to === "SCHEDULED") job.schedule = { ...job.schedule, scheduled_date: job.schedule.preferred_start_date ?? "2026-11-18" };
    if (to === "WORK_COMPLETE") job.work_completed_at = this.#stamp();
    this.#touch(job);
    const changes = { job_status: { from, to } };
    this.#emit("job.status_changed", job, changes);
    if (to === "ASSIGNED") this.#emit("job.assigned", job, changes);
    if (to === "SCHEDULED") this.#emit("job.scheduled", job, { ...changes, scheduled_date: { from: null, to: job.schedule.scheduled_date } });
    if (to === "WORK_COMPLETE") {
      this.#emit("job.completed", job, changes);
      this.#emit("job.evidence_ready", job, changes);
    }
    if (to === "CANCELLED") this.#emit("job.cancelled", job, { ...changes, cancellation_reason: { from: null, to: job.cancellation_reason } });
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url.host === "storage.fake.test") {
      this.requests.push(`${method} storage:${url.pathname}`);
      this.authorizations.add(headers.get("authorization") === null ? "storage:none" : "storage:SENT");
      return this.#json(200, { Key: "ok" });
    }
    const path = url.pathname.replace(new URL(FAKE_BASE).pathname, "");
    const route = `${method} ${path}`;
    this.requests.push(route);
    this.authorizations.add(headers.get("authorization"));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (route === "GET /v1/health") {
      if (this.options.healthDown) throw new TypeError("fetch failed");
      return this.#json(200, { status: "ok", version: "v1" });
    }
    const scopes = new Set(this.options.scopes ?? ["jobs:read", "jobs:write", "jobs:cancel", "attachments:write", "reference:read"]);
    const needed = SCOPE_OF.find(([pattern]) => pattern.test(route))?.[1];
    if (needed && !scopes.has(needed)) return this.#error(403, "SCOPE_FORBIDDEN", `API key lacks required scope '${needed}'`);

    if (route === "GET /v1/reference/job-types") return this.#json(200, { data: [{ id: 1, name: "Battery install", service_category_id: 2, description: null }] });
    if (route === "GET /v1/reference/trade-types") return this.#json(200, { data: [{ code: "ELECTRICAL", name: "Electrical", category: null }] });
    if (route === "GET /v1/reference/accreditations") {
      const extra = this.options.accreditationTrades ? { trade_type_codes: ["ELECTRICAL"] } : {};
      return this.#json(200, { data: [{ id: "a1", name: "Electrical licence", category: null, issuing_body: null, type: null, scope: null, ...extra }] });
    }

    if (route === "POST /v1/jobs") {
      const key = headers.get("idempotency-key");
      const text = JSON.stringify(body);
      if (key && this.#idempotency.has(key)) {
        const seen = this.#idempotency.get(key)!;
        if (seen.body !== text) return this.#error(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key reused with a different body");
        return this.#json(200, { ...this.jobs.get(seen.jobId)!, replayed: true }, { "idempotent-replayed": "true" });
      }
      const ref = body.external_reference as string | undefined;
      if (ref && [...this.jobs.values()].some((j) => j.external_reference === ref)) {
        return this.#error(409, "DUPLICATE_EXTERNAL_REFERENCE", "external_reference already used");
      }
      const stamp = this.#stamp();
      const job = sampleJob({
        id: randomUUID(),
        external_reference: ref ?? null,
        status: body.publish ? "OPEN" : "DRAFT",
        title: String(body.title),
        trade_codes: (body.trade_codes as string[]) ?? [],
        created_at: stamp,
        updated_at: stamp,
        schedule: { preferred_start_date: (body.schedule as { preferred_start_date?: string })?.preferred_start_date ?? null, preferred_end_date: null, time_window: "MORNING", estimated_hours: null, scheduled_date: null },
      });
      job.price = { ...job.price, ex_gst_cents: null, gst_cents: null, inc_gst_cents: null, subtotal_cents: null, total_cents: null };
      this.jobs.set(job.id, job);
      if (key) this.#idempotency.set(key, { body: text, jobId: job.id });
      this.writes.push({ route, jobId: job.id });
      this.#emit("job.created", job, { job_status: { from: null, to: job.status } });
      return this.#json(201, job);
    }

    if (route === "GET /v1/jobs") {
      const since = preciseInstant(url.searchParams.get("updated_since"));
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number((url.searchParams.get("cursor") ?? "off:0").slice(4));
      const all = [...this.jobs.values()]
        .filter((j) => since === null || preciseInstant(j.updated_at)! >= since)
        .sort((a, b) => (preciseInstant(b.updated_at)! > preciseInstant(a.updated_at)! ? 1 : -1));
      const data = all.slice(offset, offset + limit);
      const more = offset + limit < all.length;
      return this.#json(200, { data, has_more: more, next_cursor: more ? `off:${offset + limit}` : null });
    }

    const jobMatch = /^\/v1\/(?:sandbox\/)?jobs\/([^/]+)(\/.*)?$/.exec(path);
    if (!jobMatch) return this.#error(404, "NOT_FOUND", `Route ${route} not found`);
    const job = this.#find(jobMatch[1]!);
    if (!job) return this.#error(404, "NOT_FOUND", "Job not found");
    const rest = jobMatch[2] ?? "";
    if (method !== "GET") this.writes.push({ route: `${method} ${rest || "/"}`, jobId: job.id });

    if (method === "GET" && rest === "") return this.#json(200, job);

    if (method === "PATCH" && rest === "") {
      const editable = job.status === "DRAFT" || job.status === "OPEN";
      if (!editable && !this.options.patchAfterAssignedWorks) return this.#error(409, "JOB_LOCKED", `Job is ${job.status} and can no longer be edited`);
      if (typeof body.title === "string") job.title = body.title;
      if (body.price) this.#setPrice(job, (body.price as { ex_gst_cents: number }).ex_gst_cents);
      this.#touch(job);
      if (body.publish === true && job.status === "DRAFT") {
        this.#setStatus(job, "OPEN");
        for (const extra of this.options.extraOnPublish ?? []) this.#emit(extra.type, job, {});
      }
      return this.#json(200, job);
    }

    if (method === "POST" && rest === "/notes") {
      this.#touch(job);
      return this.#json(201, { id: randomUUID(), audit_log_id: 1, message_id: null, job_id: job.id, body: body.body, note: body.body, author_user_id: null, author_source: "partner_api", created_at: this.#stamp() });
    }

    if (method === "POST" && rest === "/attachments") {
      if ("is_public" in body) return this.#error(400, "VALIDATION_ERROR", "is_public is not allowed in step 1");
      const id = randomUUID();
      return this.#json(201, {
        attachment_id: id,
        job_id: job.id,
        bucket: "job-documents",
        storage_path: `${job.id}/partner-api/${id}_${String(body.filename)}`,
        upload_url: `https://storage.fake.test/upload/sign/${id}?token=signed-secret-token`,
        token: "signed-secret-token",
        expires_in: 7200,
        filename: body.filename,
        content_type: body.content_type,
        size_bytes: body.size_bytes,
      });
    }

    const complete = /^\/attachments\/([^/]+)\/complete$/.exec(rest);
    if (method === "POST" && complete) {
      return this.#json(201, {
        id: complete[1],
        job_id: job.id,
        filename: body.filename,
        file_name: body.filename,
        mime_type: body.content_type,
        file_type: body.content_type,
        file_size: body.size_bytes,
        category: body.category ?? null,
        storage_path: body.storage_path,
        is_public: body.is_public ?? true,
        created_at: this.#stamp(),
      });
    }

    if (method === "POST" && rest === "/simulate") {
      const target = String(body.status);
      if (["CANCELLED", "PAID", "DISPUTED"].includes(job.status)) return this.#error(400, "VALIDATION_ERROR", `Cannot simulate from ${job.status}`);
      if (target === "CANCELLED") {
        this.#setStatus(job, "CANCELLED");
        return this.#json(200, job);
      }
      const from = LIFECYCLE.indexOf(job.status);
      const to = LIFECYCLE.indexOf(target);
      if (to <= from) return this.#error(400, "VALIDATION_ERROR", "Jobs cannot go backwards");
      this.#setStatus(job, target);
      return this.#json(200, job);
    }

    if (method === "POST" && rest === "/cancel") {
      if (["WORK_COMPLETE", "PAID", "CANCELLED", "DISPUTED"].includes(job.status)) return this.#error(409, "JOB_LOCKED", "Job cannot be cancelled");
      const previous = job.status;
      job.cancellation_reason = typeof body.reason === "string" ? body.reason : null;
      job.cancelled_at = this.#stamp();
      this.#setStatus(job, "CANCELLED");
      return this.#json(200, {
        success: true,
        job_id: job.id,
        status: "CANCELLED",
        previous_status: previous,
        cancelled_by_role: "CLIENT",
        fee_applied: false,
        fee_amount_cents: 0,
        gst_cents: 0,
        cancellation_type: "CLEAN",
        trade_notified: false,
        payment_cancelled: false,
        charge_status: "NONE",
        invoice_number: null,
        card_last4: null,
        decline_reason: null,
        message: "Job cancelled.",
      });
    }

    return this.#error(404, "NOT_FOUND", `Route ${route} not found`);
  }) as typeof fetch;
}

/** A listener stand-in for the security self-test: answers like the real one with a secret set. */
export const refusingListener = (async (_input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  void headers;
  return new Response(JSON.stringify({ error: "invalid signature" }), { status: 401, headers: { "content-type": "application/json" } });
}) as typeof fetch;
