// Pure view logic for the Sandbox check tab: no DOM, so Node's tests can import it directly.
// The run itself comes from the server (src/check/types.ts describes its shape).

export const GROUPS = [
  { id: "keys", title: "Keys & health" },
  { id: "reference", title: "Reference data" },
  { id: "jobs", title: "Jobs" },
  { id: "attachments", title: "Attachments" },
  { id: "lifecycle", title: "Sandbox lifecycle" },
  { id: "webhooks", title: "Webhooks" },
  { id: "security", title: "Security" },
];

/** How each status looks: the dot's class and white mark, and the words for its title and aria-label. */
export const STATUS_META = {
  pass: { label: "Passed", mark: "✓" },
  needs_you: { label: "Needs you", mark: "!" },
  fail: { label: "Failed", mark: "✕" },
  waiting: { label: "Waiting", mark: "" },
  running: { label: "Running", mark: "" },
  skipped: { label: "Skipped", mark: "–" },
};

export function statusMeta(status) {
  return STATUS_META[status] ?? STATUS_META.waiting;
}

/** "41 passed · 3 need you · 0 failed" (+ skipped, + still to go). */
export function summaryLine(summary) {
  const parts = [
    `${summary.passed} passed`,
    `${summary.needs_you} ${summary.needs_you === 1 ? "needs" : "need"} you`,
    `${summary.failed} failed`,
  ];
  if (summary.skipped) parts.push(`${summary.skipped} skipped`);
  if (summary.pending) parts.push(`${summary.pending} to go`);
  return parts.join(" · ");
}

/** Share of rows that have an outcome (0..1), for the progress bar. */
export function progress(run) {
  if (!run || run.rows.length === 0) return 0;
  const done = run.rows.filter((r) => r.status !== "waiting" && r.status !== "running").length;
  return run.state === "finished" ? 1 : done / run.rows.length;
}

/**
 * One group's header: the summary dot and "7/8" (passed of all rows in the group).
 * The dot: red if any failed; spinning while any is waiting or running; amber if any needs you;
 * green when all passed; grey otherwise (everything skipped).
 */
export function groupSummary(rows) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  const passed = count("pass");
  const failed = count("fail");
  const needsYou = count("needs_you");
  const pending = count("waiting") + count("running");
  let dot = "skipped";
  if (failed) dot = "fail";
  else if (pending) dot = "running";
  else if (needsYou) dot = "needs_you";
  else if (passed === rows.length && rows.length) dot = "pass";
  return { total: rows.length, passed, failed, needsYou, pending, dot, count: `${passed}/${rows.length}` };
}

/** A group folds itself when all its rows pass, and opens when one fails (or needs you). */
export function autoOpen(rows) {
  if (rows.some((r) => r.status === "fail")) return true;
  return !(rows.length > 0 && rows.every((r) => r.status === "pass"));
}

/**
 * Whether a group is open, remembering the person's own choice until the automatic state
 * changes (so a group they folded opens again when a row in it fails).
 * `ui` is a plain object kept between renders: { [groupId]: { auto, user } }.
 */
export function groupOpen(ui, groupId, auto) {
  const previous = ui[groupId];
  if (!previous || previous.auto !== auto) {
    ui[groupId] = { auto, user: null };
    return auto;
  }
  return previous.user ?? auto;
}

/** Records a click on a group's header. */
export function toggleGroup(ui, groupId, currentlyOpen) {
  const previous = ui[groupId] ?? { auto: currentlyOpen, user: null };
  ui[groupId] = { ...previous, user: !currentlyOpen };
}

/**
 * The handler for one rendered group's `toggle` events: records each fold or unfold as the
 * person's choice. It ignores the event the browser fires for the state the group was drawn in,
 * and follows the group's state itself, so folding and unfolding again before the next render
 * is recorded as well.
 * @returns {(nowOpen: boolean) => void}
 */
export function foldTracker(ui, groupId, drawnOpen) {
  let shown = drawnOpen;
  return (nowOpen) => {
    if (nowOpen === shown) return;
    toggleGroup(ui, groupId, shown);
    shown = nowOpen;
  };
}

/**
 * What the check's controls show. `signature` decides when they are rebuilt: it holds only what
 * changes the set of controls or their state (the mode, whether a run is going, which run is
 * shown, and each run's id and state), never a running run's live summary, so the controls are
 * not rebuilt every second during a run. The option labels (which carry the summary) are updated
 * in place instead. Every option's value is its run's id.
 * @param {{ env: string, running: boolean, retryAvailable: boolean, hasReport: boolean, viewingId: string | null, currentId: string | null,
 *           history: Array<{ id: string, state: string, started_at: string, summary: any }> }} c
 * @param {(iso: string) => string} [formatTime]
 */
export function checkControlsView(c, formatTime = (iso) => iso) {
  const shownId = c.viewingId ?? c.currentId ?? c.history[0]?.id ?? null;
  return {
    signature: JSON.stringify([c.env, c.running, c.retryAvailable, c.hasReport, c.viewingId, c.currentId, c.history.map((run) => [run.id, run.state])]),
    run: { text: c.running ? "Sandbox check running…" : "Run full sandbox check", disabled: c.running },
    retries: { disabled: !c.retryAvailable || c.running },
    copy: { disabled: !c.hasReport },
    options: c.history.map((run, i) => ({
      value: run.id,
      selected: run.id === shownId,
      label: `${i === 0 ? "Latest" : "Earlier"}: ${formatTime(run.started_at)} · ${run.state === "running" ? "running" : summaryLine(run.summary)}`,
    })),
  };
}

/** The run dropdown's choice: null follows the latest run (the one the server calls current). */
export function pickRun(id, currentId) {
  return !id || id === currentId ? null : id;
}

/**
 * Whether to rebuild a part of the page that someone may be using:
 * - "update": nothing it is built from changed, so only update text in place;
 * - "defer": wait, because a press is in progress there (a pointer or key is down) or one of its
 *   form fields has focus (an open dropdown, a tick box); rebuilding would lose the press;
 * - "rebuild": safe to rebuild now.
 * @param {{ same: boolean, built: boolean, pressing: boolean, focused: boolean }} input
 */
export function rebuildAction({ same, built, pressing, focused }) {
  if (built && same) return "update";
  if (built && (pressing || focused)) return "defer";
  return "rebuild";
}

/** The groups of a run, in order, each with its rows and header. */
export function groupsOf(run) {
  return GROUPS.map((group) => {
    const rows = run.rows.filter((r) => r.group === group.id);
    return { ...group, rows, summary: groupSummary(rows), autoOpen: autoOpen(rows) };
  }).filter((g) => g.rows.length > 0);
}

/** Rows whose status differs from the run before (to compare before and after a TC release). */
export function changesSince(run, previous) {
  const out = {};
  if (!previous?.statuses) return out;
  for (const row of run.rows) {
    const before = previous.statuses[row.id];
    if (before && before !== row.status) out[row.id] = before;
  }
  return out;
}

/** "4 min 12 s" / "38 s". */
export function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} min ${total % 60} s` : `${total} s`;
}
