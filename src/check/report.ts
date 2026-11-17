// The sandbox check as plain text: what "Copy report" copies and what the CLI prints at the end.
// No markdown at all (no bullets, headings, asterisks or backticks), so it pastes cleanly into
// WhatsApp or an email.

import { CHECK_GROUPS, type CheckRow, type CheckRun, type CheckSummary } from "./types.ts";

/** "41 passed · 3 need you · 0 failed", plus skipped and still-running counts when there are any. */
export function summaryLine(summary: CheckSummary): string {
  const parts = [
    `${summary.passed} passed`,
    `${summary.needs_you} ${summary.needs_you === 1 ? "needs" : "need"} you`,
    `${summary.failed} failed`,
  ];
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  if (summary.pending) parts.push(`${summary.pending} to go`);
  return parts.join(" · ");
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return minutes ? `${minutes} min ${secs} s` : `${secs} s`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Strips what a chat app would read as formatting: backticks, asterisks and tildes. Underscores
 * stay (job.evidence_ready, TC_TEST_WEBHOOK_SECRET): inside a word they format nothing.
 */
function plain(text: string): string {
  return text.replace(/[`*~]/g, "").replace(/(^|\s)_+|_+(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim();
}

function groupLine(title: string, rows: CheckRow[]): string {
  const passed = rows.filter((r) => r.status === "pass").length;
  const failed = rows.filter((r) => r.status === "fail").length;
  const needs = rows.filter((r) => r.status === "needs_you").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const pending = rows.length - passed - failed - needs - skipped;
  if (passed === rows.length) return `${title}: all ${rows.length} passed`;
  const parts = [`${passed} of ${rows.length} passed`];
  if (failed) parts.push(`${failed} failed`);
  if (needs) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
  if (skipped) parts.push(`${skipped} skipped`);
  if (pending) parts.push(`${pending} to go`);
  return `${title}: ${parts.join(", ")}`;
}

export function formatReport(run: CheckRun): string {
  const lines: string[] = [];
  const took = run.finished_at ? ` · took ${formatDuration(Date.parse(run.finished_at) - Date.parse(run.started_at))}` : "";
  lines.push("Trade Connector sandbox check");
  lines.push(`${when(run.started_at)} · key ${run.key_prefix ?? "not set"}${took}`);
  lines.push(`${run.state === "running" ? "Still running" : "Result"}: ${summaryLine(run.summary)}`);
  if (run.options.test_retries) lines.push("Included the TC retry test.");
  lines.push("");

  for (const group of CHECK_GROUPS) {
    const rows = run.rows.filter((r) => r.group === group.id);
    if (rows.length === 0) continue;
    lines.push(groupLine(group.title, rows));
    for (const row of rows) {
      if (row.status === "fail") {
        const id = row.error?.request_id ? ` (request_id ${row.error.request_id})` : "";
        lines.push(`  Failed: ${plain(row.title)}. ${plain(row.reason ?? "")}${id}`);
      } else if (row.status === "needs_you") {
        lines.push(`  Needs you: ${plain(row.title)}. ${plain(row.reason ?? "")}`);
      }
    }
    const skipped = rows.filter((r) => r.status === "skipped");
    if (skipped.length === 1) lines.push(`  Skipped: ${plain(skipped[0]!.title)}. ${plain(skipped[0]!.reason ?? "")}`);
    else if (skipped.length > 1) lines.push(`  Skipped: ${skipped.length} checks, because something they need failed.`);
  }

  const jobs = [
    run.jobs.a ? `A ${run.jobs.a.external_reference ?? run.jobs.a.id} (${run.jobs.a.status})` : null,
    run.jobs.b ? `B ${run.jobs.b.external_reference ?? run.jobs.b.id} (${run.jobs.b.status})` : null,
  ].filter(Boolean);
  if (jobs.length) {
    lines.push("");
    lines.push(`Sandbox jobs used: ${jobs.join(", ")}`);
  }
  return lines.join("\n");
}
