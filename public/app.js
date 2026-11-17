// Trade Connector API Console (browser side).
//
// Plain JavaScript modules, no framework and no build step. It talks only to this server's /api
// routes, which call Trade Connector server-side: API keys never reach the browser.
// Every piece of text from TC or from a webhook is inserted with textContent, never as HTML.
// The pure logic lives in lib/ (tested in Node); this file is the DOM around it.

import { cardOrder, createInflight, createOutcome, editPatch, filterAccreditations, selectedJobTitle } from "./lib/ui-state.js";
import { changesSince, checkControlsView, duration, foldTracker, groupOpen, groupsOf, pickRun, progress, rebuildAction, statusMeta, summaryLine } from "./lib/check-view.js";

// ---------------------------------------------------------------------------------------------
// Constants (mirroring TC's rules; the server and TC enforce them, these only guide the UI)
// ---------------------------------------------------------------------------------------------

const STATUSES = ["DRAFT", "OPEN", "OFFERED", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PENDING_CUSTOMER_SIG", "PAID", "CANCELLED", "DISPUTED"];
const EDITABLE = ["DRAFT", "OPEN"];
const NOT_CANCELLABLE = ["WORK_COMPLETE", "PAID", "CANCELLED", "DISPUTED"];
// TC does not refuse these yet, but the work is done: cancelling now would cancel finished work for no fee.
// The console refuses it in live mode and only warns in sandbox (where it is free and harmless).
const DO_NOT_CANCEL = ["PENDING_CUSTOMER_SIG"];
const NO_ATTACHMENTS = ["CANCELLED", "PAID"];
const LIFECYCLE = ["DRAFT", "OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID"];
const SIM_TARGETS = ["OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID", "CANCELLED"];
const SIM_LOCKED = ["CANCELLED", "PAID", "DISPUTED"];
const EVENT_TYPES = ["job.created", "job.status_changed", "job.assigned", "job.scheduled", "job.rescheduled", "job.completed", "job.evidence_ready", "job.price_changed", "job.cancelled", "webhook.test"];
const CATEGORIES = ["SITE_PHOTO", "SPEC_SHEET", "PLAN", "PERMIT", "CONTRACT", "INVOICE", "COMPLIANCE", "OTHER"];
const CONTENT_TYPES = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", webp: "image/webp" };
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const FLASH_MS = 1400;

const state = {
  token: null,
  env: "sandbox",
  status: null,
  ref: { jobTypes: null, tradeTypes: null, accreditations: null, loaded: false, loading: null },
  tradeOrder: [],
  accSelected: new Set(),
  accShowAll: false,
  jobs: [],
  jobsCursor: null,
  job: null,
  /** Results kept by the card that produced them: `${jobId}:${card}` → { label, r?, render?, notice? }. */
  cardResults: {},
  /** A one-line summary for the top of the job panel. */
  lastAction: null,
  events: [],
  lastSeq: 0,
  installs: [],
  installsCursor: null,
  check: { run: null, report: null, previous: null, running: false, retryAvailable: false, history: [], currentId: null, viewingId: null, groupUi: {}, openRows: new Set(), lastPoll: 0, groupsEl: null, groupsSignature: "" },
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);

/** Creates an element. attrs: class, text, on<event>, or any attribute/property. Null children are skipped. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    // The page's CSP refuses style attributes; CSSOM properties are fine.
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  return add(el, ...children);
}

/**
 * Appends children, skipping null, undefined and false. (Element.append(null) inserts the text
 * "null": that is where the stray "null" beside "Price ex GST" in the Edit card came from.)
 */
function add(parent, ...children) {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function when(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function money(cents) {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "-";
}

function statusBadge(status) {
  return h("span", { class: `badge status-${status}`, text: status ?? "?" });
}

/** env is "sandbox" or "live". */
function envBadge(env) {
  return env === "live" ? h("span", { class: "badge live", text: "LIVE" }) : h("span", { class: "badge sandbox", text: "sandbox" });
}

function pre(value) {
  return h("pre", { text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
}

function dl(rows, className = "summary") {
  const list = h("dl", { class: className });
  for (const [label, value] of rows) {
    if (value === undefined) continue;
    list.append(h("dt", { text: label }), h("dd", {}, value instanceof Node ? value : String(value ?? "-")));
  }
  return list;
}

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/** A status dot: coloured circle, tiny white mark, and its status in words for hover and screen readers. */
function dot(status, { small = false, context = "" } = {}) {
  const meta = statusMeta(status);
  const label = context ? `${context}: ${meta.label}` : meta.label;
  return h("span", { class: `dot ${status}${small ? " small" : ""}`, role: "img", "aria-label": label, title: label, text: meta.mark });
}

// ---------------------------------------------------------------------------------------------
// Button feedback: pressed (CSS), busy while the request runs, then a brief success or fail flash.
// A button's request is never sent twice: a click while it runs is ignored.
// ---------------------------------------------------------------------------------------------

const inflight = createInflight();
const flashes = new Map();

function buttonsFor(key) {
  return [...document.querySelectorAll("[data-action-key]")].filter((b) => b.dataset.actionKey === key);
}

function lockedButtons(lock) {
  return [...document.querySelectorAll("[data-lock-key]")].filter((b) => b.dataset.lockKey === lock);
}

/** Marks a button as belonging to an action, so busy and flash states survive a re-render. */
function actionable(button, key, lock = key) {
  button.dataset.actionKey = key;
  button.dataset.lockKey = lock;
  if (inflight.isBusy(lock)) {
    // Its group's request is running (this button was re-rendered meanwhile): keep it disabled.
    button.dataset.wasDisabled = button.disabled ? "1" : "";
    button.disabled = true;
  }
  if (inflight.isBusy(`visual:${key}`)) {
    button.classList.add("busy");
    button.setAttribute("aria-busy", "true");
  }
  const flash = flashes.get(key);
  if (flash && flash.until > Date.now()) button.classList.add(`flash-${flash.kind}`);
  return button;
}

function setBusy(key, lock, busy) {
  for (const button of lockedButtons(lock)) {
    if (busy) {
      button.dataset.wasDisabled = button.disabled ? "1" : "";
      button.disabled = true;
    } else {
      button.disabled = button.dataset.wasDisabled === "1";
      delete button.dataset.wasDisabled;
    }
  }
  for (const button of buttonsFor(key)) {
    button.classList.toggle("busy", busy);
    if (busy) button.setAttribute("aria-busy", "true");
    else button.removeAttribute("aria-busy");
  }
}

function flash(key, kind) {
  const until = Date.now() + FLASH_MS;
  flashes.set(key, { kind, until });
  for (const button of buttonsFor(key)) {
    button.classList.remove("flash-ok", "flash-fail");
    button.classList.add(`flash-${kind}`);
  }
  setTimeout(() => {
    if (flashes.get(key)?.until !== until) return;
    flashes.delete(key);
    for (const button of buttonsFor(key)) button.classList.remove(`flash-${kind}`);
  }, FLASH_MS);
}

/**
 * Runs one button's work with feedback. `work` returns false (or throws) for a failure.
 * `lock` groups buttons that must not run at the same time (e.g. the simulate buttons of a job).
 */
async function runAction(key, work, lock = key) {
  if (!inflight.start(lock)) return;
  inflight.start(`visual:${key}`);
  setBusy(key, lock, true);
  let ok = false;
  try {
    ok = (await work()) !== false;
  } catch (error) {
    console.error(error);
    ok = false;
  } finally {
    inflight.finish(lock);
    inflight.finish(`visual:${key}`);
    setBusy(key, lock, false);
    flash(key, ok ? "ok" : "fail");
  }
}

/** A button that runs `work` with feedback. */
function actionButton({ key, lock, text, onRun, ...attrs }) {
  const button = h("button", { type: "button", ...attrs, text });
  actionable(button, key, lock ?? key);
  button.addEventListener("click", () => runAction(key, onRun, lock ?? key));
  return button;
}

/** Wires a static button (by id) to run `work` with feedback. */
function bindButton(id, work) {
  const button = $(`#${id}`);
  actionable(button, id);
  button.addEventListener("click", () => runAction(id, work));
}

/** Wires a static form: submitting (button or Enter) runs `work` with feedback on its submit button. */
function bindForm(formId, submitId, work) {
  const form = $(`#${formId}`);
  actionable($(`#${submitId}`), submitId);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    runAction(submitId, () => work(form));
  });
}

// ---------------------------------------------------------------------------------------------
// Talking to the console server
// ---------------------------------------------------------------------------------------------

function readToken() {
  const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    try { sessionStorage.setItem("tcConsoleToken", match[1]); } catch { /* storage may be blocked */ }
    // Take the token out of the address bar so it is not shown or kept in history.
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try { return sessionStorage.getItem("tcConsoleToken"); } catch { return null; }
}

/**
 * Calls the console API. For writes in live mode, pass opts.live = { action, target, summary }:
 * the user is asked to type LIVE, the server issues a one-time token for exactly this request,
 * and the request carries it. The server refuses live writes without one.
 */
async function api(method, path, body, opts = {}) {
  const headers = { "X-Console-Token": state.token || "", "X-Console-Environment": state.env };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (opts.live && state.env === "live") {
    const confirmation = await confirmLive(opts.live.action, opts.live.target || "", body, opts.live.summary);
    if (!confirmation) {
      return { ok: false, cancelled: true, status: 0, error: { source: "console", code: "NOT_CONFIRMED", message: "Not confirmed. Nothing was sent to Trade Connector." }, calls: [] };
    }
    headers["X-Live-Confirmation"] = confirmation;
  }

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, error: { source: "console", code: "CONSOLE_UNREACHABLE", message: "The console server is not answering. Is npm start still running?" }, calls: [] };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 401 && json?.error?.code === "CONSOLE_TOKEN_REQUIRED") showTokenMissing();
  if (json?.error?.code === "ENVIRONMENT_CHANGED") {
    await loadStatus();
    clearJobs();
  }
  return { ok: res.ok, status: res.status, data: json?.data, error: json?.error, calls: json?.calls || [] };
}

async function confirmLive(action, target, body, summary) {
  const typed = await askLive(summary);
  if (typed !== "LIVE") return null;
  const r = await api("POST", "/api/live/confirm", { action, target, body, typed });
  if (!r.ok) {
    alert(`Could not confirm: ${r.error?.message ?? r.status}`);
    return null;
  }
  return r.data.token;
}

/** Shows the LIVE dialog; resolves with what was typed, or null if cancelled. */
function askLive(text) {
  const dialog = $("#live-dialog");
  const input = $("#live-dialog-input");
  const confirmButton = $("#live-dialog-confirm");
  $("#live-dialog-text").textContent = text;
  input.value = "";
  confirmButton.disabled = true;
  dialog.returnValue = "";
  input.oninput = () => { confirmButton.disabled = input.value !== "LIVE"; };
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm" ? input.value : null), { once: true });
    dialog.showModal();
    input.focus();
  });
}

function showTokenMissing() {
  $("#token-missing").hidden = false;
}

// ---------------------------------------------------------------------------------------------
// Showing results and errors (every TC error with its code, message, details and request_id)
// ---------------------------------------------------------------------------------------------

function callsList(calls) {
  if (!calls || calls.length === 0) return null;
  return h("ul", { class: "calls" }, calls.map((c) =>
    h("li", {
      text: `${c.method} ${c.path} → ${c.status || "no response"}${c.error_code ? " " + c.error_code : ""} · ${c.duration_ms} ms${c.request_id ? " · request_id " + c.request_id : ""}`,
    })));
}

function errorBox(r) {
  const e = r.error || { code: `HTTP_${r.status}`, message: "No error details in the response." };
  if (r.cancelled) return h("div", { class: "result notice" }, e.message);
  return h("div", { class: "result error", role: "alert" },
    h("strong", { text: e.source === "tc" ? "Trade Connector error" : "Console error" }),
    dl([
      ["error.code", e.code],
      ["message", e.message],
      ["HTTP status", e.status ?? r.status],
      ["request_id", e.request_id ?? (e.source === "tc" ? "-" : undefined)],
      ["details", e.details ? pre(e.details) : undefined],
      ["what to do", e.hint ?? undefined],
    ], ""),
    callsList(r.calls));
}

function resultBox(r, render) {
  if (!r.ok) return errorBox(r);
  return h("div", { class: "result ok" }, render ? render(r.data) : "Done.", callsList(r.calls));
}

function noticeBox(text) {
  return h("div", { class: "result notice", role: "status", text });
}

function show(container, r, render) {
  container.replaceChildren(resultBox(r, render));
}

// ---------------------------------------------------------------------------------------------
// Header: environment, key prefix, base URL, health, webhook URLs
// ---------------------------------------------------------------------------------------------

async function loadStatus() {
  const r = await api("GET", "/api/status");
  if (!r.ok) return;
  const s = r.data;
  state.status = s;
  state.env = s.environment;
  const live = s.environment === "live";
  document.body.classList.toggle("live", live);
  $("#live-banner").hidden = !live;
  $("#env-sandbox").classList.toggle("active", !live);
  $("#env-live").classList.toggle("active", live);
  $("#env-live").disabled = !s.live_available && !live;
  $("#env-live").title = s.live_available ? "Switch to live mode (you will type LIVE)" : s.live_unavailable_reason;
  $("#live-reason").textContent = s.live_available ? "" : `Live mode is off: ${s.live_unavailable_reason}`;
  const keys = live ? s.keys.live : s.keys.sandbox;
  $("#fact-key").textContent = keys.api_key ?? "not set";
  $("#fact-base").textContent = s.base_url;
  const base = s.webhooks.public_base_url;
  $("#wh-sandbox").textContent = base ? s.webhooks.sandbox : `https://<your-tunnel>${s.webhooks.sandbox}`;
  $("#wh-live").textContent = base ? s.webhooks.live : `https://<your-tunnel>${s.webhooks.live}`;
  $("#wh-sandbox-secret").replaceChildren(secretBadge(s.keys.sandbox.webhook_secret_configured, "TC_TEST_WEBHOOK_SECRET"));
  $("#wh-live-secret").replaceChildren(secretBadge(s.keys.live.webhook_secret_configured, "TC_LIVE_WEBHOOK_SECRET"));
  $("#tunnel-cmd").textContent = `cloudflared tunnel --url ${s.webhooks.local_url}`;
  renderInstallsVisibility();
  renderDetail();
  renderCheckControls();
}

function secretBadge(configured, name) {
  return configured
    ? h("span", { class: "badge ok", text: "secret set" })
    : h("span", { class: "badge warn", text: `${name} not set` });
}

async function switchEnvironment(target) {
  if (target === state.env) return true;
  if (target === "live") {
    const typed = await askLive("Switch the console to LIVE mode? Live jobs reach real installers, and a cancellation fee may apply under your company's cancellation terms with Trade Connector.");
    if (typed !== "LIVE") return false;
    const r = await api("POST", "/api/environment", { environment: "live", typed });
    if (!r.ok) {
      alert(r.error?.message ?? "Could not switch");
      return false;
    }
  } else {
    await api("POST", "/api/environment", { environment: "sandbox" });
  }
  await loadStatus();
  clearJobs();
  await listJobs(false);
  return true;
}

async function checkHealth() {
  const out = $("#fact-health");
  out.textContent = "checking…";
  const r = await api("GET", "/api/health");
  out.replaceChildren(r.ok
    ? h("span", { class: "badge ok", text: `${r.data.status} (${r.data.version})` })
    : h("span", { class: "badge bad", text: r.error?.code ?? `HTTP ${r.status}`, title: r.error?.message ?? "" }));
  return r.ok;
}

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

function showTab(name) {
  for (const button of document.querySelectorAll(".tabs button")) button.classList.toggle("active", button.dataset.tab === name);
  for (const section of document.querySelectorAll("main .tab")) section.hidden = section.id !== `tab-${name}`;
  if (name === "coverage") loadCoverage();
  if (name === "installs") renderInstallsVisibility();
  if (name === "reference" && !state.ref.loaded) ensureReference();
  if (name === "check") pollCheck(true);
}

// ---------------------------------------------------------------------------------------------
// Jobs list (loads by itself when the console opens)
// ---------------------------------------------------------------------------------------------

function clearJobs() {
  state.jobs = [];
  state.jobsCursor = null;
  state.job = null;
  state.cardResults = {};
  state.lastAction = null;
  renderJobs();
  renderDetail();
}

async function listJobs(more) {
  const form = new FormData($("#job-filter"));
  const q = new URLSearchParams();
  if (form.get("status")) q.set("status", form.get("status"));
  const since = form.get("updated_since");
  if (since) q.set("updated_since", new Date(since).toISOString());
  q.set("limit", form.get("limit"));
  if (more && state.jobsCursor) q.set("cursor", state.jobsCursor);
  $("#list-result").replaceChildren(h("span", { class: "hint", text: "Loading…" }));
  const r = await api("GET", `/api/jobs?${q}`);
  if (!r.ok) {
    show($("#list-result"), r);
    if (!more) {
      state.jobs = [];
      renderJobs("Could not list jobs: see the error below.");
    }
    return false;
  }
  $("#list-result").replaceChildren(h("span", { class: "hint", text: `${r.data.data.length} jobs${r.data.has_more ? ", more available" : ""}` }));
  state.jobs = more ? state.jobs.concat(r.data.data) : r.data.data;
  state.jobsCursor = r.data.has_more ? r.data.next_cursor : null;
  renderJobs();
  return true;
}

function renderJobs(emptyText = "No jobs listed.") {
  const body = $("#jobs-table tbody");
  body.replaceChildren();
  if (state.jobs.length === 0) {
    body.append(h("tr", {}, h("td", { colspan: "4", class: "muted", text: emptyText })));
  }
  for (const job of state.jobs) {
    body.append(h("tr", { class: state.job?.id === job.id ? "selected" : "", tabindex: "0",
      onclick: () => openJob(job.id),
      onkeydown: (e) => { if (e.key === "Enter") openJob(job.id); } },
    h("td", { class: "mono", text: job.external_reference ?? "-" }),
    h("td", { text: job.title }),
    h("td", {}, statusBadge(job.status)),
    h("td", { text: when(job.updated_at) })));
  }
  $("#load-more").hidden = !state.jobsCursor;
}

async function openJob(id, resultBoxEl = null) {
  if (resultBoxEl) resultBoxEl.replaceChildren();
  const r = await api("GET", `/api/jobs/${encodeURIComponent(id)}`);
  if (!r.ok) {
    if (resultBoxEl) resultBoxEl.replaceChildren(errorBox(r));
    else {
      state.lastAction = { label: `Open ${id}`, ok: false, code: r.error?.code };
      renderDetail();
    }
    return false;
  }
  if (state.job?.id !== r.data.id) {
    state.cardResults = {};
    state.lastAction = null;
  }
  setJob(r.data);
  renderDetail();
  return true;
}

function setJob(job) {
  state.job = job;
  const i = state.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) state.jobs[i] = job;
  else state.jobs.unshift(job);
  renderJobs();
}

// ---------------------------------------------------------------------------------------------
// New job (reference data loads by itself when the form opens)
// ---------------------------------------------------------------------------------------------

function freshIdentifiers() {
  const form = $("#create-form");
  form.elements.external_reference.value = `EX-${today()}-${uuid().slice(0, 8)}`;
  form.elements.idempotency_key.value = uuid();
  $("#create-result").replaceChildren(noticeBox("New reference and Idempotency-Key filled in: the next Create makes a new job."));
}

function fillCreateDefaults() {
  const f = $("#create-form").elements;
  f.title.value = "Example battery install";
  f.description.value = "Battery and gateway on an existing 6.6 kW solar system. Example data only.";
  f.address.value = "12 Example St";
  f.suburb.value = "Exampleton";
  f.state.value = "NSW";
  f.postcode.value = "2000";
  f.access_instructions.value = "Side gate. Example data only.";
  f.preferred_start_date.value = today(7);
  f.time_window.value = "MORNING";
  f.end_customer_name.value = "Alex Example";
  // Numbers from ACMA's list reserved for fiction: they never reach a real person.
  f.end_customer_phone.value = "0491 570 006";
  f.end_customer_email.value = "alex@example.com";
  f.contact_name.value = "Alex Example";
  f.contact_phone.value = "0491 570 156";
  f.price_dollars.value = "1500.00";
  f.external_reference.value = `EX-${today()}-${uuid().slice(0, 8)}`;
  f.idempotency_key.value = uuid();
}

function buildCreateBody() {
  const f = $("#create-form").elements;
  const v = (name) => f[name].value.trim();
  const job = {
    title: v("title"),
    description: v("description"),
    site: { address: v("address"), suburb: v("suburb"), state: v("state"), postcode: v("postcode") },
    urgency: v("urgency"),
    publish: f.publish.value === "true",
  };
  if (v("unit")) job.site.unit = v("unit");
  if (v("access_instructions")) job.site.access_instructions = v("access_instructions");
  if (v("job_type_id")) job.job_type_id = Number(v("job_type_id"));
  if (state.tradeOrder.length) job.trade_codes = [...state.tradeOrder];
  if (state.accSelected.size) job.accreditation_ids = [...state.accSelected];
  if (v("preferred_start_date") || v("time_window")) {
    job.schedule = {};
    if (v("preferred_start_date")) job.schedule.preferred_start_date = v("preferred_start_date");
    if (v("time_window")) job.schedule.time_window = v("time_window");
  }
  if (v("end_customer_name") || v("end_customer_email") || v("end_customer_phone")) {
    job.end_customer = {};
    if (v("end_customer_name")) job.end_customer.name = v("end_customer_name");
    if (v("end_customer_email")) job.end_customer.email = v("end_customer_email");
    if (v("end_customer_phone")) job.end_customer.phone = v("end_customer_phone");
  }
  if (v("contact_name")) {
    const contact = { name: v("contact_name"), role: v("contact_role") };
    if (v("contact_phone")) contact.phone = v("contact_phone");
    job.contacts = [contact];
  }
  if (v("price_dollars")) job.price = { ex_gst_cents: Math.round(Number(v("price_dollars")) * 100) };
  if (v("notes")) job.notes = v("notes");
  if (v("external_reference")) job.external_reference = v("external_reference");
  const body = { job };
  if (v("idempotency_key")) body.idempotency_key = v("idempotency_key");
  return body;
}

async function createJob() {
  const body = buildCreateBody();
  const where = body.job.publish ? "PUBLISHED to real installers" : "saved as a draft";
  const r = await api("POST", "/api/jobs", body, {
    live: { action: "create_job", summary: `Create the LIVE job “${body.job.title}”, ${where}.` },
  });
  const outcome = createOutcome(r);
  const out = $("#create-result");
  if (outcome === "error") {
    out.replaceChildren(errorBox(r));
    return false;
  }
  const job = r.data;
  const facts = dl([["id", job.id], ["external_reference", job.external_reference], ["status", statusBadge(job.status)]], "");
  out.replaceChildren(outcome === "replayed"
    ? h("div", { class: "result replayed", role: "status" },
      h("strong", { text: "Replayed: no new job created (HTTP 200)" }),
      h("p", { text: "TC returned the job first created with this Idempotency-Key. Press “Fresh reference and key” to make a new one." }),
      facts, callsList(r.calls))
    : h("div", { class: "result ok", role: "status" }, h("strong", { text: "Created (HTTP 201)" }), facts, callsList(r.calls)));
  if (state.job?.id !== job.id) state.cardResults = {};
  state.lastAction = { label: outcome === "replayed" ? "Create (replayed, no new job)" : "Create", ok: true };
  setJob(job);
  renderDetail();
  return true;
}

// ---------------------------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------------------------

/** Loads reference data once (shared by the New job form and the Reference tab). */
function ensureReference() {
  if (state.ref.loaded) return Promise.resolve(true);
  return loadReference();
}

function loadReference() {
  if (state.ref.loading) return state.ref.loading;
  $("#create-ref-result").replaceChildren(h("span", { class: "hint", text: "Loading reference data…" }));
  state.ref.loading = (async () => {
    const [jobTypes, tradeTypes, accreditations] = await Promise.all([
      api("GET", "/api/reference/job-types"),
      api("GET", "/api/reference/trade-types"),
      api("GET", "/api/reference/accreditations"),
    ]);
    const failed = [jobTypes, tradeTypes, accreditations].find((r) => !r.ok);
    if (failed) {
      $("#ref-result").replaceChildren(errorBox(failed));
      $("#create-ref-result").replaceChildren(errorBox(failed));
    } else {
      $("#ref-result").replaceChildren(resultBox({ ok: true, calls: [...jobTypes.calls, ...tradeTypes.calls, ...accreditations.calls] }, () => "Loaded."));
      $("#create-ref-result").replaceChildren();
    }
    if (jobTypes.ok) state.ref.jobTypes = jobTypes.data;
    if (tradeTypes.ok) state.ref.tradeTypes = tradeTypes.data;
    if (accreditations.ok) state.ref.accreditations = accreditations.data;
    state.ref.loaded = !failed;
    renderReference(failed);
    return !failed;
  })().finally(() => { state.ref.loading = null; });
  return state.ref.loading;
}

function table(columns, rows) {
  return h("table", {},
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { text: c.label })))),
    h("tbody", {}, rows.map((row) => h("tr", {}, columns.map((c) => h("td", { class: c.mono ? "mono" : "", text: Array.isArray(row[c.key]) ? row[c.key].join(", ") : (row[c.key] ?? "-") }))))));
}

function renderReference(failed) {
  const { jobTypes, tradeTypes, accreditations } = state.ref;
  if (jobTypes) {
    $("#ref-job-types").replaceChildren(table([{ key: "id", label: "id", mono: true }, { key: "name", label: "Name" }, { key: "service_category_id", label: "Category" }], jobTypes));
    const select = $("#create-form").elements.job_type_id;
    const chosen = select.value;
    select.replaceChildren(h("option", { value: "", text: "(none)" }), ...jobTypes.map((t) => h("option", { value: String(t.id), text: `${t.name} (#${t.id})` })));
    select.value = chosen;
  }
  if (tradeTypes) {
    $("#ref-trade-types").replaceChildren(table([{ key: "code", label: "code", mono: true }, { key: "name", label: "Name" }, { key: "category", label: "Category" }], tradeTypes));
    const box = $("#create-trades");
    box.className = "options";
    box.replaceChildren(...tradeTypes.map((t) => h("label", {},
      h("input", {
        type: "checkbox", value: t.code, checked: state.tradeOrder.includes(t.code),
        onchange: (e) => {
          state.tradeOrder = state.tradeOrder.filter((c) => c !== t.code);
          if (e.target.checked) state.tradeOrder.push(t.code);
          renderAccreditationPicker();
        },
      }), `${t.name} (${t.code})`)));
  } else if (failed) {
    $("#create-trades").textContent = "Not loaded (see the error above). Trades are optional.";
  }
  if (accreditations) {
    const hasTrades = accreditations.some((a) => Array.isArray(a.trade_type_codes));
    const columns = [{ key: "name", label: "Name" }, { key: "issuing_body", label: "Issuer" }];
    if (hasTrades) columns.push({ key: "trade_type_codes", label: "Trades", mono: true });
    columns.push({ key: "id", label: "id", mono: true });
    $("#ref-accreditations").replaceChildren(table(columns, accreditations));
    renderAccreditationPicker();
  } else if (failed) {
    $("#create-accreditations").textContent = "Not loaded (see the error above). Accreditations are optional.";
  }
}

/** Accreditations for the ticked trades, when TC lists trades per accreditation; otherwise all of them. */
function renderAccreditationPicker() {
  const accreditations = state.ref.accreditations;
  if (!accreditations) return;
  const view = filterAccreditations({ accreditations, tickedTrades: state.tradeOrder, showAll: state.accShowAll, selectedIds: state.accSelected });
  const box = $("#create-accreditations");
  box.className = "options";
  box.replaceChildren(...view.items.map((a) => h("label", { title: Array.isArray(a.trade_type_codes) && a.trade_type_codes.length ? `Trades: ${a.trade_type_codes.join(", ")}` : null },
    h("input", {
      type: "checkbox", value: a.id, checked: state.accSelected.has(a.id),
      onchange: (e) => {
        if (e.target.checked) state.accSelected.add(a.id);
        else state.accSelected.delete(a.id);
      },
    }), a.name)));
  if (view.items.length === 0) box.append(h("span", { class: "muted", text: "None for the ticked trades. Tick “Show all” to see every accreditation." }));
  const bar = $("#create-accreditations-bar");
  if (!view.canFilter) {
    bar.replaceChildren();
    return;
  }
  bar.replaceChildren(
    h("span", { class: "hint", text: view.filtering
      ? `Showing ${view.items.length} for the ticked trades (${view.hiddenCount} hidden).`
      : state.tradeOrder.length ? `Showing all ${accreditations.length}.` : `Showing all ${accreditations.length}. Tick a trade to see only its accreditations.` }),
    h("label", { class: "inline" }, h("input", { type: "checkbox", checked: state.accShowAll, onchange: (e) => { state.accShowAll = e.target.checked; renderAccreditationPicker(); } }), "Show all"));
}

// ---------------------------------------------------------------------------------------------
// Selected job: header, then cards in a fixed order, each showing its own result
// ---------------------------------------------------------------------------------------------

function cardKey(job, card) {
  return `${job.id}:${card}`;
}

/** The result kept for one card, shown under its button. */
function cardResult(job, card) {
  const kept = state.cardResults[cardKey(job, card)];
  if (!kept) return null;
  if (kept.notice) return noticeBox(kept.notice);
  return h("div", {}, h("div", { class: "hint", text: `${kept.label} · ${new Date(kept.at).toLocaleTimeString()}` }), resultBox(kept.r, kept.render));
}

/** A message by the card instead of a silent no-op (e.g. "Choose a file first"). */
function cardNotice(job, card, label, text) {
  state.cardResults[cardKey(job, card)] = { label, notice: text, at: Date.now() };
  state.lastAction = { label, ok: false, code: "NOTHING_SENT" };
  renderDetail();
  return false;
}

function renderDetail() {
  const root = $("#job-detail");
  root.replaceChildren();
  const job = state.job;
  const head = h("div", { class: "selected-head" },
    h("h2", {}, h("span", { class: "label", text: "Selected job:" }), " ",
      job ? `${job.external_reference || job.id} · ${job.status}` : "none"));
  head.querySelector("h2").setAttribute("aria-label", selectedJobTitle(job));
  if (job) {
    head.append(h("div", {}, envBadge(job.is_sandbox ? "sandbox" : "live"), " ",
      actionButton({ key: cardKey(job, "refresh"), text: "Refresh", class: "small", onRun: () => openJob(job.id) })));
  }
  root.append(head);
  if (state.lastAction) {
    const a = state.lastAction;
    root.append(h("p", { class: `last-action${a.ok ? "" : " fail"}`, text: `Last action: ${a.label} · ${a.ok ? "done" : a.code === "NOTHING_SENT" ? "nothing sent" : `failed${a.code ? ` (${a.code})` : ""}`}` }));
  }
  if (!job) {
    root.append(h("div", { class: "card muted", text: "Pick a job from the list, open one by your reference, or create one with New job." }));
    return;
  }

  const builders = {
    details: () => detailsCard(job),
    edit: () => editCard(job),
    note: () => noteCard(job),
    attachments: () => attachmentCard(job),
    publish: () => publishCard(job),
    simulate: () => simulateCard(job),
    cancel: () => cancelCard(job),
  };
  for (const card of cardOrder(job, { hasPublishResult: Boolean(state.cardResults[cardKey(job, "publish")]) })) root.append(builders[card]());
  root.append(h("div", { class: "card" }, h("h3", { text: "Webhook timeline for this job" }), h("div", { id: "job-timeline", class: "timeline feed" })));
  renderTimeline();
}

function detailsCard(job) {
  return h("div", { class: "card" },
    h("div", { class: "detail-head" }, h("h2", { text: job.title }), statusBadge(job.status)),
    jobSummary(job),
    h("details", {}, h("summary", { text: "Raw job JSON" }), pre(job)));
}

function jobSummary(job) {
  const site = job.site || {};
  const schedule = job.schedule || {};
  const price = job.price || {};
  return dl([
    ["id", h("span", { class: "mono", text: job.id })],
    ["your reference", job.external_reference ?? "-"],
    ["site", [site.unit, site.address, site.suburb, site.state, site.postcode].filter(Boolean).join(", ")],
    ["schedule", `preferred ${schedule.preferred_start_date ?? "-"}${schedule.time_window ? " " + schedule.time_window : ""} · booked ${schedule.scheduled_date ?? "-"}`],
    ["price", `${money(price.ex_gst_cents)} ex GST + ${money(price.gst_cents)} GST = ${money(price.total_cents)}${price.upper_ex_gst_cents ? ` (upper budget ${money(price.upper_ex_gst_cents)} ex GST)` : ""}`],
    ["urgency", job.urgency],
    ["trades", (job.trade_codes || []).join(", ") || "-"],
    ["accreditations", (job.accreditation_ids || []).length ? `${job.accreditation_ids.length} required` : "-"],
    ["installer", job.assigned_installer ? `${job.assigned_installer.company_name} (${job.assigned_installer.accreditations.length} accreditations)` : "none"],
    ["contacts", (job.contacts || []).map((c) => `${c.name}${c.is_primary ? " (primary)" : ""}`).join(", ") || "-"],
    ["created / updated", `${when(job.created_at)} / ${when(job.updated_at)}`],
    ["cancelled", job.cancelled_at ? `${when(job.cancelled_at)}: ${job.cancellation_reason ?? ""}` : undefined],
    ["work completed", job.work_completed_at ? when(job.work_completed_at) : undefined],
    ["replayed", job.replayed ? "yes (idempotent replay)" : undefined],
  ]);
}

/** Runs a job action and keeps its result by the card it came from. Returns whether it worked. */
async function jobAction({ job, card, label, method, path, body, live, render, after }) {
  const r = await api(method, path, body, live ? { live } : {});
  state.cardResults[cardKey(job, card)] = { label, r, render, at: Date.now() };
  state.lastAction = { label, ok: r.ok, code: r.cancelled ? "NOT_CONFIRMED" : r.error?.code };
  if (r.ok && r.data && r.data.id && r.data.status && r.data.site) setJob(r.data); // the response is a job
  if (after) await after(r);
  renderDetail();
  return r.ok;
}

function jobPath(job, suffix = "") {
  return `/api/jobs/${encodeURIComponent(job.id)}${suffix}`;
}

function publishCard(job) {
  const isDraft = job.status === "DRAFT";
  return h("div", { class: "card" },
    h("h3", { text: "Publish" }),
    h("p", { class: "hint", text: isDraft
      ? "Moves the job from DRAFT to OPEN, live to installers (for a live job). A job cannot be unpublished."
      : `Published: the job is ${job.status} now.` }),
    isDraft ? actionButton({
      key: cardKey(job, "publish"), text: "Publish", class: state.env === "live" ? "danger" : "primary",
      onRun: () => jobAction({ job, card: "publish", label: "Publish", method: "POST", path: jobPath(job, "/publish"), body: {},
        live: { action: "publish_job", target: job.id, summary: `Publish the LIVE job “${job.title}” to real installers.` } }),
    }) : null,
    cardResult(job, "publish"));
}

function editCard(job) {
  const editable = EDITABLE.includes(job.status);
  const form = h("form", { class: "form-grid" });
  const field = (label, name, value, attrs = {}) => h("label", { class: attrs.wide ? "wide" : "" }, label,
    attrs.textarea ? h("textarea", { name, rows: "2", text: value ?? "" }) : h("input", { name, value: value ?? "", ...attrs.input }));
  const submit = actionable(h("button", { type: "submit", class: state.env === "live" ? "danger" : "", text: "Save changes (PATCH)" }), cardKey(job, "edit"));
  add(form,
    field("Title", "title", job.title, { wide: true }),
    field("Description", "description", job.description, { wide: true, textarea: true }),
    field("Preferred start (YYYY-MM-DD)", "preferred_start_date", job.schedule?.preferred_start_date),
    field("Time window", "time_window", job.schedule?.time_window),
    field("Price ex GST ($)", "price_dollars", typeof job.price?.ex_gst_cents === "number" ? (job.price.ex_gst_cents / 100).toFixed(2) : ""),
    job.external_reference ? null : field("Your reference (can be set once)", "external_reference", ""),
    field("Notes", "notes", job.notes, { wide: true, textarea: true }),
    h("div", { class: "wide actions" }, submit,
      h("span", { class: "hint", text: "Only changed fields are sent. A new price usually triggers job.price_changed." })));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    runAction(cardKey(job, "edit"), () => {
      const f = form.elements;
      const values = Object.fromEntries(["title", "description", "notes", "preferred_start_date", "time_window", "price_dollars", "external_reference"]
        .filter((name) => f[name]).map((name) => [name, f[name].value]));
      const edit = editPatch(job, values);
      if (edit.notice) return cardNotice(job, "edit", "Edit", edit.notice);
      const { patch } = edit;
      return jobAction({ job, card: "edit", label: "Edit (PATCH)", method: "PATCH", path: jobPath(job), body: { patch },
        live: { action: "update_job", target: job.id, summary: `Change the LIVE job “${job.title}”: ${Object.keys(patch).join(", ")}.` } });
    });
  });
  const fieldset = h("fieldset", { disabled: !editable }, form);
  return h("div", { class: "card" }, h("h3", { text: "Edit" }),
    editable ? null : h("p", { class: "reason", text: `Disabled: TC answers 409 JOB_LOCKED. Jobs can be edited only while DRAFT or OPEN, and this one is ${job.status}. Changes are made in the TC web app.` }),
    fieldset,
    cardResult(job, "edit"));
}

function noteCard(job) {
  const text = h("textarea", { rows: "2", placeholder: "Note text (an assigned installer receives it as a message)" });
  return h("div", { class: "card" }, h("h3", { text: "Add a note" }), text,
    h("div", { class: "actions" }, actionButton({
      key: cardKey(job, "note"), text: "Add note",
      onRun: () => {
        if (!text.value.trim()) return cardNotice(job, "note", "Add note", "Write a note first.");
        return jobAction({ job, card: "note", label: "Add note", method: "POST", path: jobPath(job, "/notes"), body: { body: text.value.trim() },
          live: { action: "add_note", target: job.id, summary: `Add a note to the LIVE job “${job.title}”. If an installer is assigned, they receive it.` },
          render: (note) => dl([["note id", note.id], ["sent to installer", note.message_id ? "yes (as a chat message)" : "no (no installer yet; kept on the job record)"]], "") });
      },
    })),
    cardResult(job, "note"));
}

function attachmentCard(job) {
  const blocked = NO_ATTACHMENTS.includes(job.status);
  const file = h("input", { type: "file", accept: ".pdf,.jpg,.jpeg,.png,.heic,.webp" });
  const category = h("select", {}, h("option", { value: "", text: "(no category)" }), ...CATEGORIES.map((c) => h("option", { text: c })));
  const title = h("input", { placeholder: "Title (optional)" });
  // Always sent explicitly: TC makes a file PUBLIC when is_public is left out.
  const visibility = h("select", {},
    h("option", { value: "false", text: "Private: your company, the assigned installer and TC staff", selected: true }),
    h("option", { value: "true", text: "Public: also installers who can see the job before one is assigned" }));
  const button = actionButton({
    key: cardKey(job, "upload"), text: "Upload (3 steps)", disabled: blocked,
    onRun: async () => {
      const chosen = file.files[0];
      if (!chosen) return cardNotice(job, "attachments", "Upload attachment", "Choose a file first.");
      const ext = chosen.name.split(".").pop().toLowerCase();
      const contentType = Object.values(CONTENT_TYPES).includes(chosen.type) ? chosen.type : CONTENT_TYPES[ext];
      if (!contentType) return cardNotice(job, "attachments", "Upload attachment", "TC accepts PDF, JPEG, PNG, HEIC and WebP files only. Nothing was sent.");
      if (chosen.size > MAX_ATTACHMENT_BYTES) return cardNotice(job, "attachments", "Upload attachment", "TC accepts files up to 25 MB. Nothing was sent.");
      const dataBase64 = await fileToBase64(chosen);
      const body = { filename: chosen.name.replace(/[\\/]/g, "_"), content_type: contentType, data_base64: dataBase64 };
      if (category.value) body.category = category.value;
      if (title.value.trim()) body.title = title.value.trim();
      body.is_public = visibility.value === "true";
      const seenBy = body.is_public ? "PUBLIC (installers who can see the job may open it)" : "private";
      return jobAction({ job, card: "attachments", label: "Upload attachment", method: "POST", path: jobPath(job, "/attachments"), body,
        live: { action: "upload_attachment", target: job.id, summary: `Attach “${chosen.name}”, ${seenBy}, to the LIVE job “${job.title}”.` },
        render: (record) => dl([["attachment id", record.id], ["file", record.filename], ["type", record.mime_type], ["size", `${record.file_size} bytes`],
          ["visible to", record.is_public ? "public: also installers who can see the job before one is assigned" : "private: your company, the assigned installer and TC staff"]], "") });
    },
  });
  return h("div", { class: "card" }, h("h3", { text: "Upload an attachment" }),
    blocked ? h("p", { class: "reason", text: `Disabled: TC refuses attachments on ${job.status} jobs (409 JOB_LOCKED).` }) : null,
    h("p", { class: "hint", text: "1. ask TC for a signed upload URL · 2. PUT the bytes to it · 3. tell TC it is done (TC re-checks type, size and file signature)." }),
    h("div", { class: "form-grid" }, h("label", { class: "wide" }, "File", file), h("label", {}, "Category", category), h("label", {}, "Title", title),
      h("label", { class: "wide" }, "Who can see it", visibility)),
    h("p", { class: "hint", text: "Sent as is_public. If a request leaves it out, TC makes the file public, so this console always sends it. Keep invoices, contracts and anything with customer details private. The API cannot change it later." }),
    h("div", { class: "actions" }, button),
    cardResult(job, "attachments"));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** A rough hint only. TC decides any fee under the company's terms; the cancel response says what it charged. */
function feeEstimate(job) {
  if (job.is_sandbox) return "Sandbox cancellations are always free.";
  if (DO_NOT_CANCEL.includes(job.status)) return "Do not cancel: the work is done and awaiting the customer's sign-off. TC would currently cancel it with no fee (see the guide).";
  if (["DRAFT", "OPEN", "OFFERED"].includes(job.status) || !job.assigned_installer) return "Expected: no fee (no installer is assigned yet).";
  return "A fee may apply under your company's cancellation terms with Trade Connector. The response shows what was charged.";
}

function cancelCard(job) {
  const tcRefuses = NOT_CANCELLABLE.includes(job.status);
  const doNotCancel = DO_NOT_CANCEL.includes(job.status);
  const blocked = tcRefuses || (doNotCancel && !job.is_sandbox);
  const reason = h("input", { placeholder: "Reason (optional)", maxlength: "2000" });
  const estimate = feeEstimate(job);
  return h("div", { class: "card" }, h("h3", { text: "Cancel" }),
    tcRefuses ? h("p", { class: "reason", text: `Disabled: TC refuses to cancel ${job.status} jobs (409 JOB_LOCKED).` }) : null,
    doNotCancel ? h("p", { class: "reason", text: job.is_sandbox
      ? "Warning: this job's work is done and awaiting the customer's sign-off. TC accepts this cancel today, but integrators should not send it (see the guide)."
      : "Disabled: the work is done and awaiting the customer's sign-off. TC would cancel it with no fee; do not cancel through the API (see the guide)." }) : null,
    h("ul", { class: "fee-rules" },
      h("li", { text: "Free before an installer is assigned." }),
      h("li", { text: "After that, a fee may apply under your company's cancellation terms with Trade Connector." }),
      h("li", { text: "Sandbox jobs: always free." })),
    h("p", { class: "hint", text: estimate }),
    reason,
    h("div", { class: "actions" }, actionButton({
      key: cardKey(job, "cancel"), class: "danger", text: "Cancel job", disabled: blocked,
      onRun: () => {
        if (state.env !== "live" && !confirm(`Cancel the sandbox job “${job.title}”? (Free in sandbox.)`)) {
          return cardNotice(job, "cancel", "Cancel", "Not cancelled. Nothing was sent.");
        }
        const body = reason.value.trim() ? { reason: reason.value.trim() } : {};
        return jobAction({ job, card: "cancel", label: "Cancel", method: "POST", path: jobPath(job, "/cancel"), body,
          live: { action: "cancel_job", target: job.id, summary: `Cancel the LIVE job “${job.title}”. ${estimate} The fee, if any, is charged automatically.` },
          render: (c) => dl([
            ["status", `${c.previous_status} → ${c.status}`],
            ["fee_applied", String(c.fee_applied)],
            ["fee", `${money(c.fee_amount_cents)} + GST ${money(c.gst_cents)}`],
            ["cancellation_type", c.cancellation_type],
            ["charge_status", c.charge_status],
            ["invoice_number", c.invoice_number ?? "-"],
            ["card_last4", c.card_last4 ?? "-"],
            ["decline_reason", c.decline_reason ?? "-"],
            ["trade_notified", String(c.trade_notified)],
            ["payment_cancelled", String(c.payment_cancelled)],
            ["message", c.message],
          ], ""),
          after: async (r) => { if (r.ok) await refreshJobQuietly(job.id); } });
      },
    })),
    cardResult(job, "cancel"));
}

async function refreshJobQuietly(id) {
  const r = await api("GET", `/api/jobs/${encodeURIComponent(id)}`);
  if (r.ok) setJob(r.data);
}

function simulateCard(job) {
  if (state.env !== "sandbox") {
    return h("div", { class: "card muted", text: "Simulate is sandbox-only and is not offered in live mode." });
  }
  if (!job.is_sandbox) return h("div", { class: "card muted", text: "Simulate works on sandbox jobs only." });
  const current = LIFECYCLE.indexOf(job.status);
  const next = current >= 0 ? LIFECYCLE[current + 1] : undefined;
  const buttons = SIM_TARGETS.map((target) => {
    let disabled;
    if (target === "CANCELLED") disabled = SIM_LOCKED.includes(job.status);
    else disabled = SIM_LOCKED.includes(job.status) || current === -1 || LIFECYCLE.indexOf(target) <= current;
    return actionButton({
      key: cardKey(job, `sim:${target}`), lock: cardKey(job, "simulate"), text: target, disabled, class: target === next ? "next-step" : "",
      onRun: () => jobAction({ job, card: "simulate", label: `Simulate ${target}`, method: "POST", path: jobPath(job, "/simulate"), body: { status: target } }),
    });
  });
  return h("div", { class: "card" }, h("h3", { text: "Simulate (sandbox)" }),
    h("p", { class: "hint", text: "One step per press gives one job.status_changed per step; jumping several steps gives a single event (first → last). Jobs cannot go backwards." }),
    current === -1 && !SIM_LOCKED.includes(job.status) ? h("p", { class: "reason", text: `${job.status} is not on the simulated path; only CANCELLED is possible.` }) : null,
    h("div", { class: "sim-buttons" }, buttons),
    cardResult(job, "simulate"));
}

// ---------------------------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------------------------

function changesText(changes) {
  if (!changes || typeof changes !== "object") return "";
  return Object.entries(changes).map(([key, value]) => {
    if (value && typeof value === "object" && "to" in value) return `${key}: ${value.from ?? "∅"} → ${value.to ?? "∅"}`;
    return `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  }).join(" · ");
}

function eventItem(ev) {
  if (!ev.verified) {
    const onPurpose = ev.rejection?.reason === "retry_test";
    return h("div", { class: `event ${onPurpose ? "on-purpose" : "rejected"}` },
      h("div", { class: "event-head" },
        h("span", { class: "muted", text: when(ev.received_at) }), envBadge(ev.environment),
        onPurpose ? h("span", { class: "badge warn", text: "500 on purpose (sandbox check retry test)" }) : h("span", { class: "cross", text: "✗ refused" }),
        h("span", { class: "type", text: ev.rejection?.reason ?? "rejected" }),
        h("span", { class: "muted", text: ev.rejection?.message ?? "" })));
  }
  const f = ev.flags || {};
  let payload = ev.raw_body;
  try { payload = JSON.stringify(JSON.parse(ev.raw_body), null, 2); } catch { /* show as received */ }
  return h("div", { class: "event" },
    h("div", { class: "event-head" },
      h("span", { class: "muted", text: when(ev.received_at) }),
      envBadge(ev.environment),
      h("span", { class: "tick", title: "Signature verified", text: "✓" }),
      h("span", { class: "type", text: ev.event_type ?? "?" }),
      ev.job_status ? statusBadge(ev.job_status) : null,
      ev.external_reference ? h("span", { class: "mono", text: ev.external_reference }) : null,
      f.duplicate ? h("span", { class: "badge warn", text: "duplicate (not re-processed)" }) : null,
      f.out_of_order ? h("span", { class: "badge warn", text: "out of order (older than stored job)" }) : null,
      f.environment_mismatch ? h("span", { class: "badge bad", text: "is_sandbox does not match this path" }) : null,
      f.unknown_type ? h("span", { class: "badge warn", text: "unknown event type" }) : null,
      f.unknown_status ? h("span", { class: "badge warn", text: "unknown status" }) : null,
      f.test_event ? h("span", { class: "badge", text: "test event (dummy job)" }) : null),
    ev.changes && Object.keys(ev.changes).length ? h("div", { class: "muted", text: changesText(ev.changes) }) : null,
    h("details", {}, h("summary", { text: `Raw payload · webhook-id ${ev.webhook_id}` }), pre(payload ?? "")));
}

function renderFeed() {
  const env = $("#feed-env").value;
  const type = $("#feed-type").value;
  const showRejected = $("#feed-rejected").checked;
  const items = state.events.filter((ev) =>
    (!env || ev.environment === env) &&
    (!type || ev.event_type === type) &&
    (showRejected || ev.verified));
  $("#event-feed").replaceChildren(...(items.length ? items.slice(0, 300).map(eventItem) : [h("div", { class: "card muted", text: "No webhook events yet. Set up the tunnel and a TC endpoint, then press Send test event in TC." })]));
  $("#event-count").textContent = state.events.length ? String(state.events.length) : "";
}

function renderTimeline() {
  const box = $("#job-timeline");
  if (!box || !state.job) return;
  const items = state.events.filter((ev) => ev.job_id === state.job.id);
  box.replaceChildren(...(items.length ? items.map(eventItem) : [h("div", { class: "muted", text: "No webhook events for this job yet." })]));
}

async function pollEvents() {
  const r = await api("GET", `/api/events?after=${state.lastSeq}&limit=500`);
  if (!r.ok || !r.data) return;
  const fresh = r.data.events;
  if (fresh.length === 0) return;
  state.lastSeq = Math.max(state.lastSeq, ...fresh.map((e) => e.seq));
  state.events = fresh.concat(state.events).slice(0, 1000);
  renderFeed();
  renderTimeline();
  if (!$("#tab-coverage").hidden) loadCoverage();
}

// ---------------------------------------------------------------------------------------------
// Installs (live only)
// ---------------------------------------------------------------------------------------------

function renderInstallsVisibility() {
  const live = state.env === "live";
  $("#installs-sandbox").hidden = live;
  $("#installs-live").hidden = !live;
}

async function listInstalls(more) {
  const form = new FormData($("#installs-filter"));
  const q = new URLSearchParams();
  for (const name of ["serial", "status"]) if (form.get(name)) q.set(name, form.get(name));
  if (form.get("updated_since")) q.set("updated_since", new Date(form.get("updated_since")).toISOString());
  if (more && state.installsCursor) q.set("cursor", state.installsCursor);
  const r = await api("GET", `/api/installs?${q}`);
  if (!r.ok) { show($("#installs-result"), r); return false; }
  $("#installs-result").replaceChildren(callsList(r.calls) || "");
  state.installs = more ? state.installs.concat(r.data.data) : r.data.data;
  state.installsCursor = r.data.has_more ? r.data.next_cursor : null;
  const body = $("#installs-table tbody");
  body.replaceChildren(...state.installs.map((i) => h("tr", { onclick: () => getInstall(i.serial_number) },
    h("td", { class: "mono", text: i.serial_number }), h("td", { text: i.model_text ?? "-" }),
    h("td", {}, h("span", { class: "badge", text: i.status })), h("td", { text: when(i.updated_at) }))));
  $("#installs-more").hidden = !state.installsCursor;
  return true;
}

async function getInstall(serial) {
  const r = await api("GET", `/api/installs/${encodeURIComponent(serial)}`);
  show($("#installs-result"), r, (reg) => pre(reg));
}

async function saveInstall(form) {
  const install = {};
  for (const [key, value] of new FormData(form)) if (String(value).trim()) install[key] = String(value).trim();
  const r = await api("POST", "/api/installs", { install }, {
    live: { action: "upsert_install", summary: `Register or update the LIVE install for serial ${install.serial_number}.` },
  });
  show($("#install-form-result"), r, (reg) => pre(reg));
  return r.ok;
}

function fillInstallDefaults() {
  const f = $("#install-form").elements;
  f.serial_number.value = `EXAMPLE-SN-${uuid().slice(0, 6).toUpperCase()}`;
  f.model.value = "Example Model 1";
  f.installed_on.value = today();
  f.installer_name.value = "Example Installer Pty Ltd";
  f.site_address.value = "12 Example St";
  f.site_suburb.value = "Exampleton";
  f.site_state.value = "NSW";
  f.site_postcode.value = "2000";
  f.homeowner_name.value = "Alex Example";
  f.homeowner_email.value = "alex@example.com";
}

// ---------------------------------------------------------------------------------------------
// Sandbox check
// ---------------------------------------------------------------------------------------------

/**
 * Tracks presses inside an element: true from a pointer or key going down in it until it comes up
 * (anywhere). A rebuild in between would replace the element under the press and lose the click.
 * `onRelease` runs once the click that ends the press has been delivered.
 */
function pressTracker(element, onRelease) {
  let pointer = false;
  let key = false;
  element.addEventListener("pointerdown", () => { pointer = true; });
  element.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") key = true; });
  const release = (kind) => () => {
    if (kind === "pointer" ? !pointer : !key) return;
    if (kind === "pointer") pointer = false;
    else key = false;
    // After this event's click has been dispatched (it follows pointerup/keyup in the same task).
    setTimeout(onRelease, 0);
  };
  for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, release("pointer"), true);
  document.addEventListener("keyup", release("key"), true);
  window.addEventListener("blur", () => { pointer = false; key = false; });
  return { get pressing() { return pointer || key; } };
}

let checkControlsPress = null;
let checkViewPress = null;

function wireCheckTab() {
  const controls = $("#check-controls");
  const view = $("#check-view");
  if (controls) {
    checkControlsPress = pressTracker(controls, () => { if (controls.dataset.pending) renderCheckControls(); });
    controls.addEventListener("focusout", () => setTimeout(() => { if (controls.dataset.pending) renderCheckControls(); }, 0));
  }
  if (view) checkViewPress = pressTracker(view, () => { if (view.dataset.pending) renderCheck(); });
}

/** Sets a button's disabled state, or the state it returns to if its request is running now. */
function setDisabled(button, disabled) {
  if (!button) return;
  if (button.dataset.wasDisabled !== undefined) button.dataset.wasDisabled = disabled ? "1" : "";
  else button.disabled = disabled;
}

/**
 * The run button exists only in sandbox mode: in live mode it is not on the page at all.
 * Rebuilt only when a run starts, finishes or appears, or the mode or the run shown changes; never
 * while a control is being pressed or the dropdown or tick box has focus. Otherwise the labels and
 * states are updated in place, so a click (or an open dropdown) is never lost to a re-render. A
 * button that has focus keeps it across a rebuild.
 */
function renderCheckControls() {
  const controls = $("#check-controls");
  if (!controls) return;
  const c = state.check;
  const view = checkControlsView({ env: state.env, running: c.running, retryAvailable: c.retryAvailable, hasReport: Boolean(c.report),
    viewingId: c.viewingId, currentId: c.currentId, history: c.history }, when);
  const active = controls.contains(document.activeElement) ? document.activeElement : null;
  const action = rebuildAction({
    same: controls.dataset.signature === view.signature,
    built: controls.childElementCount > 0,
    pressing: Boolean(checkControlsPress?.pressing),
    focused: active !== null && ["SELECT", "INPUT"].includes(active.tagName),
  });
  if (action !== "rebuild") {
    controls.dataset.pending = action === "defer" ? "1" : "";
    const run = controls.querySelector('[data-action-key="check-run"]');
    if (run && run.textContent !== view.run.text) run.textContent = view.run.text;
    setDisabled(run, view.run.disabled);
    const retries = $("#check-retries", controls);
    if (retries) retries.disabled = view.retries.disabled;
    setDisabled(controls.querySelector('[data-action-key="check-copy"]'), view.copy.disabled);
    const select = $("select", controls);
    for (const option of select?.options ?? []) {
      const label = view.options.find((o) => o.value === option.value)?.label;
      if (label && option.textContent !== label) option.textContent = label;
    }
    return;
  }
  controls.dataset.signature = view.signature;
  controls.dataset.pending = "";
  const items = [];
  if (state.env === "sandbox") {
    items.push(
      h("label", { class: "inline", title: c.retryAvailable ? "" : "Not available: this server cannot run the listener's retry switch." },
        h("input", { type: "checkbox", id: "check-retries", disabled: view.retries.disabled, checked: $("#check-retries")?.checked ?? false }),
        "Also test TC retries (adds about 2 min)"),
      actionButton({ key: "check-run", text: view.run.text, class: "primary", disabled: view.run.disabled, onRun: startCheck }));
  } else {
    items.push(h("p", { class: "reason", text: "The sandbox check is not offered in live mode. Switch to Sandbox to run it. Past runs can still be viewed." }));
  }
  items.push(actionButton({ key: "check-copy", text: "Copy report", class: "outline", disabled: view.copy.disabled, onRun: copyReport }));
  if (view.options.length) {
    const select = h("select", { "aria-label": "Which run to show", onchange: (e) => viewRun(e.target.value) },
      ...view.options.map((o) => h("option", { value: o.value, selected: o.selected, text: o.label })));
    items.push(h("label", { class: "inline" }, "Run", select));
  }
  controls.replaceChildren(...items);
  const focusKey = active?.dataset?.actionKey;
  if (focusKey) controls.querySelector(`[data-action-key="${focusKey}"]`)?.focus({ preventScroll: true });
}

async function startCheck() {
  const retries = $("#check-retries")?.checked === true;
  const r = await api("POST", "/api/check/run", { test_retries: retries });
  if (!r.ok) {
    $("#check-message").replaceChildren(errorBox(r));
    return false;
  }
  $("#check-message").replaceChildren();
  state.check.viewingId = null;
  state.check.groupUi = {};
  state.check.openRows = new Set();
  state.check.run = r.data.run;
  state.check.running = true;
  renderCheckControls();
  renderCheck();
  await pollCheck(true);
  return true;
}

async function copyReport() {
  const text = state.check.report;
  if (!text) return false;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const area = h("textarea", { style: { position: "fixed", opacity: "0" } });
    area.value = text;
    document.body.append(area);
    area.select();
    try { copied = document.execCommand("copy"); } catch { copied = false; }
    area.remove();
  }
  $("#check-message").replaceChildren(copied
    ? noticeBox("Report copied. It is plain text, ready to paste into WhatsApp or an email.")
    : h("div", {}, noticeBox("The browser would not copy it. Select the text below and copy it."), h("pre", { class: "report-text", text })));
  return copied;
}

async function viewRun(value) {
  // Every option carries its run's id; the latest one means "follow the latest run".
  const id = pickRun(value, state.check.currentId);
  state.check.viewingId = id;
  state.check.groupUi = {};
  state.check.openRows = new Set();
  if (!id) return pollCheck(true);
  const r = await api("GET", `/api/check/runs/${encodeURIComponent(id)}`);
  if (!r.ok) {
    $("#check-message").replaceChildren(errorBox(r));
    return false;
  }
  state.check.run = r.data.run;
  state.check.report = r.data.report;
  state.check.previous = r.data.previous;
  renderCheckControls();
  renderCheck();
  return true;
}

/** Polls the current run: every second while it runs, every few seconds while the tab is open. */
async function pollCheck(force = false) {
  const c = state.check;
  const visible = !$("#tab-check").hidden;
  const now = Date.now();
  if (!force && !c.running && (!visible || now - c.lastPoll < 4000)) return;
  if (!force && now - c.lastPoll < 900) return;
  c.lastPoll = now;
  const [current, runs] = await Promise.all([api("GET", "/api/check/current"), api("GET", "/api/check/runs")]);
  if (!current.ok) return;
  const wasRunning = c.running;
  c.running = current.data.running;
  c.retryAvailable = current.data.retry_available;
  if (runs.ok) c.history = runs.data.runs;
  c.currentId = current.data.run?.id ?? null;
  if (!c.viewingId) {
    c.run = current.data.run;
    c.report = current.data.report;
    c.previous = current.data.previous;
  }
  renderCheckControls();
  renderCheck();
  if (wasRunning && !c.running) flash("check-run", c.run?.summary?.failed ? "fail" : "ok");
  if (!$("#tab-coverage").hidden && (wasRunning || c.running)) loadCoverage();
}

function exchangeView(ex) {
  const failed = ex.status === 0 || ex.status >= 400;
  return h("div", { class: "exchange" },
    h("div", { class: "exchange-head", text: `${ex.method} ${ex.path} → ${ex.status || "no response"}${ex.error_code ? ` ${ex.error_code}` : ""} · ${ex.duration_ms} ms${ex.request_id ? ` · request_id ${ex.request_id}` : ""}` }),
    failed && ex.error_code ? h("div", { class: "reason", text: `TC error code ${ex.error_code}${ex.request_id ? `, request_id ${ex.request_id} (quote it to TC support)` : ""}` }) : null,
    Object.keys(ex.request_headers || {}).length ? h("details", {}, h("summary", { text: "Request headers" }), pre(ex.request_headers)) : null,
    ex.request_body !== null && ex.request_body !== undefined ? h("details", {}, h("summary", { text: "Request body" }), pre(ex.request_body)) : null,
    ex.response_body !== null && ex.response_body !== undefined ? h("details", { open: failed }, h("summary", { text: "Response" }), pre(ex.response_body)) : null);
}

function checkRowView(row, was) {
  const c = state.check;
  const details = h("details", { class: `check-row ${row.status}`, open: c.openRows.has(row.id) });
  details.addEventListener("toggle", () => {
    if (details.open) c.openRows.add(row.id);
    else c.openRows.delete(row.id);
  });
  const ms = row.duration_ms;
  const time = row.status === "running" ? "running…" : typeof ms === "number" ? (ms < 10_000 ? `${ms} ms` : duration(ms)) : "";
  details.append(
    h("summary", {},
      dot(row.status, { context: row.title }),
      h("span", {}, h("span", { class: "row-title", text: row.title }),
        was ? h("span", { class: "was", text: `was ${statusMeta(was).label.toLowerCase()}` }) : null,
        row.reason ? h("span", { class: "row-reason", text: row.reason }) : null),
      h("span", { class: "row-time", text: time })),
    h("div", { class: "check-row-body" },
      row.error ? dl([["TC error code", row.error.code], ["HTTP status", row.error.status || "no response"], ["message", row.error.message], ["request_id", row.error.request_id ?? "-"]], "summary") : null,
      row.started_at ? h("p", { class: "hint", text: `Started ${when(row.started_at)}${row.finished_at ? ` · finished ${when(row.finished_at)}` : ""}` }) : null,
      row.exchanges.length ? row.exchanges.map(exchangeView) : h("p", { class: "hint", text: row.manual ? "A manual item: it ticks when the delivery arrives." : "No request: this row is worked out from other rows or deliveries." })));
  return details;
}

function timelineView(run) {
  return h("div", { class: "status-timeline" }, run.timeline.map((lane) => h("div", {},
    h("div", { class: "lane-label", text: `${lane.label}${lane.external_reference ? ` · ${lane.external_reference}` : ""}` }),
    h("div", { class: "lane" }, lane.steps.flatMap((step, i) => [
      i > 0 ? h("span", { class: "lane-arrow", "aria-hidden": "true", text: "→" }) : null,
      h("div", { class: `lane-step${step.reached ? " reached" : ""}` },
        h("span", { class: "lane-status", text: step.status, title: step.reached ? `${step.status}: reached` : `${step.status}: not yet` }),
        h("div", { class: "lane-events" }, step.events.map((ev) => dot(ev.status, { small: true, context: ev.type })))),
    ])))));
}

function renderCheck() {
  const view = $("#check-view");
  if (!view) return;
  const c = state.check;
  const run = c.run;
  if (!run) {
    view.replaceChildren(h("div", { class: "card muted", text: state.env === "sandbox" ? "No run yet. Press “Run full sandbox check”." : "No run yet." }));
    return;
  }
  const fraction = progress(run);
  const finished = run.state === "finished";
  const took = finished && run.finished_at ? duration(Date.parse(run.finished_at) - Date.parse(run.started_at)) : duration(Date.now() - Date.parse(run.started_at));
  const changes = changesSince(run, c.previous);
  const changedCount = Object.keys(changes).length;
  const resultClass = finished ? (run.summary.failed ? "fail" : "pass") : "";
  const head = h("div", { class: "card" },
    h("div", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(fraction * 100)), "aria-label": "Sandbox check progress" },
      h("div", { style: { width: `${Math.round(fraction * 100)}%` } })),
    h("div", { class: `check-result-line ${resultClass}`, role: "status", text: `${finished ? "" : "Running: "}${summaryLine(run.summary)}` }),
    h("p", { class: "hint", text: `Started ${when(run.started_at)} from the ${run.source === "cli" ? "command line" : "console"} · ${finished ? "took" : "for"} ${took} · key ${run.key_prefix ?? "-"}${run.options.test_retries ? " · with the retry test" : ""}${c.previous ? ` · ${changedCount} ${changedCount === 1 ? "row differs" : "rows differ"} from the run before (${when(c.previous.started_at)})` : ""}` }),
    timelineView(run));
  const signature = JSON.stringify([run, c.previous]);
  const shown = Boolean(c.groupsEl) && view.contains(c.groupsEl);
  // The rows are rebuilt when the run changes (every second or so during a run), but never under
  // a press: that waits until the press ends, so a click on a row or group is not lost.
  const action = rebuildAction({ same: c.groupsSignature === signature, built: shown, pressing: Boolean(checkViewPress?.pressing), focused: false });
  view.dataset.pending = action === "defer" ? "1" : "";
  if (action === "rebuild") {
    c.groupsEl = h("div", {}, groupsOf(run).map((group) => {
      const open = groupOpen(c.groupUi, group.id, group.autoOpen);
      const details = h("details", { class: "check-group", open });
      const onToggle = foldTracker(c.groupUi, group.id, open);
      details.addEventListener("toggle", () => onToggle(details.open));
      details.append(
        h("summary", {}, dot(group.summary.dot, { context: group.title }), h("span", { text: group.title }), h("span", { class: "group-count", text: group.summary.count })),
        h("div", { class: "check-rows" }, group.rows.map((row) => checkRowView(row, changes[row.id]))));
      return details;
    }));
    c.groupsSignature = signature;
  }
  // Only the head is swapped when the rows stay, so the node under a press is never moved.
  if (shown && action !== "rebuild" && view.firstElementChild !== c.groupsEl) view.firstElementChild.replaceWith(head);
  else view.replaceChildren(head, c.groupsEl);
}

// ---------------------------------------------------------------------------------------------
// Coverage checklist
// ---------------------------------------------------------------------------------------------

function markCell(mark, applicable) {
  if (!applicable) return h("td", { class: "muted", text: "n/a" });
  if (!mark) return h("td", { class: "muted", text: "—" });
  if (mark.ok_at) return h("td", {}, h("span", { class: "tick", text: "✓ " }), when(mark.ok_at));
  return h("td", {}, h("span", { class: "cross", text: "✗ " }), `${mark.last_status || "no response"} ${mark.last_error_code ?? ""}`);
}

function eventCell(mark) {
  if (!mark) return h("td", { class: "muted", text: "—" });
  return h("td", {}, h("span", { class: "tick", text: "✓ " }), `${when(mark.last_at)} ×${mark.count}`);
}

async function loadCoverage() {
  const r = await api("GET", "/api/coverage");
  if (!r.ok) { $("#coverage-endpoints").replaceChildren(errorBox(r)); return false; }
  const c = r.data;
  $("#coverage-started").textContent = `Checklist started ${when(c.started_at)}.`;
  $("#coverage-endpoints").replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, ["Operation", "Scope", "Sandbox", "Live", "Note"].map((t) => h("th", { text: t })))),
    h("tbody", {}, c.endpoints.map((e) => h("tr", {},
      h("td", { class: "mono", text: `${e.method} ${e.path}` }),
      h("td", { class: "mono", text: e.scope ?? "none" }),
      markCell(e.sandbox, e.environments !== "live"),
      markCell(e.live, e.environments !== "sandbox"),
      h("td", { class: "hint", text: e.note ?? "" }))))));
  const rows = c.events.map((e) => h("tr", {},
    h("td", { class: "mono", text: e.type }),
    eventCell(e.sandbox),
    eventCell(e.live),
    h("td", {}, h("span", { class: `badge ${e.sandbox_api ? "ok" : "warn"}`, text: e.sandbox_api ? "via the API" : "needs the TC web app" }), " ", e.how_to_trigger)));
  for (const e of c.unknown_events) {
    rows.push(h("tr", {}, h("td", { class: "mono", text: e.type }), eventCell(e.sandbox), eventCell(e.live), h("td", { class: "hint", text: "Not known to this example: stored and flagged." })));
  }
  $("#coverage-events").replaceChildren(h("table", {},
    h("thead", {}, h("tr", {}, ["Event", "Sandbox", "Live", "How to trigger"].map((t) => h("th", { text: t })))),
    h("tbody", {}, rows)));
  return true;
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

function wire() {
  bindButton("env-sandbox", () => switchEnvironment("sandbox"));
  bindButton("env-live", () => switchEnvironment("live"));
  bindButton("health-btn", checkHealth);
  for (const button of document.querySelectorAll(".tabs button")) button.addEventListener("click", () => showTab(button.dataset.tab));

  const statusSelect = $("#filter-status");
  for (const s of STATUSES) statusSelect.append(h("option", { text: s }));
  bindForm("job-filter", "list-submit", () => listJobs(false));
  bindButton("load-more", () => listJobs(true));
  bindForm("ext-lookup", "ext-submit", (form) => {
    const ref = String(new FormData(form).get("ref") ?? "").trim();
    if (!ref) {
      $("#ext-result").replaceChildren(noticeBox("Type a reference first."));
      return false;
    }
    return openJob(`ext:${ref}`, $("#ext-result"));
  });

  fillCreateDefaults();
  bindForm("create-form", "create-submit", createJob);
  bindButton("create-fresh", () => { freshIdentifiers(); return true; });
  bindButton("create-load-ref", loadReference);
  bindButton("ref-load", loadReference);
  // The New job form loads its reference data by itself when it opens.
  $("#create-card").addEventListener("toggle", () => {
    if ($("#create-card").open && !state.ref.loaded) ensureReference();
  });

  const typeSelect = $("#feed-type");
  for (const t of EVENT_TYPES) typeSelect.append(h("option", { text: t }));
  for (const id of ["#feed-env", "#feed-type", "#feed-rejected"]) $(id).addEventListener("change", renderFeed);

  fillInstallDefaults();
  bindForm("installs-filter", "installs-submit", () => listInstalls(false));
  bindButton("installs-more", () => listInstalls(true));
  bindForm("install-form", "install-submit", saveInstall);

  bindButton("coverage-reset", async () => {
    if (!confirm("Reset the coverage checklist for both environments?")) return false;
    const r = await api("POST", "/api/coverage/reset", {});
    await loadCoverage();
    return r.ok;
  });
}

async function start() {
  state.token = readToken();
  wire();
  wireCheckTab();
  renderDetail();
  if (!state.token) {
    showTokenMissing();
    return;
  }
  await loadStatus();
  renderFeed();
  // The job list loads by itself when the console opens.
  await Promise.all([runAction("list-submit", () => listJobs(false)), pollEvents(), pollCheck(true)]);
  setInterval(pollEvents, 3000);
  setInterval(() => pollCheck(false), 1000);
  runAction("health-btn", checkHealth);
}

start();
