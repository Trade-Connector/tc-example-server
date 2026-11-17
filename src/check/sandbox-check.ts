// The one-click sandbox check: `npm run check:sandbox` and the console's "Run full sandbox check"
// button both run this code.
//
// It walks the whole Partner API against the SANDBOX with a tc_test_ key, using two jobs it
// creates itself (uniquely referenced CHECK-<date>-<tag>-A and -B). It never changes any other
// job. Then it waits for the webhooks those steps should send, and checks each one. TC sends them
// in batches (see TC_DELIVERIES_PER_RUN), so the wait takes a few minutes.
//
// Every step is a row (see types.ts). A row records the requests it made and the answers it got,
// without the API key. Steps that depend on an earlier one are skipped, with the reason, when that
// one failed.
//
// Which webhooks each step sends was worked out from TC's event triggers (the job row's status,
// price, assignment and schedule columns), not only from its docs:
//   create                       job.created
//   PATCH price (DRAFT or OPEN)   job.price_changed
//   publish                      job.status_changed
//   simulate ASSIGNED            job.status_changed, job.assigned
//   simulate SCHEDULED           job.status_changed, job.scheduled
//   simulate IN_PROGRESS         job.status_changed
//   simulate WORK_COMPLETE       job.status_changed, job.completed, job.evidence_ready
//   simulate PAID                job.status_changed
//   simulate ASSIGNED (job B)    job.status_changed, job.assigned
//   cancel (job B, from ASSIGNED) job.status_changed, job.cancelled
// Job B is cancelled after ASSIGNED on purpose: that is where a fee could apply to a live job, so
// it shows that a sandbox cancel stays free there too.
// job.price_changed may also come at other times (TC sends it whenever the client total or GST
// changes), so an extra one is never reported as unexpected.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { keyPrefix, log } from "../log.ts";
import { ENDPOINTS } from "../server/coverage.ts";
import type { ConsoleEnvironment } from "../server/live-guard.ts";
import { extId, TcClient, type ResponseInfo } from "../tc/client.ts";
import { TcApiError, TcInputError, hintFor } from "../tc/errors.ts";
import type { AttachmentUpload, CreateJobRequest, Job, SimulateTarget, TradeType } from "../tc/types.ts";
import { preciseInstant, type StoredEvent } from "../webhooks/store.ts";
import type { CheckEventSource } from "./event-source.ts";
import { tinyPng } from "./png.ts";
import type { RefusedDelivery, RetryProbe } from "./retry-probe.ts";
import {
  CHECK_GROUPS,
  summarize,
  type CheckJobRef,
  type CheckRow,
  type CheckRun,
  type Exchange,
  type GroupId,
  type RowStatus,
  type TimelineLane,
} from "./types.ts";

export interface CheckClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: CheckClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// How TC delivers webhooks: a dispatcher runs once a minute and sends at most this many deliveries
// per endpoint per run, oldest first. The rest wait for the next run, so the check's burst of
// events takes a few minutes to arrive, and an early step's webhooks can queue behind later ones.
export const TC_DELIVERIES_PER_RUN = 8;

/** How a webhook row's note starts while the check waits (the CLI prints it). */
export const WAITING_NOTE_PREFIX = "Waiting for TC's webhooks:";

export interface CheckTimings {
  /** How often TC's dispatcher runs. */
  dispatchMs: number;
  /** Added to every webhook wait, after one dispatcher run per 8 expected deliveries. */
  marginMs: number;
  /** Added to the wait when the retry test is on: the refused delivery is due again a minute after the 500, behind older ones. */
  retryExtraMs: number;
  /** After the deliberate 500, the retry row waits at least this long for TC to send it again. */
  retryMs: number;
  /** How often to look for new deliveries. */
  pollMs: number;
  /** A hard bound on the whole webhook wait. 10 minutes covers up to 56 deliveries with the retry test on. */
  overallMs: number;
}

export const DEFAULT_TIMINGS: CheckTimings = {
  dispatchMs: 60_000,
  marginMs: 60_000,
  retryExtraMs: 120_000,
  retryMs: 180_000,
  pollMs: 1_000,
  overallMs: 10 * 60_000,
};

/**
 * How long to wait after the last step for `deliveries` webhooks: one dispatcher run per 8
 * (rounded up), one more as a margin, and the retry allowance when the retry test is on. Never
 * more than overallMs.
 */
export function webhookWaitMs(deliveries: number, retryTest: boolean, timings: CheckTimings = DEFAULT_TIMINGS): number {
  const runs = Math.ceil(Math.max(deliveries, 1) / TC_DELIVERIES_PER_RUN);
  const wait = runs * timings.dispatchMs + timings.marginMs + (retryTest ? timings.retryExtraMs : 0);
  return Math.min(wait, timings.overallMs);
}

export interface SandboxCheckDeps {
  source: CheckRun["source"];
  baseUrl: string;
  /** Must be a tc_test_ key. The check refuses anything else. */
  apiKey: string | null;
  /** The fetch used to call TC (tests pass a fake). */
  fetch?: typeof fetch;
  events: CheckEventSource;
  webhookSecretConfigured: boolean;
  /** The local listener's sandbox URL, for the security self-test. */
  listenerUrl: string;
  /** The fetch used for the self-test (defaults to the global fetch; loopback only). */
  listenerFetch?: typeof fetch;
  /** The listener's one-shot 500 switch, when this process runs the listener. */
  retryProbe: RetryProbe | null;
  /** Why the retry test cannot run here, when retryProbe is null. */
  retryUnavailableReason?: string;
  /** Ticks the console's Test coverage checklist. */
  coverage?: { recordResponse(environment: ConsoleEnvironment, info: ResponseInfo): void } | null;
  clock?: CheckClock;
  timings?: Partial<CheckTimings>;
  options: { testRetries: boolean };
  onUpdate?: (run: CheckRun, row: CheckRow | null) => void;
  /** Makes the job references unique. Random by default. */
  uniqueTag?: string;
}

// ---------------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------------

interface RowSpec {
  id: string;
  group: GroupId;
  title: string;
  manual?: boolean;
  /** The text shown before it runs (manual items: what to do). */
  reason?: string;
}

const SCOPES = ["jobs:read", "jobs:write", "jobs:cancel", "attachments:write", "reference:read"] as const;

interface ExpectedEvent {
  rowId: string;
  job: "A" | "B";
  type: string;
  /** job.status_changed only: changes.job_status.to */
  to?: string;
  /** The status of the job inside the event. */
  jobStatus: string;
  /** The row whose success sends it; the wait starts then. */
  trigger: string;
  /** Where it sits on the timeline. */
  step: string;
  label: string;
}

const LIFECYCLE_STEPS: ReadonlyArray<{ rowId: string; target: SimulateTarget; slug: string }> = [
  { rowId: "lifecycle.assigned", target: "ASSIGNED", slug: "assigned" },
  { rowId: "lifecycle.scheduled", target: "SCHEDULED", slug: "scheduled" },
  { rowId: "lifecycle.in_progress", target: "IN_PROGRESS", slug: "in_progress" },
  { rowId: "lifecycle.work_complete", target: "WORK_COMPLETE", slug: "work_complete" },
  { rowId: "lifecycle.paid", target: "PAID", slug: "paid" },
];

function statusChanged(job: "A" | "B", to: string, trigger: string, label: string): ExpectedEvent {
  return {
    rowId: `webhooks.${job.toLowerCase()}.status_${to.toLowerCase()}`,
    job,
    type: "job.status_changed",
    to,
    jobStatus: to,
    trigger,
    step: to,
    label,
  };
}

function plainEvent(job: "A" | "B", type: string, jobStatus: string, trigger: string, label: string): ExpectedEvent {
  return {
    rowId: `webhooks.${job.toLowerCase()}.${type.replace(/^job\./, "")}`,
    job,
    type,
    jobStatus,
    trigger,
    step: jobStatus,
    label,
  };
}

export const EXPECTED_EVENTS: readonly ExpectedEvent[] = [
  plainEvent("A", "job.created", "DRAFT", "jobs.create_draft", "create"),
  plainEvent("A", "job.price_changed", "DRAFT", "jobs.patch_price", "price PATCH"),
  statusChanged("A", "OPEN", "jobs.publish", "publish"),
  statusChanged("A", "ASSIGNED", "lifecycle.assigned", "simulate"),
  plainEvent("A", "job.assigned", "ASSIGNED", "lifecycle.assigned", "simulate"),
  statusChanged("A", "SCHEDULED", "lifecycle.scheduled", "simulate"),
  plainEvent("A", "job.scheduled", "SCHEDULED", "lifecycle.scheduled", "simulate"),
  statusChanged("A", "IN_PROGRESS", "lifecycle.in_progress", "simulate"),
  statusChanged("A", "WORK_COMPLETE", "lifecycle.work_complete", "simulate"),
  plainEvent("A", "job.completed", "WORK_COMPLETE", "lifecycle.work_complete", "simulate"),
  plainEvent("A", "job.evidence_ready", "WORK_COMPLETE", "lifecycle.work_complete", "simulate"),
  statusChanged("A", "PAID", "lifecycle.paid", "simulate"),
  plainEvent("B", "job.created", "OPEN", "jobs.create_second", "create, published"),
  statusChanged("B", "ASSIGNED", "lifecycle.b_assigned", "simulate"),
  plainEvent("B", "job.assigned", "ASSIGNED", "lifecycle.b_assigned", "simulate"),
  statusChanged("B", "CANCELLED", "lifecycle.cancel", "cancel"),
  plainEvent("B", "job.cancelled", "CANCELLED", "lifecycle.cancel", "cancel"),
];

/** Event types TC may send for the check's jobs at other moments too. Never "unexpected". */
const ALLOWED_EXTRA_TYPES = new Set(["job.price_changed"]);

export const MANUAL_ROWS = {
  replay: "webhooks.manual.replay",
  rescheduled: "webhooks.manual.rescheduled",
  testEvent: "webhooks.manual.test_event",
} as const;

function rowSpecs(options: { testRetries: boolean }): RowSpec[] {
  const specs: RowSpec[] = [
    { id: "keys.prefix", group: "keys", title: "The key is a sandbox key (tc_test_), checked before any request" },
    { id: "keys.health", group: "keys", title: "API health (GET /v1/health)" },
    { id: "keys.webhook_secret", group: "keys", title: "The sandbox webhook secret is set (TC_TEST_WEBHOOK_SECRET)" },
    ...SCOPES.map((scope): RowSpec => ({
      id: `keys.scope.${scope}`,
      group: "keys",
      title: `Scope ${scope}`,
      reason: "Worked out from the calls that need it.",
    })),
    { id: "reference.job_types", group: "reference", title: "Job types" },
    { id: "reference.trade_types", group: "reference", title: "Trade types" },
    { id: "reference.accreditations", group: "reference", title: "Accreditations" },
    { id: "jobs.create_draft", group: "jobs", title: "Create a draft with an Idempotency-Key (201)" },
    { id: "jobs.replay", group: "jobs", title: "Replay the same key and body (200, the same job)" },
    { id: "jobs.create_second", group: "jobs", title: "Create a second job, published (for the cancel path)" },
    { id: "jobs.get_id", group: "jobs", title: "Get the job by id" },
    { id: "jobs.get_ext", group: "jobs", title: "Get the job by ext:<your reference>" },
    { id: "jobs.patch_field", group: "jobs", title: "PATCH a field (title)" },
    { id: "jobs.patch_price", group: "jobs", title: "PATCH the price on the DRAFT job" },
    { id: "jobs.note", group: "jobs", title: "Add a note" },
    { id: "jobs.list", group: "jobs", title: "List with updated_since, one page at a time" },
    { id: "jobs.publish", group: "jobs", title: "Publish (DRAFT → OPEN)" },
    { id: "jobs.patch_locked", group: "jobs", title: "A PATCH after ASSIGNED gets 409 JOB_LOCKED" },
    { id: "attachments.create", group: "attachments", title: "Step 1: ask TC for a signed upload URL" },
    { id: "attachments.upload", group: "attachments", title: "Step 2: PUT a tiny PNG to it" },
    { id: "attachments.complete", group: "attachments", title: "Step 3: complete it as private (is_public false), SITE_PHOTO" },
    ...LIFECYCLE_STEPS.map((s): RowSpec => ({ id: s.rowId, group: "lifecycle", title: `Simulate ${s.target}` })),
    { id: "lifecycle.b_assigned", group: "lifecycle", title: "Simulate ASSIGNED on the second job" },
    { id: "lifecycle.cancel", group: "lifecycle", title: "Cancel the second job after ASSIGNED, with a reason (free in the sandbox)" },
    ...EXPECTED_EVENTS.map((e): RowSpec => ({
      id: e.rowId,
      group: "webhooks",
      title: `${e.type}${e.to ? ` → ${e.to}` : ""} (job ${e.job}, ${e.label})`,
    })),
    { id: "webhooks.a.matches_get", group: "webhooks", title: "Job A as the webhooks left it matches a fresh GET" },
    { id: "webhooks.b.matches_get", group: "webhooks", title: "Job B as the webhooks left it matches a fresh GET" },
    { id: "webhooks.unexpected", group: "webhooks", title: "No unexpected events for the check's jobs" },
  ];
  if (options.testRetries) {
    specs.push({ id: "webhooks.retry", group: "webhooks", title: "TC retries a delivery that got 500 (same webhook-id)" });
  }
  specs.push(
    {
      id: MANUAL_ROWS.replay,
      group: "webhooks",
      title: "Replay a delivery in TC: the console flags it duplicate",
      manual: true,
      reason:
        "Press Replay on one delivery in TC (Settings → API & Webhooks → Webhooks → Deliveries). It comes again with the same webhook-id; this ticks when the console flags it duplicate.",
    },
    {
      id: MANUAL_ROWS.rescheduled,
      group: "webhooks",
      title: "job.rescheduled (needs the TC web app)",
      manual: true,
      reason:
        "The API cannot reschedule: a SCHEDULED job is locked to PATCH, and simulate cannot reschedule. Change the booked date of a SCHEDULED sandbox job in the TC web app (or ask TC to); this ticks when job.rescheduled arrives.",
    },
    {
      id: MANUAL_ROWS.testEvent,
      group: "webhooks",
      title: "webhook.test (Send test event in TC)",
      manual: true,
      reason:
        "In TC: Settings → API & Webhooks → Webhooks → your sandbox endpoint → Send test event. This ticks when it arrives.",
    },
    { id: "security.forged", group: "security", title: "A delivery with a forged signature gets 401" },
    { id: "security.unsigned", group: "security", title: "A delivery with no signature gets 401" },
  );
  return specs;
}

function newRow(spec: RowSpec): CheckRow {
  return {
    id: spec.id,
    group: spec.group,
    title: spec.title,
    status: spec.manual ? "needs_you" : "waiting",
    reason: spec.reason ?? null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    exchanges: [],
    error: null,
    manual: spec.manual === true,
  };
}

/** A new run with every row waiting (manual items amber), in group order. */
export function newCheckRun(meta: {
  source: CheckRun["source"];
  baseUrl: string;
  apiKey: string | null;
  testRetries: boolean;
  now?: number;
}): CheckRun {
  const order = new Map(CHECK_GROUPS.map((g, i) => [g.id, i]));
  const rows = rowSpecs({ testRetries: meta.testRetries })
    .map(newRow)
    .map((row, index) => ({ row, index }))
    .sort((x, y) => order.get(x.row.group)! - order.get(y.row.group)! || x.index - y.index)
    .map((x) => x.row);
  const run: CheckRun = {
    id: randomUUID(),
    source: meta.source,
    state: "running",
    started_at: new Date(meta.now ?? Date.now()).toISOString(),
    finished_at: null,
    options: { test_retries: meta.testRetries },
    key_prefix: keyPrefix(meta.apiKey),
    base_url: meta.baseUrl,
    start_seq: 0,
    jobs: { a: null, b: null },
    rows,
    timeline: [],
    summary: summarize(rows),
  };
  run.timeline = buildTimeline(run);
  return run;
}

// ---------------------------------------------------------------------------------------------
// Timeline and manual items (shared with the console, which keeps ticking after a run)
// ---------------------------------------------------------------------------------------------

const LANE_STEPS: Record<"A" | "B", ReadonlyArray<{ status: string; reachedBy: string }>> = {
  A: [
    { status: "DRAFT", reachedBy: "jobs.create_draft" },
    { status: "OPEN", reachedBy: "jobs.publish" },
    ...LIFECYCLE_STEPS.map((s) => ({ status: s.target, reachedBy: s.rowId })),
  ],
  B: [
    { status: "OPEN", reachedBy: "jobs.create_second" },
    { status: "ASSIGNED", reachedBy: "lifecycle.b_assigned" },
    { status: "CANCELLED", reachedBy: "lifecycle.cancel" },
  ],
};

export function buildTimeline(run: CheckRun): TimelineLane[] {
  const rows = new Map(run.rows.map((r) => [r.id, r]));
  return (["A", "B"] as const).map((job) => {
    const ref = job === "A" ? run.jobs.a : run.jobs.b;
    return {
      job,
      label: job === "A" ? "Job A: the full lifecycle" : "Job B: the cancel path",
      job_id: ref?.id ?? null,
      external_reference: ref?.external_reference ?? null,
      steps: LANE_STEPS[job].map((step) => ({
        status: step.status,
        reached: rows.get(step.reachedBy)?.status === "pass",
        events: EXPECTED_EVENTS.filter((e) => e.job === job && e.step === step.status).map((e) => ({
          row_id: e.rowId,
          type: e.type,
          status: rows.get(e.rowId)?.status ?? "waiting",
        })),
      })),
    };
  });
}

/**
 * Ticks a run's manual items from one delivery that arrived after the run started. Returns true
 * when something changed. The console calls this for deliveries after a run has finished, too.
 */
export function applyManualEvent(run: CheckRun, event: StoredEvent): boolean {
  if (!event.verified || event.environment !== "sandbox" || event.seq <= run.start_seq) return false;
  let changed = false;
  const tick = (rowId: string, reason: string) => {
    const row = run.rows.find((r) => r.id === rowId);
    if (!row || row.status === "pass") return;
    row.status = "pass";
    row.reason = reason;
    row.finished_at = event.received_at;
    changed = true;
  };
  if (event.flags.duplicate) {
    tick(
      MANUAL_ROWS.replay,
      `A repeat delivery of ${event.event_type ?? "an event"} (webhook-id ${event.webhook_id}) arrived and was flagged duplicate, not processed again.`,
    );
  } else if (event.event_type === "job.rescheduled") {
    tick(MANUAL_ROWS.rescheduled, `job.rescheduled arrived${event.external_reference ? ` for ${event.external_reference}` : ""}, signature verified.`);
  } else if (event.event_type === "webhook.test") {
    tick(MANUAL_ROWS.testEvent, "webhook.test arrived, signature verified.");
  }
  if (changed) {
    run.summary = summarize(run.rows);
    run.timeline = buildTimeline(run);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------------------------

/** A check that did not hold. The message is the reason shown on the row. */
class CheckFailure extends Error {
  readonly tcError: CheckRow["error"];
  constructor(message: string, tcError: CheckRow["error"] = null) {
    super(message);
    this.name = "CheckFailure";
    this.tcError = tcError;
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

function tcErrorOf(error: TcApiError): NonNullable<CheckRow["error"]> {
  return { status: error.status, code: error.code, message: error.message, request_id: error.requestId };
}

function describeError(error: unknown): { reason: string; tcError: CheckRow["error"] } {
  if (error instanceof CheckFailure) return { reason: error.message, tcError: error.tcError };
  if (error instanceof TcApiError) {
    const hint = error.hint;
    return {
      reason: `${error.code} (HTTP ${error.status || "no response"}): ${error.message}${hint ? ` ${hint}` : ""}`,
      tcError: tcErrorOf(error),
    };
  }
  if (error instanceof TcInputError) return { reason: `${error.code}: ${error.message}`, tcError: null };
  return { reason: `Unexpected error: ${(error as Error)?.message ?? String(error)}`, tcError: null };
}

const MAX_BODY_CHARS = 20_000;

/** A response body for the record: parsed JSON, signed upload URLs and tokens masked, size bounded. */
function bodyForRecord(text: string): unknown {
  if (!text) return null;
  if (text.length > MAX_BODY_CHARS) return `${text.slice(0, MAX_BODY_CHARS)}… (${text.length} characters)`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = { ...(parsed as Record<string, unknown>) };
    // Step 1 of an upload returns a signed URL and token: short-lived, but a credential all the same.
    if (typeof record.upload_url === "string") {
      try {
        const url = new URL(record.upload_url);
        record.upload_url = `${url.origin}${url.pathname}${url.search ? "?[signed query masked]" : ""}`;
      } catch {
        record.upload_url = "[masked]";
      }
    }
    if (typeof record.token === "string") record.token = "[masked]";
    return record;
  }
  return parsed;
}

function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))} s`;
}

/** "4 minutes", "1 min 30 s" or "45 s". */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return `${rest} s`;
  if (!rest) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} min ${rest} s`;
}

/** Statuses the timeline treats as finished. */
const FINAL: ReadonlySet<RowStatus> = new Set(["pass", "fail", "skipped", "needs_you"]);

const CANCEL_REASON = "Sandbox check: cancel path";
const NEW_PRICE_CENTS = 123_400;

interface CallRecord {
  operation: string;
  ok: boolean;
  errorCode: string | null;
  message: string | null;
}

class SandboxCheck {
  readonly run: CheckRun;
  readonly #deps: SandboxCheckDeps;
  readonly #clock: CheckClock;
  readonly #timings: CheckTimings;
  readonly #client: TcClient;
  readonly #tag: string;
  readonly #rows: Map<string, CheckRow>;
  #current: CheckRow | null = null;
  readonly #calls: CallRecord[] = [];
  readonly #triggerAt = new Map<string, number>();
  #lastSeq = 0;
  #a: Job | null = null;
  #b: Job | null = null;
  #tradeTypes: TradeType[] = [];
  /** Deliveries for the check's jobs (first deliveries and duplicates). */
  readonly #received: StoredEvent[] = [];
  /** First deliveries that matched no expected row. */
  readonly #extras: StoredEvent[] = [];
  readonly #matched = new Map<string, StoredEvent>();
  #retryArmedAt: number | null = null;
  /** How long the webhook wait allows after the last step (set when the wait starts). */
  #waitMs = 0;

  constructor(run: CheckRun, deps: SandboxCheckDeps) {
    this.run = run;
    this.#deps = deps;
    this.#clock = deps.clock ?? realClock;
    this.#timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#tag = deps.uniqueTag ?? randomBytes(4).toString("hex");
    this.#rows = new Map(run.rows.map((r) => [r.id, r]));
    this.#client = new TcClient({
      baseUrl: deps.baseUrl,
      apiKey: deps.apiKey,
      fetch: this.#recordingFetch(deps.fetch ?? globalThis.fetch.bind(globalThis)),
      onResponse: (info) => this.#onResponse(info),
    });
  }

  // -------------------------------------------------------------------------------------------
  // Bookkeeping
  // -------------------------------------------------------------------------------------------

  #row(id: string): CheckRow {
    const row = this.#rows.get(id);
    if (!row) throw new Error(`No check row ${id}`);
    return row;
  }

  #iso(): string {
    return new Date(this.#clock.now()).toISOString();
  }

  #emit(row: CheckRow | null): void {
    this.run.summary = summarize(this.run.rows);
    this.run.timeline = buildTimeline(this.run);
    try {
      this.#deps.onUpdate?.(this.run, row);
    } catch {
      // A faulty listener must never stop the check.
    }
  }

  #begin(row: CheckRow, reason: string | null = null): void {
    row.status = "running";
    row.reason = reason;
    row.started_at = this.#iso();
    this.#emit(row);
  }

  #finish(row: CheckRow, status: RowStatus, reason: string | null): void {
    row.status = status;
    row.reason = reason;
    row.finished_at = this.#iso();
    if (row.started_at) row.duration_ms = Date.parse(row.finished_at) - Date.parse(row.started_at);
    if (status === "pass") this.#triggerAt.set(row.id, this.#clock.now());
    this.#emit(row);
  }

  #setJob(which: "a" | "b", job: Job): void {
    if (which === "a") this.#a = job;
    else this.#b = job;
    const ref: CheckJobRef = { id: job.id, external_reference: job.external_reference, status: job.status };
    this.run.jobs[which] = ref;
  }

  /** The HTTP status of the last exchange the row made. */
  #lastStatus(row: CheckRow): number {
    return row.exchanges.at(-1)?.status ?? 0;
  }

  #recordingFetch(base: typeof fetch): typeof fetch {
    const apiBase = this.#deps.baseUrl.replace(/\/+$/, "");
    const apiPath = new URL(apiBase).pathname;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const toApi = url.href.startsWith(apiBase);
      const headers = new Headers(init?.headers);
      const requestHeaders: Record<string, string> = {};
      const idempotencyKey = headers.get("idempotency-key");
      if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;
      let requestBody: unknown = null;
      if (typeof init?.body === "string") {
        try {
          requestBody = JSON.parse(init.body);
        } catch {
          requestBody = init.body;
        }
      } else if (init?.body instanceof Uint8Array) {
        requestBody = `<${init.body.byteLength} bytes, ${headers.get("content-type") ?? "no content type"}>`;
      }
      const exchange: Exchange = {
        operation: toApi ? "" : "attachments.upload",
        method,
        path: toApi ? `${url.pathname.slice(apiPath.length)}${url.search}` : "(signed upload URL)",
        request_headers: requestHeaders,
        request_body: requestBody,
        status: 0,
        response_body: null,
        request_id: null,
        error_code: null,
        duration_ms: 0,
      };
      this.#current?.exchanges.push(exchange);
      const started = performance.now();
      try {
        const response = await base(input, init);
        const text = await response.clone().text();
        exchange.status = response.status;
        exchange.request_id = response.headers.get("x-request-id");
        exchange.response_body = bodyForRecord(text);
        if (!response.ok) {
          const body = exchange.response_body as { error?: { code?: unknown } } | null;
          exchange.error_code = typeof body?.error?.code === "string" ? body.error.code : `HTTP_${response.status}`;
        }
        return response;
      } catch (error) {
        exchange.error_code = "NETWORK_ERROR";
        exchange.response_body = (error as Error)?.message ?? String(error);
        throw error;
      } finally {
        exchange.duration_ms = Math.round(performance.now() - started);
      }
    }) as typeof fetch;
  }

  #onResponse(info: ResponseInfo): void {
    const exchanges = this.#current?.exchanges ?? [];
    const exchange = [...exchanges].reverse().find((e) => e.operation === "" || (e.operation === info.operation && e.status === info.status));
    if (exchange && exchange.operation === "") exchange.operation = info.operation;
    const body = exchange?.response_body as { error?: { message?: unknown } } | null | undefined;
    this.#calls.push({
      operation: info.operation,
      ok: info.ok,
      errorCode: info.errorCode,
      message: typeof body?.error?.message === "string" ? body.error.message : null,
    });
    this.#deps.coverage?.recordResponse("sandbox", info);
    log.info(`Sandbox check: TC ${info.method} ${info.path}`, {
      status: info.status,
      error: info.errorCode ?? undefined,
      request_id: info.requestId ?? undefined,
      ms: info.durationMs,
    });
  }

  /**
   * Runs one step as one row. `skipReason` set: the row is skipped with it. Returns true when the
   * step passed.
   */
  async #step(rowId: string, work: (row: CheckRow) => Promise<string | null | void>, skipReason: string | null = null): Promise<boolean> {
    const row = this.#row(rowId);
    if (skipReason) {
      this.#finish(row, "skipped", skipReason);
      return false;
    }
    this.#begin(row);
    this.#current = row;
    let passed = false;
    try {
      const note = await work(row);
      this.#current = null;
      this.#finish(row, "pass", note ?? null);
      passed = true;
    } catch (error) {
      this.#current = null;
      const { reason, tcError } = describeError(error);
      row.error = tcError;
      this.#finish(row, "fail", reason);
    } finally {
      this.#current = null;
      this.#updateScopes(false);
      await this.#pollEvents();
    }
    return passed;
  }

  /** `includeManual`: the run stopped before anything useful happened, so manual items are moot too. */
  #skipRemaining(reason: string, includeManual = false): void {
    for (const row of this.run.rows) {
      const open = row.status === "waiting" || row.status === "running" || (includeManual && row.manual && row.status === "needs_you");
      if (open) this.#finish(row, "skipped", reason);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The whole run
  // -------------------------------------------------------------------------------------------

  async execute(): Promise<CheckRun> {
    try {
      this.run.start_seq = await this.#deps.events.latestSeq().catch(() => 0);
      this.#lastSeq = this.run.start_seq;
      this.#emit(null);

      // The key's prefix first, before any request: the client sends the key with every call, so a
      // live key must never reach even the health route.
      const sandboxKey = await this.#step("keys.prefix", async () => {
        expect(this.#deps.apiKey?.startsWith("tc_test_"), "The sandbox check needs a sandbox key (tc_test_…) in TC_TEST_API_KEY. It never uses a live key, so it sent nothing.");
        return `${keyPrefix(this.#deps.apiKey)} (sandbox)`;
      });
      if (!sandboxKey) {
        this.#skipRemaining("Skipped: the check runs only with a sandbox key, so nothing was sent to TC.", true);
        return this.run;
      }
      const healthy = await this.#step("keys.health", async () => {
        const health = await this.#client.health();
        expect(health?.status === "ok", `TC answered status ${JSON.stringify(health?.status)}, expected "ok".`);
        expect(health.version === "v1", `TC answered API version ${JSON.stringify(health.version)}, expected "v1".`);
        return `ok, API ${health.version}`;
      });
      if (!healthy) {
        this.#skipRemaining("Skipped: TC did not answer the health check, so nothing else was tried.", true);
        return this.run;
      }
      await this.#step("keys.webhook_secret", async () => {
        expect(
          this.#deps.webhookSecretConfigured,
          "TC_TEST_WEBHOOK_SECRET is not set, so the listener refuses every sandbox delivery (503). Put your sandbox endpoint's whsec_ secret in .env and restart.",
        );
        return "set (only whether it is set is shown, never the secret)";
      });

      await this.#securitySelfTest();
      await this.#referenceData();
      await this.#jobsAndLifecycle();
      await this.#waitForWebhooks();
      await this.#compareWithGet("A");
      await this.#compareWithGet("B");
      this.#reportUnexpected();
      this.#updateScopes(true);
    } catch (error) {
      log.error("The sandbox check stopped unexpectedly", { error: (error as Error)?.message ?? String(error) });
      this.#skipRemaining("Stopped: an unexpected error in the check itself (see the server log).");
    } finally {
      this.#deps.retryProbe?.disarm();
      this.run.state = "finished";
      this.run.finished_at = this.#iso();
      this.#emit(null);
    }
    return this.run;
  }

  // -------------------------------------------------------------------------------------------
  // Security: the listener refuses what TC did not sign
  // -------------------------------------------------------------------------------------------

  async #securitySelfTest(): Promise<void> {
    const url = this.#deps.listenerUrl;
    const listenerFetch = this.#deps.listenerFetch ?? globalThis.fetch.bind(globalThis);
    const post = async (row: CheckRow, webhookId: string, signed: boolean): Promise<string> => {
      const body = JSON.stringify({
        id: webhookId,
        type: "job.status_changed",
        created_at: new Date().toISOString(),
        api_version: "2026-10-01",
        data: { job: null, changes: {} },
      });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (signed) {
        // Signed correctly, but with a random secret that is not the endpoint's.
        const timestamp = String(Math.floor(Date.now() / 1000));
        const forgedKey = randomBytes(32);
        const signature = createHmac("sha256", forgedKey).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
        headers["webhook-id"] = webhookId;
        headers["webhook-timestamp"] = timestamp;
        headers["webhook-signature"] = `v1,${signature}`;
      }
      const exchange: Exchange = {
        operation: "webhook.self_test",
        method: "POST",
        path: `${new URL(url).pathname} (this server's own listener)`,
        request_headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("webhook-"))),
        request_body: JSON.parse(body),
        status: 0,
        response_body: null,
        request_id: null,
        error_code: null,
        duration_ms: 0,
      };
      row.exchanges.push(exchange);
      const started = performance.now();
      let response: Response;
      try {
        response = await listenerFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        exchange.error_code = "NETWORK_ERROR";
        throw new CheckFailure(`Could not reach the webhook listener at ${url}: ${(error as Error)?.message ?? String(error)}`);
      } finally {
        exchange.duration_ms = Math.round(performance.now() - started);
      }
      exchange.status = response.status;
      exchange.response_body = bodyForRecord(await response.text());
      if (response.status === 401) return "401, refused and logged with the refused deliveries (the body is not kept)";
      if (response.status === 503) {
        throw new CheckFailure("The listener answered 503: TC_TEST_WEBHOOK_SECRET is not set, so it refuses every sandbox delivery, real ones included.");
      }
      throw new CheckFailure(`The listener answered ${response.status}, expected 401. It must refuse deliveries TC did not sign.`);
    };
    await this.#step("security.forged", (row) => post(row, `check-forged-${this.#tag}`, true));
    await this.#step("security.unsigned", (row) => post(row, `check-unsigned-${this.#tag}`, false));
  }

  // -------------------------------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------------------------------

  async #referenceData(): Promise<void> {
    await this.#step("reference.job_types", async () => {
      const list = await this.#client.listJobTypes();
      expect(Array.isArray(list), "data is not a list");
      return `${list.length} job types`;
    });
    await this.#step("reference.trade_types", async () => {
      const list = await this.#client.listTradeTypes();
      expect(Array.isArray(list), "data is not a list");
      this.#tradeTypes = list;
      return `${list.length} trade types`;
    });
    await this.#step("reference.accreditations", async () => {
      const list = await this.#client.listAccreditations();
      expect(Array.isArray(list), "data is not a list");
      const withTrades = list.filter((a) => Array.isArray(a.trade_type_codes)).length;
      return withTrades
        ? `${list.length} accreditations; ${withTrades} list their trades (trade_type_codes)`
        : `${list.length} accreditations (no trade_type_codes yet, so the console shows them all)`;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Jobs, attachments and the sandbox lifecycle
  // -------------------------------------------------------------------------------------------

  #reference(which: "A" | "B"): string {
    return `CHECK-${new Date(this.#clock.now()).toISOString().slice(0, 10)}-${this.#tag}-${which}`;
  }

  /** Obviously fake example data. Phone numbers are from ACMA's range reserved for fiction. */
  #jobBody(which: "A" | "B", publish: boolean): CreateJobRequest {
    const start = new Date(this.#clock.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const trade = this.#tradeTypes.find((t) => /ELECTRIC/i.test(t.code)) ?? this.#tradeTypes[0];
    return {
      title: which === "A" ? "Sandbox check: job A (lifecycle)" : "Sandbox check: job B (cancel path)",
      description: "Created by the tc-example-server sandbox check. Example data only.",
      external_reference: this.#reference(which),
      ...(trade ? { trade_codes: [trade.code] } : {}),
      site: { address: "12 Example St", suburb: "Exampleton", state: "NSW", postcode: "2000", access_instructions: "Example data only." },
      schedule: { preferred_start_date: start, time_window: "MORNING" },
      contacts: [{ name: "Alex Example", phone: "0491 570 156", email: "alex@example.com", role: "SITE_OWNER" }],
      // Job A gets its price by PATCH (so job.price_changed can be checked); job B is created
      // published, and priced, as most integrations do.
      ...(which === "B" ? { price: { ex_gst_cents: 150_000 } } : {}),
      publish,
    };
  }

  async #jobsAndLifecycle(): Promise<void> {
    const needA = () => (this.#a ? null : "Skipped: job A (the draft) was not created.");
    const bodyA = this.#jobBody("A", false);
    const idempotencyKey = randomUUID();

    await this.#step("jobs.create_draft", async (row) => {
      const job = await this.#client.createJob(bodyA, { idempotencyKey });
      expect(job?.id, "The answer has no job id.");
      this.#setJob("a", job);
      if (this.#deps.options.testRetries && this.#deps.retryProbe) {
        // Armed at once: the first delivery for this job (usually job.created) gets the 500.
        this.#deps.retryProbe.arm(job.id);
        this.#retryArmedAt = this.#clock.now();
      }
      expect(this.#lastStatus(row) === 201, `TC answered HTTP ${this.#lastStatus(row)}, expected 201 for a new job.`);
      expect(job.status === "DRAFT", `The new job is ${job.status}, expected DRAFT (publish: false).`);
      expect(job.replayed !== true, "The new job says replayed: true, but this Idempotency-Key was new.");
      expect(job.external_reference === bodyA.external_reference, `external_reference is ${JSON.stringify(job.external_reference)}, expected ${bodyA.external_reference}.`);
      return `${job.external_reference}, DRAFT, HTTP 201`;
    });

    await this.#step(
      "jobs.replay",
      async (row) => {
        const job = await this.#client.createJob(bodyA, { idempotencyKey });
        const status = this.#lastStatus(row);
        expect(job?.id === this.#a!.id, `TC answered HTTP ${status} with a different job (${job?.id}): the Idempotency-Key did not replay the first one.`);
        expect(status === 200, `TC answered HTTP ${status}, expected 200 for a replay.`);
        expect(job.replayed === true, `replayed is ${JSON.stringify(job.replayed)}, expected true.`);
        return "HTTP 200, the same job, replayed: true";
      },
      needA(),
    );

    const bodyB = this.#jobBody("B", true);
    await this.#step("jobs.create_second", async (row) => {
      const job = await this.#client.createJob(bodyB, { idempotencyKey: randomUUID() });
      expect(job?.id, "The answer has no job id.");
      this.#setJob("b", job);
      expect(this.#lastStatus(row) === 201, `TC answered HTTP ${this.#lastStatus(row)}, expected 201.`);
      expect(job.status === "OPEN", `The new job is ${job.status}, expected OPEN (publish: true).`);
      return `${job.external_reference}, OPEN`;
    });

    await this.#step(
      "jobs.get_id",
      async () => {
        const job = await this.#client.getJob(this.#a!.id);
        expect(job.id === this.#a!.id, `TC returned job ${job.id}, expected ${this.#a!.id}.`);
        return `${job.external_reference}, ${job.status}`;
      },
      needA(),
    );
    await this.#step(
      "jobs.get_ext",
      async () => {
        const job = await this.#client.getJob(extId(this.#a!.external_reference!));
        expect(job.id === this.#a!.id, `ext:${this.#a!.external_reference} returned job ${job.id}, expected ${this.#a!.id}.`);
        return `ext:${job.external_reference} → ${job.id}`;
      },
      needA(),
    );

    await this.#step(
      "jobs.patch_field",
      async () => {
        const title = "Sandbox check: job A (lifecycle, edited)";
        const job = await this.#client.updateJob(this.#a!.id, { title });
        this.#setJob("a", job);
        expect(job.title === title, `The title is ${JSON.stringify(job.title)} after the PATCH.`);
        return "title changed";
      },
      needA(),
    );
    await this.#step(
      "jobs.patch_price",
      async () => {
        const job = await this.#client.updateJob(this.#a!.id, { price: { ex_gst_cents: NEW_PRICE_CENTS } });
        this.#setJob("a", job);
        expect(job.price?.ex_gst_cents === NEW_PRICE_CENTS, `price.ex_gst_cents is ${job.price?.ex_gst_cents} after the PATCH, expected ${NEW_PRICE_CENTS}.`);
        return `ex GST ${NEW_PRICE_CENTS} cents, total ${job.price?.total_cents ?? "-"} cents (expect job.price_changed)`;
      },
      needA(),
    );
    await this.#step(
      "jobs.note",
      async () => {
        const note = await this.#client.addNote(this.#a!.id, "Sandbox check note. Example data only.");
        expect(typeof note?.id === "string", "The answer has no note id.");
        return note.message_id ? "added, and sent to the installer as a message" : "added to the job record (no installer, so no message)";
      },
      needA(),
    );
    await this.#step(
      "jobs.list",
      async () => {
        const ids = [this.#a!.id, ...(this.#b ? [this.#b.id] : [])];
        // TC's own timestamps, so the two clocks never need to agree. updated_since is inclusive.
        const since = [this.#a!.created_at, ...(this.#b ? [this.#b.created_at] : [])].sort()[0]!;
        const seen = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await this.#client.listJobs({ updated_since: since, limit: 1, ...(cursor ? { cursor } : {}) });
          pages++;
          expect(Array.isArray(page?.data), "data is not a list");
          for (const job of page.data) {
            expect(!seen.has(job.id), `Job ${job.id} came back on two pages.`);
            seen.add(job.id);
          }
          cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
        } while (cursor && pages < 10 && !ids.every((id) => seen.has(id)));
        const missing = ids.filter((id) => !seen.has(id));
        expect(missing.length === 0, `Not found in ${pages} page(s) of updated_since=${since}: ${missing.join(", ")}.`);
        return ids.length > 1
          ? `found both jobs in ${pages} pages of limit 1, following next_cursor`
          : `found job A in ${pages} page(s) (only one job to page through: job B was not created)`;
      },
      needA(),
    );
    const published = await this.#step(
      "jobs.publish",
      async () => {
        const job = await this.#client.publishJob(this.#a!.id);
        this.#setJob("a", job);
        expect(job.status === "OPEN", `The job is ${job.status} after publishing, expected OPEN.`);
        return "DRAFT → OPEN";
      },
      needA(),
    );

    await this.#attachments(needA());

    let previousOk = published;
    for (const step of LIFECYCLE_STEPS) {
      const skip = previousOk ? null : published ? "Skipped: the step before it failed." : "Skipped: job A was not published.";
      previousOk = await this.#step(
        step.rowId,
        async () => {
          const job = await this.#client.simulate(this.#a!.id, step.target);
          this.#setJob("a", job);
          expect(job.status === step.target, `The job is ${job.status} after simulating ${step.target}.`);
          if (step.target === "SCHEDULED") {
            expect(job.schedule?.scheduled_date, "scheduled_date is still empty after SCHEDULED.");
            return `SCHEDULED for ${job.schedule.scheduled_date}`;
          }
          if (step.target === "WORK_COMPLETE") {
            expect(job.work_completed_at, "work_completed_at is still empty after WORK_COMPLETE.");
          }
          if (step.target === "ASSIGNED") {
            return job.assigned_installer ? `ASSIGNED to ${job.assigned_installer.company_name}` : "ASSIGNED (no installer is attached in the sandbox)";
          }
          return step.target;
        },
        skip,
      );
      if (step.target === "ASSIGNED") {
        await this.#step(
          "jobs.patch_locked",
          async () => {
            try {
              await this.#client.updateJob(this.#a!.id, { title: "Sandbox check: this change must be refused" });
            } catch (error) {
              if (error instanceof TcApiError && error.status === 409 && error.code === "JOB_LOCKED") {
                return `409 JOB_LOCKED, as expected${error.requestId ? ` (request_id ${error.requestId})` : ""}`;
              }
              if (error instanceof TcApiError) {
                throw new CheckFailure(`Expected 409 JOB_LOCKED, got ${error.code} (HTTP ${error.status}): ${error.message}`, tcErrorOf(error));
              }
              throw error;
            }
            throw new CheckFailure("TC accepted a PATCH on an ASSIGNED job. Expected 409 JOB_LOCKED: changes after assignment belong in the TC web app.");
          },
          previousOk ? null : "Skipped: job A did not reach ASSIGNED.",
        );
      }
    }

    // Job B: ASSIGNED, then cancelled. A live job can carry a fee once an installer is assigned, so
    // cancelling after ASSIGNED shows that a sandbox cancel stays free where a fee could apply.
    const bAssigned = await this.#step(
      "lifecycle.b_assigned",
      async () => {
        const job = await this.#client.simulate(this.#b!.id, "ASSIGNED");
        this.#setJob("b", job);
        expect(job.status === "ASSIGNED", `The second job is ${job.status} after simulating ASSIGNED.`);
        return "ASSIGNED (the cancel comes next)";
      },
      this.#b ? null : "Skipped: the second job was not created.",
    );
    await this.#step(
      "lifecycle.cancel",
      async () => {
        const result = await this.#client.cancelJob(this.#b!.id, CANCEL_REASON);
        expect(result?.status === "CANCELLED", `The cancel answered status ${JSON.stringify(result?.status)}, expected CANCELLED.`);
        expect(
          result.fee_applied === false && !result.fee_amount_cents && !result.gst_cents,
          `TC applied a cancellation fee to a sandbox job cancelled from ${result.previous_status} (fee_applied is true or the fee fields are not zero). Sandbox cancellations must be free.`,
        );
        if (bAssigned) {
          expect(result.previous_status === "ASSIGNED", `previous_status is ${JSON.stringify(result.previous_status)}, expected ASSIGNED.`);
        }
        const job = await this.#client.getJob(this.#b!.id);
        this.#setJob("b", job);
        expect(job.status === "CANCELLED", `A fresh GET says ${job.status}, expected CANCELLED.`);
        expect(job.cancellation_reason === CANCEL_REASON, `cancellation_reason is ${JSON.stringify(job.cancellation_reason)}, expected ${JSON.stringify(CANCEL_REASON)}.`);
        const note = bAssigned ? "" : " (it never reached ASSIGNED, so the no-fee rule after assignment was not shown)";
        return `${result.previous_status} → CANCELLED, no fee (fee_applied false, sandbox), reason kept${note}`;
      },
      this.#b ? null : "Skipped: the second job was not created.",
    );
  }

  async #attachments(skip: string | null): Promise<void> {
    const png = tinyPng();
    const filename = "sandbox-check.png";
    const title = "Sandbox check photo";
    let upload: AttachmentUpload | null = null;
    const created = await this.#step(
      "attachments.create",
      async () => {
        upload = await this.#client.createAttachmentUpload(this.#a!.id, {
          filename,
          content_type: "image/png",
          size_bytes: png.byteLength,
          category: "SITE_PHOTO",
          title,
        });
        expect(upload?.attachment_id, "The answer has no attachment_id.");
        expect(typeof upload.upload_url === "string" && upload.upload_url.startsWith("https://"), "The answer has no https upload_url.");
        return `upload URL issued, valid for ${upload.expires_in} s`;
      },
      skip,
    );
    const uploaded = await this.#step(
      "attachments.upload",
      async () => {
        await this.#client.uploadAttachmentBytes(upload!, png);
        return `${png.byteLength} bytes, image/png (the API key is not sent to storage)`;
      },
      skip ?? (created ? null : "Skipped: step 1 failed."),
    );
    await this.#step(
      "attachments.complete",
      async () => {
        const record = await this.#client.completeAttachmentUpload(this.#a!.id, upload!.attachment_id, {
          filename,
          content_type: "image/png",
          size_bytes: png.byteLength,
          storage_path: upload!.storage_path,
          category: "SITE_PHOTO",
          title,
          is_public: false,
        });
        expect(record?.is_public === false, `is_public is ${JSON.stringify(record?.is_public)}, expected false: the file must stay private.`);
        if (record.category != null) expect(record.category === "SITE_PHOTO", `category is ${JSON.stringify(record.category)}, expected SITE_PHOTO.`);
        return "private, SITE_PHOTO, TC re-checked the file";
      },
      skip ?? (uploaded ? null : "Skipped: step 2 failed."),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------------------------

  #jobOf(event: StoredEvent): "A" | "B" | null {
    const id = event.job_id?.toLowerCase();
    if (!id) return null;
    if (this.#a && id === this.#a.id.toLowerCase()) return "A";
    if (this.#b && id === this.#b.id.toLowerCase()) return "B";
    return null;
  }

  static #matches(spec: ExpectedEvent, event: StoredEvent): boolean {
    if (event.event_type !== spec.type || event.job_status !== spec.jobStatus) return false;
    if (spec.to === undefined) return true;
    const change = (event.changes as { job_status?: { to?: unknown } } | null)?.job_status;
    return change?.to === spec.to;
  }

  async #pollEvents(): Promise<void> {
    let fresh: StoredEvent[];
    try {
      fresh = await this.#deps.events.since(this.#lastSeq);
    } catch {
      return; // try again on the next poll
    }
    for (const event of fresh) {
      this.#lastSeq = Math.max(this.#lastSeq, event.seq);
      this.#absorb(event);
    }
  }

  #absorb(event: StoredEvent): void {
    if (applyManualEvent(this.run, event)) this.#emit(null);

    const retryRow = this.#rows.get("webhooks.retry");
    const refused = this.#ownRefusal();
    if (retryRow && refused && event.webhook_id === refused.webhookId && !FINAL.has(retryRow.status)) {
      this.#finish(
        retryRow,
        "pass",
        `The listener answered 500 to ${event.event_type} (webhook-id ${refused.webhookId}); TC delivered it again ${seconds(Date.parse(event.received_at) - refused.at)} later.`,
      );
    }

    const job = this.#jobOf(event);
    if (!job) return;
    this.#received.push(event);
    if (event.flags.duplicate) return;
    const spec = EXPECTED_EVENTS.find((e) => e.job === job && !this.#matched.has(e.rowId) && SandboxCheck.#matches(e, event));
    if (!spec) {
      this.#extras.push(event);
      return;
    }
    this.#matched.set(spec.rowId, event);
    const row = this.#row(spec.rowId);
    const triggeredAt = this.#triggerAt.get(spec.trigger);
    const after = triggeredAt !== undefined ? Date.parse(event.received_at) - triggeredAt : null;
    const problems: string[] = [];
    if (!event.verified) problems.push("its signature was not verified");
    if (event.flags.environment_mismatch) problems.push("its job says is_sandbox false, on the sandbox path");
    if (problems.length) {
      this.#finish(row, "fail", `Arrived, but ${problems.join(" and ")}.`);
      return;
    }
    const late = row.status === "fail";
    this.#finish(
      row,
      "pass",
      `${late ? "Arrived late: " : "Arrived "}${after !== null ? `${seconds(after)} after the step` : ""}, signature verified, job ${event.job_status}`.replace(" ,", ","),
    );
  }

  #missingReason(spec: ExpectedEvent): string {
    const forJob = this.#received.filter((e) => this.#jobOf(e) === spec.job);
    const wait = duration(this.#waitMs);
    if (this.#received.length === 0) {
      return `Nothing arrived for the check's jobs within ${wait} of the last step. Is the tunnel running, and does your TC sandbox endpoint point at it (Settings → API & Webhooks → Webhooks)? Check its Deliveries tab for errors.`;
    }
    // A near miss is a delivery of this type for this job that no other row has already claimed. One
    // that matched its own row (e.g. job.status_changed → OPEN) says nothing about this row's event.
    const claimed = new Set([...this.#matched.values()].map((e) => e.webhook_id));
    const nearMiss = forJob.find(
      (e) => e.event_type === spec.type && !e.flags.duplicate && !claimed.has(e.webhook_id) && !SandboxCheck.#matches(spec, e),
    );
    if (nearMiss) {
      return `A ${spec.type} arrived, but the job inside it was ${nearMiss.job_status}${spec.to ? ` (changes.job_status.to ${JSON.stringify((nearMiss.changes as { job_status?: { to?: unknown } } | null)?.job_status?.to)})` : ""}, expected ${spec.to ?? spec.jobStatus}.`;
    }
    const what = `${spec.type}${spec.to ? ` → ${spec.to}` : ""}`;
    if (this.#received.some((e) => e.event_type === spec.type)) {
      // This type did arrive (for either job), so the endpoint is subscribed to it: the delivery is
      // most likely still queued behind others, or failed and is waiting for TC's retry.
      return `No ${what} for job ${spec.job} arrived within ${wait} of the last step. Your endpoint does receive ${spec.type}, so this delivery is most likely still queued or failed: TC sends up to ${TC_DELIVERIES_PER_RUN} a minute per endpoint, oldest first, including retries of earlier failures. Check the Deliveries tab for your sandbox endpoint (Settings → API & Webhooks → Webhooks).`;
    }
    return `No ${what} arrived within ${wait} of the last step, although other events for job ${spec.job} did. TC sends only the event types your endpoint subscribes to: check that ${spec.type} is ticked for your sandbox endpoint (Settings → API & Webhooks → Webhooks).`;
  }

  /**
   * The delivery the probe refused, only when this run armed it. A refusal from an earlier run
   * (its record stays until the probe is armed again) never counts for this run's retry row.
   */
  #ownRefusal(): RefusedDelivery | null {
    const refused = this.#deps.retryProbe?.refused ?? null;
    if (!refused || this.#retryArmedAt === null || refused.at < this.#retryArmedAt) return null;
    return refused;
  }

  /** What a webhook row says while the check waits. */
  #waitingNote(arrived: number, expected: number, deliveries: number): string {
    const runs = Math.ceil(deliveries / TC_DELIVERIES_PER_RUN);
    return `${WAITING_NOTE_PREFIX} ${arrived} of ${expected} so far. TC sends up to ${TC_DELIVERIES_PER_RUN} a minute, so this can take about ${duration(runs * this.#timings.dispatchMs)}; the check waits up to ${duration(this.#waitMs)} after the last step.`;
  }

  async #waitForWebhooks(): Promise<void> {
    const t = this.#timings;
    // Every wait runs from here, the end of the last step, not from each event's own step: TC
    // sends in batches, oldest first, so an early step's webhooks can queue behind later ones.
    const lastStepAt = this.#clock.now();
    const retryRow = this.#rows.get("webhooks.retry");
    const expected = EXPECTED_EVENTS.filter((spec) => this.#triggerAt.has(spec.trigger));
    const active: ExpectedEvent[] = [];
    for (const spec of EXPECTED_EVENTS) {
      const row = this.#row(spec.rowId);
      if (FINAL.has(row.status)) continue; // already arrived
      if (!this.#triggerAt.has(spec.trigger)) {
        this.#finish(row, "skipped", "Skipped: the step that sends it did not run or failed.");
        continue;
      }
      active.push(spec);
    }

    if (retryRow) {
      if (!this.#deps.retryProbe) {
        this.#finish(retryRow, "needs_you", this.#deps.retryUnavailableReason ?? "The retry test is not available here.");
      } else if (this.#retryArmedAt === null) {
        this.#finish(retryRow, "skipped", "Skipped: job A was not created, so there was nothing to refuse.");
      }
    }

    if (!this.#deps.webhookSecretConfigured) {
      const reason = "TC_TEST_WEBHOOK_SECRET is not set, so the listener refuses every sandbox delivery (503).";
      for (const spec of active) this.#finish(this.#row(spec.rowId), "fail", reason);
      if (retryRow && !FINAL.has(retryRow.status)) this.#finish(retryRow, "fail", reason);
      return;
    }

    // What TC sends for the check's jobs: the expected events, job B's possible price change at
    // create (it is created with a price), and the refused delivery once more.
    const retrying = retryRow !== undefined && !FINAL.has(retryRow.status);
    const deliveries = expected.length + (this.#triggerAt.has("jobs.create_second") ? 1 : 0) + (retrying ? 1 : 0);
    this.#waitMs = webhookWaitMs(deliveries, retrying, t);
    const until = lastStepAt + this.#waitMs;
    const hardStop = lastStepAt + t.overallMs;
    const arrivedCount = () => expected.filter((spec) => this.#matched.has(spec.rowId)).length;
    let shown = arrivedCount();
    const note = () => this.#waitingNote(shown, expected.length, deliveries);

    for (const spec of active) {
      const row = this.#row(spec.rowId);
      if (!FINAL.has(row.status)) this.#begin(row, note());
    }
    if (retryRow && !FINAL.has(retryRow.status)) {
      this.#begin(
        retryRow,
        "The listener answers 500 once to the next delivery for job A, then waits for TC to send it again. TC tries again a minute after the 500 at the earliest, behind any deliveries still queued, so this can take a few minutes.",
      );
    }

    for (;;) {
      await this.#pollEvents();
      const now = this.#clock.now();
      const stop = now >= hardStop;
      const waiting: CheckRow[] = [];
      for (const spec of active) {
        const row = this.#row(spec.rowId);
        if (FINAL.has(row.status)) continue;
        if (stop || now >= until) this.#finish(row, "fail", this.#missingReason(spec));
        else waiting.push(row);
      }
      let pending = waiting.length > 0;
      if (pending && arrivedCount() !== shown) {
        shown = arrivedCount();
        for (const row of waiting) row.reason = note();
        this.#emit(waiting[0]!);
      }
      if (retryRow && !FINAL.has(retryRow.status)) {
        const refused = this.#ownRefusal();
        if (refused) {
          const retryUntil = Math.min(hardStop, Math.max(until, refused.at + t.retryMs));
          if (stop || now >= retryUntil) {
            this.#finish(retryRow, "fail", `The listener answered 500 to webhook-id ${refused.webhookId}, but TC did not deliver it again within ${duration(now - refused.at)}.`);
          } else {
            pending = true;
          }
        } else if (stop || now >= until) {
          this.#finish(retryRow, "fail", "No delivery for job A arrived, so the listener had nothing to answer 500 to.");
        } else {
          pending = true;
        }
      }
      if (!pending) break;
      await this.#clock.sleep(t.pollMs);
    }
  }

  async #compareWithGet(which: "A" | "B"): Promise<void> {
    const job = which === "A" ? this.#a : this.#b;
    const rowId = `webhooks.${which.toLowerCase()}.matches_get`;
    const events = this.#received.filter((e) => this.#jobOf(e) === which && !e.flags.duplicate && e.raw_body);
    const skip = !job
      ? `Skipped: job ${which} was not created.`
      : events.length === 0
        ? `Skipped: no webhook for job ${which} arrived.`
        : null;
    await this.#step(
      rowId,
      async () => {
        const latest = events.reduce((newest, e) => {
          const a = preciseInstant(newest.job_updated_at);
          const b = preciseInstant(e.job_updated_at);
          return a !== null && b !== null && b > a ? e : newest;
        });
        let held: Partial<Job> | null = null;
        try {
          held = (JSON.parse(latest.raw_body!) as { data?: { job?: Partial<Job> } }).data?.job ?? null;
        } catch {
          held = null;
        }
        expect(held, "The newest webhook's body could not be read.");
        const fresh = await this.#client.getJob(job!.id);
        this.#setJob(which === "A" ? "a" : "b", fresh);
        const fields: Array<[string, unknown, unknown]> = [
          ["status", held.status, fresh.status],
          ["external_reference", held.external_reference, fresh.external_reference],
          ["is_sandbox", held.is_sandbox, fresh.is_sandbox],
          ["price.total_cents", held.price?.total_cents, fresh.price?.total_cents],
          ["schedule.scheduled_date", held.schedule?.scheduled_date, fresh.schedule?.scheduled_date],
        ];
        const differences = fields.filter(([, a, b]) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null));
        expect(
          differences.length === 0,
          `The newest webhook (${latest.event_type}) differs from a fresh GET: ${differences
            .map(([name, a, b]) => `${name} ${JSON.stringify(a ?? null)} vs ${JSON.stringify(b ?? null)}`)
            .join("; ")}.`,
        );
        return `the newest webhook (${latest.event_type}) matches: ${fresh.status}, total ${fresh.price?.total_cents ?? "-"} cents`;
      },
      skip,
    );
  }

  #reportUnexpected(): void {
    const row = this.#row("webhooks.unexpected");
    if (!this.#a && !this.#b) {
      this.#finish(row, "skipped", "Skipped: the check created no jobs.");
      return;
    }
    const extras = this.#extras.filter((e) => !ALLOWED_EXTRA_TYPES.has(e.event_type ?? ""));
    const allowed = this.#extras.length - extras.length;
    if (extras.length === 0) {
      this.#finish(
        row,
        "pass",
        `None: every first delivery for the check's jobs was one it expected${allowed ? ` (plus ${allowed} extra job.price_changed, which TC may send whenever the total changes)` : ""}.`,
      );
      return;
    }
    const list = extras
      .map((e) => {
        const to = (e.changes as { job_status?: { to?: unknown } } | null)?.job_status?.to;
        return `${e.event_type}${e.event_type === "job.status_changed" && typeof to === "string" ? ` → ${to}` : ""} for job ${this.#jobOf(e)} (job ${e.job_status})`;
      })
      .join("; ");
    this.#finish(row, "needs_you", `Not expected: ${list}. TC may add events within v1; check that these are right.`);
  }

  /** Scope rows, worked out from the calls made so far. `final`: settle the ones still open. */
  #updateScopes(final: boolean): void {
    for (const scope of SCOPES) {
      const row = this.#row(`keys.scope.${scope}`);
      if (row.status === "pass" || row.status === "fail") continue;
      const operations = new Set<string>(ENDPOINTS.filter((e) => e.scope === scope).map((e) => e.operation));
      const calls = this.#calls.filter((c) => operations.has(c.operation));
      const used = [...new Set(calls.filter((c) => c.ok).map((c) => c.operation))];
      const forbidden = calls.find((c) => c.errorCode === "SCOPE_FORBIDDEN");
      if (used.length) {
        this.#finish(row, "pass", `used by ${used.join(", ")}`);
      } else if (forbidden) {
        this.#finish(
          row,
          "fail",
          hintFor("SCOPE_FORBIDDEN", forbidden.message ?? `API key lacks required scope '${scope}'`) ??
            `The key lacks ${scope}. Create a test key with ${scope} ticked (Settings → API & Webhooks → API keys).`,
        );
      } else if (final) {
        this.#finish(
          row,
          "skipped",
          calls.length ? "Not shown: its calls failed for another reason (see those rows)." : "Not shown: no call that needs it ran (an earlier step failed).",
        );
      }
    }
  }
}

/**
 * Starts a sandbox check. Returns the run at once (every row waiting), and a promise that
 * settles with the same, finished run. The run object is updated in place as it goes, and
 * onUpdate is called on every change.
 */
export function startSandboxCheck(deps: SandboxCheckDeps): { run: CheckRun; finished: Promise<CheckRun> } {
  const run = newCheckRun({
    source: deps.source,
    baseUrl: deps.baseUrl,
    apiKey: deps.apiKey,
    testRetries: deps.options.testRetries,
    now: (deps.clock ?? realClock).now(),
  });
  const check = new SandboxCheck(run, deps);
  return { run, finished: check.execute() };
}
