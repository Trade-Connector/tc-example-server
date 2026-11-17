// A small, dependency-free client for the Trade Connector Partner API v1.
//
// Copy this file (with errors.ts and types.ts) into your own system. It uses the global fetch
// built into Node 18+, Deno, Bun and browsers.
//
//   const tc = new TcClient({ baseUrl: process.env.TC_BASE_URL!, apiKey: process.env.TC_TEST_API_KEY! });
//   const job = await tc.createJob({ ...fields, publish: true }, { idempotencyKey: crypto.randomUUID() });
//
// What it handles for you:
// - Bearer authentication.
// - TC's JSON errors, thrown as TcApiError with code, message, details and request_id.
// - Idempotency-Key on create, so a retried create never makes a second job.
// - ext:<your reference> job ids, URL-encoded.
// - Keyset pagination (data / has_more / next_cursor) with an async iterator.
// - 429 RATE_LIMITED: waits for Retry-After and retries, a bounded number of times.

import { TcApiError, parseTcError } from "./errors.ts";
import type {
  Accreditation,
  AttachmentRecord,
  AttachmentUpload,
  CancelJobResponse,
  CompleteAttachmentRequest,
  CreateAttachmentRequest,
  CreateJobRequest,
  HealthResponse,
  InstallRegistration,
  Job,
  JobNote,
  JobType,
  ListInstallsQuery,
  ListJobsQuery,
  Page,
  SimulateTarget,
  TradeType,
  UpdateJobRequest,
  UpsertInstallRequest,
} from "./types.ts";

/** A name for each API operation, used for logging and the console's coverage checklist. */
export type OperationId =
  | "health"
  | "openapi"
  | "reference.job_types"
  | "reference.trade_types"
  | "reference.accreditations"
  | "jobs.create"
  | "jobs.list"
  | "jobs.get"
  | "jobs.update"
  | "jobs.cancel"
  | "jobs.notes"
  | "attachments.create"
  | "attachments.upload"
  | "attachments.complete"
  | "sandbox.simulate"
  | "installs.upsert"
  | "installs.list"
  | "installs.get";

/** What the client reports after each HTTP exchange (never includes the API key or bodies). */
export interface ResponseInfo {
  operation: OperationId;
  method: string;
  /** Path relative to the base URL, e.g. /v1/jobs/ext:ABC-1. Query strings are left out. */
  path: string;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  ok: boolean;
  requestId: string | null;
  errorCode: string | null;
  durationMs: number;
  rateLimit: { limit: number; remaining: number; resetEpochSeconds: number } | null;
}

export interface TcClientOptions {
  /** e.g. https://api.tradeconnector.com.au/functions/v1/partner-api (TC tells you the URL). */
  baseUrl: string;
  /** tc_test_… (sandbox) or tc_live_… (production). Only the open routes (health, openapi) work without one. */
  apiKey?: string | null;
  /** Defaults to the global fetch. Pass your own for tests or proxies. */
  fetch?: typeof fetch;
  /** How many times to retry after a 429. Default 2. */
  maxRetries?: number;
  /** Never wait longer than this for one Retry-After. Default 60 seconds. */
  maxRetryWaitSeconds?: number;
  /** Per-request timeout. Default 30 seconds. */
  timeoutMs?: number;
  userAgent?: string;
  /** Called after every HTTP exchange, success or failure. */
  onResponse?: (info: ResponseInfo) => void;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  operation: OperationId;
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_USER_AGENT = "tc-example-server/0.1.0";

/**
 * Builds the path segment for a job id. Accepts TC's UUID or `ext:<your external_reference>`.
 * The reference is URL-encoded, so references with spaces or slashes are safe.
 */
export function jobIdSegment(id: string): string {
  const trimmed = id.trim();
  if (trimmed.startsWith("ext:")) {
    return `ext:${encodeURIComponent(trimmed.slice(4))}`;
  }
  return encodeURIComponent(trimmed);
}

/** Convenience: the id to use for a job you know by your own reference. */
export function extId(externalReference: string): string {
  return `ext:${externalReference}`;
}

export class TcClient {
  readonly baseUrl: string;
  readonly #apiKey: string | null;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #maxRetryWaitSeconds: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string;
  readonly #onResponse: ((info: ResponseInfo) => void) | undefined;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: TcClientOptions) {
    if (!options.baseUrl) throw new Error("TcClient: baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey ?? null;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxRetryWaitSeconds = options.maxRetryWaitSeconds ?? 60;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#onResponse = options.onResponse;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Which environment the key belongs to. tc_test_ keys only ever see sandbox jobs. */
  get environment(): "sandbox" | "production" {
    return this.#apiKey?.startsWith("tc_live_") ? "production" : "sandbox";
  }

  // -------------------------------------------------------------------------------------------
  // Open routes (no key needed, but sending one does no harm)
  // -------------------------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.#request({ operation: "health", method: "GET", path: "/v1/health" });
  }

  /** The machine-readable spec. Note: TC's published copy has known errors (see docs/guide.md). */
  openApi(): Promise<Record<string, unknown>> {
    return this.#request({ operation: "openapi", method: "GET", path: "/v1/openapi.json" });
  }

  // -------------------------------------------------------------------------------------------
  // Reference data (needs the reference:read scope, which new keys do not get by default)
  // -------------------------------------------------------------------------------------------

  async listJobTypes(): Promise<JobType[]> {
    const res = await this.#request<{ data: JobType[] }>({
      operation: "reference.job_types",
      method: "GET",
      path: "/v1/reference/job-types",
    });
    return res.data;
  }

  async listTradeTypes(): Promise<TradeType[]> {
    const res = await this.#request<{ data: TradeType[] }>({
      operation: "reference.trade_types",
      method: "GET",
      path: "/v1/reference/trade-types",
    });
    return res.data;
  }

  async listAccreditations(): Promise<Accreditation[]> {
    const res = await this.#request<{ data: Accreditation[] }>({
      operation: "reference.accreditations",
      method: "GET",
      path: "/v1/reference/accreditations",
    });
    return res.data;
  }

  // -------------------------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------------------------

  /**
   * Creates a job (201). Always pass an idempotencyKey you store with your own record: if the
   * call times out, retry with the SAME key and TC returns the original job (200, replayed: true)
   * instead of creating a second one. Keys are kept for 24 hours, per API key.
   */
  createJob(body: CreateJobRequest, options: { idempotencyKey?: string } = {}): Promise<Job> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    return this.#request({ operation: "jobs.create", method: "POST", path: "/v1/jobs", body, headers });
  }

  /** id is TC's UUID or `ext:<your external_reference>`. */
  getJob(id: string): Promise<Job> {
    return this.#request({ operation: "jobs.get", method: "GET", path: `/v1/jobs/${jobIdSegment(id)}` });
  }

  /** One page of jobs, newest change first. */
  listJobs(query: ListJobsQuery = {}): Promise<Page<Job>> {
    return this.#request({
      operation: "jobs.list",
      method: "GET",
      path: "/v1/jobs",
      query: {
        status: Array.isArray(query.status) ? query.status.join(",") : query.status,
        external_reference: query.external_reference,
        updated_since: query.updated_since,
        cursor: query.cursor,
        limit: query.limit,
      },
    });
  }

  /**
   * Every job matching the query, fetching pages as you iterate:
   *   for await (const job of tc.iterateJobs({ updated_since })) { ... }
   */
  iterateJobs(query: Omit<ListJobsQuery, "cursor"> = {}): AsyncGenerator<Job> {
    return paginate((cursor) => this.listJobs({ ...query, cursor }));
  }

  /** PATCH. Only while the job is DRAFT or OPEN, otherwise 409 JOB_LOCKED. */
  updateJob(id: string, patch: UpdateJobRequest): Promise<Job> {
    return this.#request({
      operation: "jobs.update",
      method: "PATCH",
      path: `/v1/jobs/${jobIdSegment(id)}`,
      body: patch,
    });
  }

  /** Moves a DRAFT job to OPEN (live to installers, for a production job). */
  publishJob(id: string): Promise<Job> {
    return this.updateJob(id, { publish: true });
  }

  /**
   * Cancels a job under TC's normal cancellation terms. Production jobs can incur a fee (see
   * docs/guide.md); the response says whether one was applied. Sandbox cancellations are free.
   * Needs the jobs:cancel scope.
   */
  cancelJob(id: string, reason?: string): Promise<CancelJobResponse> {
    return this.#request({
      operation: "jobs.cancel",
      method: "POST",
      path: `/v1/jobs/${jobIdSegment(id)}/cancel`,
      body: reason ? { reason } : {},
    });
  }

  /** Adds a note. Once an installer is assigned, it also reaches them as a chat message. */
  addNote(id: string, body: string): Promise<JobNote> {
    return this.#request({
      operation: "jobs.notes",
      method: "POST",
      path: `/v1/jobs/${jobIdSegment(id)}/notes`,
      body: { body },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Attachments: three steps (needs the attachments:write scope)
  // -------------------------------------------------------------------------------------------

  /** Step 1: ask TC for a signed upload URL. */
  createAttachmentUpload(id: string, req: CreateAttachmentRequest): Promise<AttachmentUpload> {
    return this.#request({
      operation: "attachments.create",
      method: "POST",
      path: `/v1/jobs/${jobIdSegment(id)}/attachments`,
      body: req,
    });
  }

  /**
   * Step 2: PUT the bytes to the signed URL, with the same Content-Type as step 1.
   * The URL is a storage address, not the API: the API key is deliberately NOT sent to it.
   */
  async uploadAttachmentBytes(upload: AttachmentUpload, bytes: Uint8Array): Promise<void> {
    const url = new URL(upload.upload_url);
    if (url.protocol !== "https:") {
      throw new Error("Refusing to upload to a non-HTTPS upload_url");
    }
    const started = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "PUT",
        headers: { "Content-Type": upload.content_type },
        body: bytes,
        signal: AbortSignal.timeout(Math.max(this.#timeoutMs, 120_000)),
      });
    } catch (cause) {
      this.#report("attachments.upload", "PUT", "(signed upload URL)", null, started, null);
      throw new TcApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message: `Upload to storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    const text = await response.text();
    this.#report("attachments.upload", "PUT", "(signed upload URL)", response, started, null);
    if (!response.ok) {
      throw new TcApiError({
        status: response.status,
        code: "UPLOAD_FAILED",
        message: `Storage refused the upload (HTTP ${response.status}): ${text.slice(0, 200)}`,
      });
    }
  }

  /** Step 3: tell TC the upload is done. TC re-checks the file's type, size and signature. */
  completeAttachmentUpload(
    id: string,
    attachmentId: string,
    req: CompleteAttachmentRequest,
  ): Promise<AttachmentRecord> {
    return this.#request({
      operation: "attachments.complete",
      method: "POST",
      path: `/v1/jobs/${jobIdSegment(id)}/attachments/${encodeURIComponent(attachmentId)}/complete`,
      body: req,
    });
  }

  /** All three steps in one call. */
  async uploadAttachment(
    id: string,
    file: Omit<CreateAttachmentRequest, "size_bytes"> & { bytes: Uint8Array },
  ): Promise<AttachmentRecord> {
    const { bytes, ...meta } = file;
    const upload = await this.createAttachmentUpload(id, { ...meta, size_bytes: bytes.byteLength });
    await this.uploadAttachmentBytes(upload, bytes);
    return this.completeAttachmentUpload(id, upload.attachment_id, {
      filename: meta.filename,
      content_type: meta.content_type,
      size_bytes: bytes.byteLength,
      storage_path: upload.storage_path,
      ...(meta.category ? { category: meta.category } : {}),
      ...(meta.title ? { title: meta.title } : {}),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Sandbox
  // -------------------------------------------------------------------------------------------

  /**
   * Moves a sandbox job forward (tc_test_ keys only). One call per step gives one
   * job.status_changed webhook per step; a jump of several steps gives a single event.
   */
  simulate(id: string, status: SimulateTarget): Promise<Job> {
    return this.#request({
      operation: "sandbox.simulate",
      method: "POST",
      path: `/v1/sandbox/jobs/${jobIdSegment(id)}/simulate`,
      body: { status },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Installs (manufacturers; tc_live_ keys only; scopes installs:read / installs:write)
  // -------------------------------------------------------------------------------------------

  /** Creates (201) or updates (200) the registration for a serial number. */
  upsertInstall(body: UpsertInstallRequest): Promise<InstallRegistration> {
    return this.#request({ operation: "installs.upsert", method: "POST", path: "/v1/installs", body });
  }

  listInstalls(query: ListInstallsQuery = {}): Promise<Page<InstallRegistration>> {
    return this.#request({
      operation: "installs.list",
      method: "GET",
      path: "/v1/installs",
      query: { ...query },
    });
  }

  getInstall(serial: string): Promise<InstallRegistration> {
    return this.#request({
      operation: "installs.get",
      method: "GET",
      path: `/v1/installs/${encodeURIComponent(serial.trim())}`,
    });
  }

  // -------------------------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------------------------

  async #request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(this.baseUrl + opts.path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.#userAgent,
      ...opts.headers,
    };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: opts.method,
          headers,
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        this.#report(opts.operation, opts.method, opts.path, null, started, "NETWORK_ERROR");
        const message =
          cause instanceof Error && cause.name === "TimeoutError"
            ? `No response from Trade Connector within ${this.#timeoutMs} ms`
            : `Could not reach Trade Connector: ${cause instanceof Error ? cause.message : String(cause)}`;
        throw new TcApiError({ status: 0, code: "NETWORK_ERROR", message });
      }

      const text = await response.text();

      if (response.ok) {
        this.#report(opts.operation, opts.method, opts.path, response, started, null);
        if (!text) return null as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new TcApiError({
            status: response.status,
            code: "UNEXPECTED_RESPONSE",
            message: `HTTP ${response.status} with a body that is not JSON`,
            requestId: response.headers.get("x-request-id"),
          });
        }
      }

      const error = parseTcError(response.status, text, response.headers);
      this.#report(opts.operation, opts.method, opts.path, response, started, error.code);

      // A 429 is decided before TC runs the request, so retrying is safe for every method.
      const wait = error.retryAfterSeconds ?? 1;
      if (response.status === 429 && attempt < this.#maxRetries && wait <= this.#maxRetryWaitSeconds) {
        await this.#sleep(wait * 1000);
        continue;
      }
      throw error;
    }
  }

  #report(
    operation: OperationId,
    method: string,
    path: string,
    response: Response | null,
    started: number,
    errorCode: string | null,
  ): void {
    if (!this.#onResponse) return;
    const h = response?.headers;
    const limit = h?.get("x-ratelimit-limit");
    const remaining = h?.get("x-ratelimit-remaining");
    const reset = h?.get("x-ratelimit-reset");
    try {
      this.#onResponse({
        operation,
        method,
        path,
        status: response?.status ?? 0,
        ok: response?.ok ?? false,
        requestId: h?.get("x-request-id") ?? null,
        errorCode,
        durationMs: Date.now() - started,
        rateLimit:
          limit && remaining && reset && Number(limit) > 0
            ? { limit: Number(limit), remaining: Number(remaining), resetEpochSeconds: Number(reset) }
            : null,
      });
    } catch {
      // A faulty hook must never break an API call.
    }
  }
}

/** Walks a keyset-paginated list: calls fetchPage with each next_cursor until has_more is false. */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { maxPages?: number } = {},
): AsyncGenerator<T> {
  let cursor: string | undefined;
  for (let page = 0; page < (options.maxPages ?? Number.POSITIVE_INFINITY); page++) {
    const result = await fetchPage(cursor);
    yield* result.data;
    if (!result.has_more || !result.next_cursor) return;
    cursor = result.next_cursor;
  }
}
