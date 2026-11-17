// The shape of a sandbox check run: what the CLI prints, what the console shows, and what
// data/sandbox-check-runs.json keeps. One run is a list of rows in fixed groups; each row is one
// thing checked, with the requests it made and the answers it got.

/**
 * - waiting: not started yet
 * - running: under way (a request, or waiting for a webhook)
 * - pass
 * - needs_you: something only a person can do, or the sandbox cannot do (shown amber, not failed)
 * - fail: with the reason in words
 * - skipped: did not run because something it depends on failed (the reason says what)
 */
export type RowStatus = "waiting" | "running" | "pass" | "needs_you" | "fail" | "skipped";

export const ROW_STATUSES: readonly RowStatus[] = ["waiting", "running", "pass", "needs_you", "fail", "skipped"];

export const CHECK_GROUPS = [
  { id: "keys", title: "Keys & health" },
  { id: "reference", title: "Reference data" },
  { id: "jobs", title: "Jobs" },
  { id: "attachments", title: "Attachments" },
  { id: "lifecycle", title: "Sandbox lifecycle" },
  { id: "webhooks", title: "Webhooks" },
  { id: "security", title: "Security" },
] as const;

export type GroupId = (typeof CHECK_GROUPS)[number]["id"];

/** One HTTP exchange a row made. Never holds the API key or a webhook secret. */
export interface Exchange {
  /** The client's operation name (e.g. jobs.create), or a label such as webhook.self_test. */
  operation: string;
  method: string;
  /** Relative to the API base URL, e.g. /v1/jobs/ext:CHECK-1. */
  path: string;
  /** Only headers worth seeing, e.g. Idempotency-Key. Never Authorization. */
  request_headers: Record<string, string>;
  request_body: unknown;
  /** HTTP status, or 0 when no response arrived. */
  status: number;
  response_body: unknown;
  request_id: string | null;
  error_code: string | null;
  duration_ms: number;
}

export interface CheckRow {
  /** Stable across runs (so runs can be compared), e.g. "jobs.create_draft". */
  id: string;
  group: GroupId;
  title: string;
  status: RowStatus;
  /** In words: why it failed, what you need to do, or why it was skipped. A short note when it passed. */
  reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  exchanges: Exchange[];
  /** TC's error, when the row failed on one. */
  error: { status: number; code: string; message: string; request_id: string | null } | null;
  /** A manual item: amber until it happens, then ticked. Never counted as a failure. */
  manual: boolean;
}

export interface TimelineEvent {
  row_id: string;
  type: string;
  status: RowStatus;
}

export interface TimelineStep {
  /** A job status, e.g. ASSIGNED. */
  status: string;
  /** The API call that moves the job here has succeeded. */
  reached: boolean;
  /** The webhooks this step should send, as they arrive. */
  events: TimelineEvent[];
}

export interface TimelineLane {
  job: "A" | "B";
  label: string;
  job_id: string | null;
  external_reference: string | null;
  steps: TimelineStep[];
}

export interface CheckSummary {
  total: number;
  passed: number;
  needs_you: number;
  failed: number;
  skipped: number;
  /** waiting + running */
  pending: number;
}

export interface CheckJobRef {
  id: string;
  external_reference: string | null;
  status: string;
}

export interface CheckRun {
  id: string;
  source: "console" | "cli";
  state: "running" | "finished";
  started_at: string;
  finished_at: string | null;
  options: { test_retries: boolean };
  /** e.g. tc_test_ab12… (never the key). */
  key_prefix: string | null;
  base_url: string;
  /** The highest webhook seq when the run started: manual items tick on deliveries after it. */
  start_seq: number;
  jobs: { a: CheckJobRef | null; b: CheckJobRef | null };
  rows: CheckRow[];
  timeline: TimelineLane[];
  summary: CheckSummary;
}

/** What the run list shows for each kept run. */
export interface CheckRunSummary {
  id: string;
  source: CheckRun["source"];
  state: CheckRun["state"];
  started_at: string;
  finished_at: string | null;
  options: CheckRun["options"];
  summary: CheckSummary;
}

export function summarize(rows: readonly CheckRow[]): CheckSummary {
  const summary: CheckSummary = { total: rows.length, passed: 0, needs_you: 0, failed: 0, skipped: 0, pending: 0 };
  for (const row of rows) {
    if (row.status === "pass") summary.passed++;
    else if (row.status === "needs_you") summary.needs_you++;
    else if (row.status === "fail") summary.failed++;
    else if (row.status === "skipped") summary.skipped++;
    else summary.pending++;
  }
  return summary;
}

export function runSummary(run: CheckRun): CheckRunSummary {
  return {
    id: run.id,
    source: run.source,
    state: run.state,
    started_at: run.started_at,
    finished_at: run.finished_at,
    options: run.options,
    summary: run.summary,
  };
}
