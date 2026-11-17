// The console page's state handling, tested at the module level: public/lib/ has no DOM, so
// Node imports it directly. Plus the page's static files: what is served, and the brand rules.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { CHECK_GROUPS, ROW_STATUSES, type CheckRow } from "../src/check/types.ts";
import { summaryLine as serverSummaryLine } from "../src/check/report.ts";
import { newCheckRun } from "../src/check/sandbox-check.ts";
import { loadConfig } from "../src/config.ts";
import { createConsoleServer } from "../src/server/console-server.ts";
import { Coverage } from "../src/server/coverage.ts";
import { LiveGuard } from "../src/server/live-guard.ts";
import { EventStore } from "../src/webhooks/store.ts";
import * as checkView from "../public/lib/check-view.js";
import { cardOrder, createInflight, createOutcome, editPatch, filterAccreditations, selectedJobTitle } from "../public/lib/ui-state.js";
import { closeServer, listenLocal, send } from "./helpers/http.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixtures: today's reference data (no trade lists), and what TC is adding within v1.
const TODAY = [
  { id: "a1", name: "Electrical licence", category: null, issuing_body: null, type: null, scope: null },
  { id: "a2", name: "Plumbing licence", category: null, issuing_body: null, type: null, scope: null },
  { id: "a3", name: "Working at heights", category: null, issuing_body: null, type: null, scope: null },
];
const WITH_TRADES = [
  { ...TODAY[0]!, trade_type_codes: ["ELECTRICAL", "SOLAR"] },
  { ...TODAY[1]!, trade_type_codes: ["PLUMBING"] },
  { ...TODAY[2]!, trade_type_codes: [] },
  { id: "a4", name: "Battery installer", category: null, issuing_body: null, type: null, scope: null, trade_type_codes: ["SOLAR"] },
];

describe("New job: accreditations filtered by the ticked trades", () => {
  it("shows them all, exactly as before, while TC does not send trade_type_codes", () => {
    const view = filterAccreditations({ accreditations: TODAY, tickedTrades: ["ELECTRICAL"] });
    assert.deepEqual(view.items.map((a: { id: string }) => a.id), ["a1", "a2", "a3"]);
    assert.equal(view.canFilter, false);
    assert.equal(view.filtering, false);
    assert.equal(view.hiddenCount, 0);
  });

  it("shows only those for the ticked trades (plus any not tied to a trade) once it does", () => {
    const view = filterAccreditations({ accreditations: WITH_TRADES, tickedTrades: ["PLUMBING"] });
    assert.deepEqual(view.items.map((a: { id: string }) => a.id), ["a2", "a3"]);
    assert.equal(view.canFilter, true);
    assert.equal(view.filtering, true);
    assert.equal(view.hiddenCount, 2);
    assert.deepEqual(filterAccreditations({ accreditations: WITH_TRADES, tickedTrades: ["SOLAR"] }).items.map((a: { id: string }) => a.id), ["a1", "a3", "a4"]);
  });

  it("shows all with no trade ticked, or with 'show all' on", () => {
    assert.equal(filterAccreditations({ accreditations: WITH_TRADES, tickedTrades: [] }).items.length, 4);
    const all = filterAccreditations({ accreditations: WITH_TRADES, tickedTrades: ["PLUMBING"], showAll: true });
    assert.equal(all.items.length, 4);
    assert.equal(all.filtering, false);
    assert.equal(all.canFilter, true);
  });

  it("never hides one that is already ticked", () => {
    const view = filterAccreditations({ accreditations: WITH_TRADES, tickedTrades: ["PLUMBING"], selectedIds: new Set(["a4"]) });
    assert.deepEqual(view.items.map((a: { id: string }) => a.id), ["a2", "a3", "a4"]);
  });

  it("copes with no reference data yet", () => {
    assert.deepEqual(filterAccreditations({ accreditations: null }).items, []);
  });
});

describe("New job: a replay looks different from a create", () => {
  it("is 'created' on 201, 'replayed' on 200 or replayed: true, and 'error' otherwise", () => {
    assert.equal(createOutcome({ ok: true, data: { id: "j" }, calls: [{ operation: "jobs.create", status: 201 }] }), "created");
    assert.equal(createOutcome({ ok: true, data: { id: "j", replayed: true }, calls: [] }), "replayed");
    assert.equal(createOutcome({ ok: true, data: { id: "j" }, calls: [{ operation: "jobs.create", status: 200 }] }), "replayed");
    assert.equal(createOutcome({ ok: false }), "error");
  });
});

describe("buttons: one request at a time", () => {
  it("refuses a second start while the first runs, and allows a new one after it finishes", () => {
    const inflight = createInflight();
    assert.equal(inflight.start("create"), true);
    assert.equal(inflight.start("create"), false, "a double-click does not send twice");
    assert.equal(inflight.isBusy("create"), true);
    assert.equal(inflight.start("note"), true, "other buttons are independent");
    inflight.finish("create");
    assert.equal(inflight.start("create"), true, "pressing Create again afterwards (the idempotency replay) is fine");
  });
});

describe("selected job: header and card order", () => {
  it("names the selected job and its status", () => {
    assert.equal(selectedJobTitle({ id: "j1", external_reference: "EX-1", status: "OPEN" }), "Selected job: EX-1 · OPEN");
    assert.equal(selectedJobTitle({ id: "j1", external_reference: null, status: "DRAFT" }), "Selected job: j1 · DRAFT");
    assert.equal(selectedJobTitle(null), "Selected job: none");
  });

  it("offers Cancel for a draft too, after Publish, with no Simulate", () => {
    assert.deepEqual(cardOrder({ status: "DRAFT" }), ["details", "edit", "note", "attachments", "publish", "cancel"]);
  });

  it("adds Simulate and Cancel past DRAFT, keeping Publish only while it shows its result", () => {
    assert.deepEqual(cardOrder({ status: "OPEN" }), ["details", "edit", "note", "attachments", "simulate", "cancel"]);
    assert.deepEqual(cardOrder({ status: "OPEN" }, { hasPublishResult: true }), ["details", "edit", "note", "attachments", "publish", "simulate", "cancel"]);
    assert.deepEqual(cardOrder({ status: "PAID" }), ["details", "edit", "note", "attachments", "simulate", "cancel"]);
  });
});

describe("Edit card: what it sends", () => {
  const job = {
    title: "Battery install",
    description: "Existing solar",
    notes: null,
    schedule: { preferred_start_date: "2026-11-24", time_window: "MORNING" },
    price: { ex_gst_cents: 150_000 },
  };
  const unchanged = { title: "Battery install", description: "Existing solar", notes: "", preferred_start_date: "2026-11-24", time_window: "MORNING", price_dollars: "1500.00" };

  it("sends only what changed", () => {
    assert.deepEqual(editPatch(job, { ...unchanged, title: "Battery install (edited)" }), { patch: { title: "Battery install (edited)" } });
    assert.deepEqual(editPatch(job, { ...unchanged, price_dollars: "1600" }), { patch: { price: { ex_gst_cents: 160_000 } } });
  });

  it("says nothing changed only when nothing did", () => {
    assert.match((editPatch(job, unchanged) as { notice: string }).notice, /^Nothing changed, so nothing was sent/);
  });

  it("says the API cannot remove a price when the price is cleared, and sends nothing", () => {
    for (const values of [{ ...unchanged, price_dollars: "" }, { ...unchanged, price_dollars: "  ", title: "Battery install (edited)" }]) {
      const result = editPatch(job, values) as { notice?: string; patch?: unknown };
      assert.equal(result.patch, undefined);
      assert.match(result.notice!, /The API can change a price but not remove one, so nothing was sent/);
    }
    assert.deepEqual(editPatch({ ...job, price: { ex_gst_cents: null } }, { ...unchanged, price_dollars: "", title: "New" }), { patch: { title: "New" } }, "no price to remove");
  });

  it("refuses a price that is not a number", () => {
    assert.match((editPatch(job, { ...unchanged, price_dollars: "abc" }) as { notice: string }).notice, /not a number/);
  });
});

function rows(...statuses: CheckRow["status"][]): CheckRow[] {
  return statuses.map((status, i) => ({
    id: `r${i}`,
    group: "jobs",
    title: `row ${i}`,
    status,
    reason: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    exchanges: [],
    error: null,
    manual: false,
  }));
}

describe("sandbox check view", () => {
  it("has the server's groups, in the same order", () => {
    assert.deepEqual(checkView.GROUPS, CHECK_GROUPS.map((g) => ({ ...g })));
  });

  it("names every status for the dot's title and aria-label, with the right mark", () => {
    for (const status of ROW_STATUSES) {
      const meta = checkView.statusMeta(status);
      assert.ok(meta.label.length > 2, status);
    }
    assert.equal(checkView.statusMeta("pass").mark, "✓");
    assert.equal(checkView.statusMeta("needs_you").mark, "!");
    assert.equal(checkView.statusMeta("fail").mark, "✕");
    assert.equal(checkView.statusMeta("waiting").mark, "");
    assert.equal(checkView.statusMeta("running").label, "Running");
  });

  it("writes the one-line result exactly as the plain-text report does", () => {
    for (const summary of [
      { total: 44, passed: 41, needs_you: 3, failed: 0, skipped: 0, pending: 0 },
      { total: 9, passed: 4, needs_you: 1, failed: 2, skipped: 1, pending: 1 },
    ]) {
      assert.equal(checkView.summaryLine(summary), serverSummaryLine(summary));
    }
    assert.equal(checkView.summaryLine({ total: 44, passed: 41, needs_you: 3, failed: 0, skipped: 0, pending: 0 }), "41 passed · 3 need you · 0 failed");
  });

  it("gives each group a summary dot and a count", () => {
    assert.deepEqual(checkView.groupSummary(rows("pass", "pass", "fail")).dot, "fail");
    assert.equal(checkView.groupSummary(rows("pass", "pass", "fail")).count, "2/3");
    assert.equal(checkView.groupSummary(rows("pass", "running")).dot, "running");
    assert.equal(checkView.groupSummary(rows("pass", "needs_you")).dot, "needs_you");
    assert.equal(checkView.groupSummary(rows("pass", "pass")).dot, "pass");
    assert.equal(checkView.groupSummary(rows("skipped")).dot, "skipped");
  });

  it("folds a group when all its rows pass, and opens it when one fails or needs you", () => {
    assert.equal(checkView.autoOpen(rows("pass", "pass")), false);
    assert.equal(checkView.autoOpen(rows("pass", "fail")), true);
    assert.equal(checkView.autoOpen(rows("pass", "needs_you")), true);
    assert.equal(checkView.autoOpen(rows("waiting", "waiting")), true);
  });

  it("keeps the person's own fold until the group's state changes, then follows it again", () => {
    const ui: Record<string, { auto: boolean; user: boolean | null }> = {};
    assert.equal(checkView.groupOpen(ui, "jobs", true), true);
    checkView.toggleGroup(ui, "jobs", true); // they fold it while it runs
    assert.equal(checkView.groupOpen(ui, "jobs", true), false, "stays folded on the next render");
    assert.equal(checkView.groupOpen(ui, "jobs", false), false, "all passed: folds itself");
    checkView.toggleGroup(ui, "jobs", false); // they open it to look
    assert.equal(checkView.groupOpen(ui, "jobs", false), true);
    assert.equal(checkView.groupOpen(ui, "jobs", true), true, "a row failed: opens again whatever they chose");
  });

  it("records every fold and unfold through the group's toggle handler, ignoring the one for its drawn state", () => {
    const ui: Record<string, { auto: boolean; user: boolean | null }> = {};
    const open = checkView.groupOpen(ui, "jobs", true);
    const onToggle = checkView.foldTracker(ui, "jobs", open);
    onToggle(true); // the browser's toggle event for drawing it open
    assert.equal(ui.jobs!.user, null, "drawing it is not a choice");
    onToggle(false);
    assert.equal(checkView.groupOpen(ui, "jobs", true), false, "folded");
    onToggle(true); // and opened again, before any re-render
    assert.equal(checkView.groupOpen(ui, "jobs", true), true, "opened again: the second click counts too");
  });

  it("measures progress, lists groups in order, and spots rows that changed since the run before", () => {
    const run = newCheckRun({ source: "console", baseUrl: "https://tc.example.test", apiKey: null, testRetries: false });
    assert.equal(checkView.progress(run), run.rows.filter((r) => r.manual).length / run.rows.length, "manual items already have an outcome");
    assert.deepEqual(checkView.groupsOf(run).map((g: { id: string }) => g.id), CHECK_GROUPS.map((g) => g.id));
    run.rows[0]!.status = "fail";
    assert.deepEqual(checkView.changesSince(run, { statuses: { [run.rows[0]!.id]: "pass", [run.rows[1]!.id]: "waiting" } }), { [run.rows[0]!.id]: "pass" });
    assert.deepEqual(checkView.changesSince(run, null), {});
    run.state = "finished";
    assert.equal(checkView.progress(run), 1);
    assert.equal(checkView.duration(252_000), "4 min 12 s");
  });
});

describe("sandbox check controls: the run dropdown and lost clicks", () => {
  const summary = (passed: number) => ({ total: 50, passed, needs_you: 3, failed: 0, skipped: 0, pending: 47 - passed });
  const base = { env: "sandbox", running: true, retryAvailable: true, hasReport: true, viewingId: null, currentId: "run-3" };
  const history = (passed: number, state = "running") => [
    { id: "run-3", state, started_at: "2026-11-17T03:00:00.000Z", summary: summary(passed) },
    { id: "run-2", state: "finished", started_at: "2026-11-17T02:00:00.000Z", summary: summary(47) },
  ];

  it("gives every option its run's id, the newest first, and selects the run shown", () => {
    const view = checkView.checkControlsView({ ...base, history: history(10) });
    assert.deepEqual(view.options.map((o: { value: string }) => o.value), ["run-3", "run-2"], "no blank value for the latest");
    assert.deepEqual(view.options.map((o: { selected: boolean }) => o.selected), [true, false]);
    assert.match(view.options[0]!.label, /^Latest: .* · running$/);
    assert.match(view.options[1]!.label, /^Earlier: .* · 47 passed/);
    const earlier = checkView.checkControlsView({ ...base, viewingId: "run-2", history: history(10) });
    assert.deepEqual(earlier.options.map((o: { selected: boolean }) => o.selected), [false, true]);
  });

  it("follows the latest run when its option is picked, and opens any other by id", () => {
    assert.equal(checkView.pickRun("run-3", "run-3"), null);
    assert.equal(checkView.pickRun("run-2", "run-3"), "run-2");
    assert.equal(checkView.pickRun("", "run-3"), null);
  });

  it("does not rebuild the controls as a running run's summary changes, only when a run's id or state does", () => {
    const at = (h: ReturnType<typeof history>, extra = {}) => checkView.checkControlsView({ ...base, history: h, ...extra }).signature;
    const first = at(history(10));
    assert.equal(at(history(11)), first, "one more row passed: the same controls");
    const finished = history(47, "finished");
    finished[0]!.summary = summary(47);
    assert.notEqual(at(finished, { running: false }), first, "the run finished");
    assert.notEqual(at([{ id: "run-4", state: "running", started_at: "2026-11-17T04:00:00.000Z", summary: summary(0) }, ...history(10)]), first, "a new run");
    assert.notEqual(at(history(10), { viewingId: "run-2" }), first, "another run shown");
    assert.notEqual(at(history(10), { env: "live" }), first);
  });

  it("never rebuilds under a press or a focused dropdown: it waits, and updates in place when nothing changed", () => {
    assert.equal(checkView.rebuildAction({ same: true, built: true, pressing: true, focused: true }), "update");
    assert.equal(checkView.rebuildAction({ same: false, built: true, pressing: true, focused: false }), "defer");
    assert.equal(checkView.rebuildAction({ same: false, built: true, pressing: false, focused: true }), "defer");
    assert.equal(checkView.rebuildAction({ same: false, built: true, pressing: false, focused: false }), "rebuild");
    assert.equal(checkView.rebuildAction({ same: false, built: false, pressing: true, focused: true }), "rebuild", "nothing there yet to lose");
  });

  it("is wired into the page: the controls, the rows and the dropdown use these helpers", async () => {
    const app = await readFile(path.join(root, "public", "app.js"), "utf8");
    const body = (name: string) => {
      const start = app.indexOf(`function ${name}(`);
      assert.ok(start >= 0, name);
      return app.slice(start, app.indexOf("\n}\n", start));
    };
    const controls = body("renderCheckControls");
    assert.match(controls, /checkControlsView\(/);
    assert.match(controls, /rebuildAction\(\{/);
    assert.match(controls, /pressing: Boolean\(checkControlsPress\?\.pressing\)/);
    assert.match(controls, /value: o\.value/);
    assert.doesNotMatch(controls, /c\.history\]/, "the live history is not in the signature");
    const view = body("renderCheck");
    assert.match(view, /rebuildAction\(\{[^}]*pressing: Boolean\(checkViewPress\?\.pressing\)/);
    assert.match(view, /foldTracker\(c\.groupUi, group\.id, open\)/);
    assert.match(body("viewRun"), /pickRun\(value, state\.check\.currentId\)/);
    assert.match(body("pollCheck"), /c\.currentId = current\.data\.run\?\.id/);
    assert.match(body("start"), /wireCheckTab\(\)/);
    assert.match(app, /const edit = editPatch\(job, values\)/, "the Edit card uses editPatch");
  });
});

describe("console page: static files and brand", () => {
  let server: Server;
  let port: number;
  before(async () => {
    const config = loadConfig({ TC_BASE_URL: "https://tc.example.test", DATA_DIR: path.join(root, "test", ".no-data") });
    server = createConsoleServer({
      config,
      guard: new LiveGuard({ liveAvailable: false }),
      store: {} as EventStore,
      coverage: {} as Coverage,
      token: "t".repeat(32),
      publicDir: path.join(root, "public"),
    });
    port = await listenLocal(server);
  });
  after(async () => {
    await closeServer(server);
  });

  it("serves every module app.js imports, the brand files, and nothing else new", async () => {
    const app = await readFile(path.join(root, "public", "app.js"), "utf8");
    const imports = [...app.matchAll(/from "\.\/([^"]+)"/g)].map((m) => `/${m[1]}`);
    assert.deepEqual(imports.sort(), ["/lib/check-view.js", "/lib/ui-state.js"]);
    for (const [file, type] of [
      ["/app.js", /javascript/],
      ["/lib/ui-state.js", /javascript/],
      ["/lib/check-view.js", /javascript/],
      ["/brand/brand.css", /text\/css/],
      ["/brand/icon.svg", /image\/svg\+xml/],
    ] as const) {
      const res = await send(port, { path: file });
      assert.equal(res.status, 200, file);
      assert.match(String(res.headers["content-type"]), type, file);
      assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/, file);
    }
    for (const file of ["/lib/", "/lib/../app.js", "/brand/", "/brand/other.svg", "/public/app.js"]) {
      assert.equal((await send(port, { path: file })).status, 404, file);
    }
  });

  it("is titled Trade Connector API Console, with the logo and brand.css", async () => {
    const page = (await send(port, { path: "/" })).text;
    assert.match(page, /<title>Trade Connector API Console<\/title>/);
    assert.match(page, /<script type="module" src="\/app\.js"><\/script>/);
    assert.ok(page.indexOf("/brand/brand.css") < page.indexOf("/styles.css"), "brand variables load first");
    assert.match(page, /<img src="\/brand\/icon\.svg"/);
  });

  it("keeps every colour in brand.css: styles.css uses variables only", async () => {
    const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");
    assert.doesNotMatch(styles.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const brand = await readFile(path.join(root, "public", "brand", "brand.css"), "utf8");
    assert.match(brand, /--brand: #1d9d63;/);
    for (const name of styles.matchAll(/var\((--[a-z-]+)\)/g)) {
      const defined = brand.includes(`${name[1]}:`) || styles.includes(`${name[1]}:`);
      assert.ok(defined, `${name[1]} is not defined`);
    }
  });

  it("keeps the brand out of the reusable client and webhook code", async () => {
    const { readdir } = await import("node:fs/promises");
    for (const dir of ["src/tc", "src/webhooks"]) {
      for (const file of await readdir(path.join(root, dir))) {
        const text = await readFile(path.join(root, dir, file), "utf8");
        assert.doesNotMatch(text, /brand|icon\.svg|#1d9d63|API Console/i, `${dir}/${file}`);
      }
    }
  });
});
