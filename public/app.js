// Trade Connector example console (browser side).
//
// Plain JavaScript, no framework and no build step. It talks only to this server's /api routes,
// which call Trade Connector server-side: API keys never reach the browser.
// Every piece of text from TC or from a webhook is inserted with textContent, never as HTML.
"use strict";

// ---------------------------------------------------------------------------------------------
// Constants (mirroring TC's rules; the server and TC enforce them, these only guide the UI)
// ---------------------------------------------------------------------------------------------

const STATUSES = ["DRAFT", "OPEN", "OFFERED", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PENDING_CUSTOMER_SIG", "PAID", "CANCELLED", "DISPUTED"];
const EDITABLE = ["DRAFT", "OPEN"];
const NOT_CANCELLABLE = ["WORK_COMPLETE", "PAID", "CANCELLED", "DISPUTED"];
const NO_ATTACHMENTS = ["CANCELLED", "PAID"];
const LIFECYCLE = ["DRAFT", "OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID"];
const SIM_TARGETS = ["OPEN", "ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID", "CANCELLED"];
const SIM_LOCKED = ["CANCELLED", "PAID", "DISPUTED"];
const EVENT_TYPES = ["job.created", "job.status_changed", "job.assigned", "job.scheduled", "job.rescheduled", "job.completed", "job.evidence_ready", "job.price_changed", "job.cancelled", "webhook.test"];
const CATEGORIES = ["SITE_PHOTO", "SPEC_SHEET", "PLAN", "PERMIT", "CONTRACT", "INVOICE", "COMPLIANCE", "OTHER"];
const CONTENT_TYPES = { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", webp: "image/webp" };
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const state = {
  token: null,
  env: "sandbox",
  status: null,
  ref: { jobTypes: null, tradeTypes: null, accreditations: null },
  tradeOrder: [],
  jobs: [],
  jobsCursor: null,
  job: null,
  detailResult: null,
  events: [],
  lastSeq: 0,
  installs: [],
  installsCursor: null,
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);

/** Creates an element. attrs: class, text, on<event>, or any attribute/property. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
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
  if (r.cancelled) return h("div", { class: "result" }, e.message);
  return h("div", { class: "result error" },
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
  $("#tunnel-cmd").textContent = `cloudflared tunnel --url http://localhost:${s.webhooks.port}`;
  renderInstallsVisibility();
  renderDetail();
}

function secretBadge(configured, name) {
  return configured
    ? h("span", { class: "badge ok", text: "secret set" })
    : h("span", { class: "badge warn", text: `${name} not set` });
}

async function switchEnvironment(target) {
  if (target === state.env) return;
  if (target === "live") {
    const typed = await askLive("Switch the console to LIVE mode? Live jobs reach real installers, and cancelling a booked job can cost money.");
    if (typed !== "LIVE") return;
    const r = await api("POST", "/api/environment", { environment: "live", typed });
    if (!r.ok) alert(r.error?.message ?? "Could not switch");
  } else {
    await api("POST", "/api/environment", { environment: "sandbox" });
  }
  await loadStatus();
  clearJobs();
}

async function checkHealth() {
  const out = $("#fact-health");
  out.textContent = "checking…";
  const r = await api("GET", "/api/health");
  out.replaceChildren(r.ok
    ? h("span", { class: "badge ok", text: `${r.data.status} (${r.data.version})` })
    : h("span", { class: "badge bad", text: r.error?.code ?? `HTTP ${r.status}`, title: r.error?.message ?? "" }));
}

// ---------------------------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------------------------

function showTab(name) {
  for (const button of document.querySelectorAll(".tabs button")) button.classList.toggle("active", button.dataset.tab === name);
  for (const section of document.querySelectorAll("main .tab")) section.hidden = section.id !== `tab-${name}`;
  if (name === "coverage") loadCoverage();
  if (name === "installs") renderInstallsVisibility();
}

// ---------------------------------------------------------------------------------------------
// Jobs list
// ---------------------------------------------------------------------------------------------

function clearJobs() {
  state.jobs = [];
  state.jobsCursor = null;
  state.job = null;
  state.detailResult = null;
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
  const r = await api("GET", `/api/jobs?${q}`);
  if (!r.ok) {
    show($("#list-result"), r);
    return;
  }
  $("#list-result").replaceChildren(h("span", { class: "hint", text: `${r.data.data.length} jobs${r.data.has_more ? ", more available" : ""}` }));
  state.jobs = more ? state.jobs.concat(r.data.data) : r.data.data;
  state.jobsCursor = r.data.has_more ? r.data.next_cursor : null;
  renderJobs();
}

function renderJobs() {
  const body = $("#jobs-table tbody");
  body.replaceChildren();
  if (state.jobs.length === 0) {
    body.append(h("tr", {}, h("td", { colspan: "4", class: "muted", text: "No jobs listed." })));
  }
  for (const job of state.jobs) {
    body.append(h("tr", { class: state.job?.id === job.id ? "selected" : "", onclick: () => openJob(job.id) },
      h("td", { class: "mono", text: job.external_reference ?? "-" }),
      h("td", { text: job.title }),
      h("td", {}, statusBadge(job.status)),
      h("td", { text: when(job.updated_at) })));
  }
  $("#load-more").hidden = !state.jobsCursor;
}

async function openJob(id) {
  const r = await api("GET", `/api/jobs/${encodeURIComponent(id)}`);
  if (!r.ok) {
    state.job = null;
    state.detailResult = { label: `Open ${id}`, r };
    renderDetail();
    return;
  }
  setJob(r.data);
  state.detailResult = null;
  renderDetail();
}

function setJob(job) {
  state.job = job;
  const i = state.jobs.findIndex((j) => j.id === job.id);
  if (i >= 0) state.jobs[i] = job;
  else state.jobs.unshift(job);
  renderJobs();
}

// ---------------------------------------------------------------------------------------------
// Create job
// ---------------------------------------------------------------------------------------------

function freshIdentifiers() {
  const form = $("#create-form");
  form.elements.external_reference.value = `EX-${today()}-${uuid().slice(0, 8)}`;
  form.elements.idempotency_key.value = uuid();
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
  f.end_customer_phone.value = "0400 000 000";
  f.end_customer_email.value = "alex@example.com";
  f.contact_name.value = "Alex Example";
  f.contact_phone.value = "0400 000 000";
  f.price_dollars.value = "1500.00";
  freshIdentifiers();
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
  const accreditations = [...document.querySelectorAll("#create-accreditations input:checked")].map((i) => i.value);
  if (accreditations.length) job.accreditation_ids = accreditations;
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

async function createJob(event) {
  event.preventDefault();
  const body = buildCreateBody();
  const where = body.job.publish ? "PUBLISHED to real installers" : "saved as a draft";
  const r = await api("POST", "/api/jobs", body, {
    live: { action: "create_job", summary: `Create the LIVE job “${body.job.title}”, ${where}.` },
  });
  show($("#create-result"), r, (job) => h("div", {},
    h("strong", { text: job.replayed ? "Replayed: TC returned the job first created with this Idempotency-Key (HTTP 200)." : "Created (HTTP 201)." }),
    dl([["id", job.id], ["external_reference", job.external_reference], ["status", statusBadge(job.status)]], "")));
  if (r.ok) {
    setJob(r.data);
    state.detailResult = null;
    renderDetail();
  }
}

// ---------------------------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------------------------

async function loadReference() {
  const [jobTypes, tradeTypes, accreditations] = await Promise.all([
    api("GET", "/api/reference/job-types"),
    api("GET", "/api/reference/trade-types"),
    api("GET", "/api/reference/accreditations"),
  ]);
  const failed = [jobTypes, tradeTypes, accreditations].find((r) => !r.ok);
  if (failed) {
    $("#ref-result").replaceChildren(errorBox(failed));
    $("#create-trades").replaceChildren(errorBox(failed));
  } else {
    $("#ref-result").replaceChildren(resultBox({ ok: true, calls: [...jobTypes.calls, ...tradeTypes.calls, ...accreditations.calls] }, () => "Loaded."));
  }
  if (jobTypes.ok) state.ref.jobTypes = jobTypes.data;
  if (tradeTypes.ok) state.ref.tradeTypes = tradeTypes.data;
  if (accreditations.ok) state.ref.accreditations = accreditations.data;
  renderReference();
}

function table(columns, rows) {
  return h("table", {},
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { text: c.label })))),
    h("tbody", {}, rows.map((row) => h("tr", {}, columns.map((c) => h("td", { class: c.mono ? "mono" : "", text: row[c.key] ?? "-" }))))));
}

function renderReference() {
  const { jobTypes, tradeTypes, accreditations } = state.ref;
  if (jobTypes) {
    $("#ref-job-types").replaceChildren(table([{ key: "id", label: "id", mono: true }, { key: "name", label: "Name" }, { key: "service_category_id", label: "Category" }], jobTypes));
    const select = $("#create-form").elements.job_type_id;
    select.replaceChildren(h("option", { value: "", text: "(none)" }), ...jobTypes.map((t) => h("option", { value: String(t.id), text: `${t.name} (#${t.id})` })));
  }
  if (tradeTypes) {
    $("#ref-trade-types").replaceChildren(table([{ key: "code", label: "code", mono: true }, { key: "name", label: "Name" }, { key: "category", label: "Category" }], tradeTypes));
    $("#create-trades").className = "";
    $("#create-trades").replaceChildren(...tradeTypes.map((t) => h("label", {},
      h("input", {
        type: "checkbox", value: t.code, checked: state.tradeOrder.includes(t.code),
        onchange: (e) => {
          state.tradeOrder = state.tradeOrder.filter((c) => c !== t.code);
          if (e.target.checked) state.tradeOrder.push(t.code);
        },
      }), `${t.name} (${t.code})`)));
  }
  if (accreditations) {
    $("#ref-accreditations").replaceChildren(table([{ key: "name", label: "Name" }, { key: "issuing_body", label: "Issuer" }, { key: "id", label: "id", mono: true }], accreditations));
    $("#create-accreditations").className = "";
    $("#create-accreditations").replaceChildren(...accreditations.map((a) => h("label", {},
      h("input", { type: "checkbox", value: a.id }), a.name)));
  }
}

// ---------------------------------------------------------------------------------------------
// Job detail and actions
// ---------------------------------------------------------------------------------------------

function renderDetail() {
  const root = $("#job-detail");
  root.replaceChildren();
  const job = state.job;
  if (!job) {
    root.append(h("div", { class: "card muted", text: "Pick a job, create one, or look one up by reference." }));
    if (state.detailResult) root.append(h("div", { class: "card" }, h("h3", { text: state.detailResult.label }), resultBox(state.detailResult.r)));
    return;
  }

  root.append(h("div", { class: "card" },
    h("div", { class: "detail-head" },
      h("h2", {}, job.title, " "),
      h("div", {}, statusBadge(job.status), " ", envBadge(job.is_sandbox ? "sandbox" : "live"), " ",
        h("button", { type: "button", class: "small", text: "Refresh", onclick: () => openJob(job.id) }))),
    jobSummary(job),
    h("details", {}, h("summary", { text: "Raw job JSON" }), pre(job))));

  if (state.detailResult) {
    root.append(h("div", { class: "card" }, h("h3", { text: `Last action: ${state.detailResult.label}` }), resultBox(state.detailResult.r, state.detailResult.render)));
  }

  if (job.status === "DRAFT") root.append(publishCard(job));
  root.append(editCard(job), noteCard(job), attachmentCard(job), cancelCard(job), simulateCard(job));
  root.append(h("div", { class: "card" }, h("h3", { text: "Webhook timeline for this job" }), h("div", { id: "job-timeline", class: "timeline feed" })));
  renderTimeline();
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

/** Runs a job action and keeps its result on screen. */
async function jobAction(label, method, path, body, live, render, after) {
  const r = await api(method, path, body, live ? { live } : {});
  state.detailResult = { label, r, render };
  if (r.ok && r.data && r.data.id && r.data.status && r.data.site) setJob(r.data); // the response is a job
  if (after) await after(r);
  renderDetail();
}

function jobPath(job, suffix = "") {
  return `/api/jobs/${encodeURIComponent(job.id)}${suffix}`;
}

function publishCard(job) {
  return h("div", { class: "card" },
    h("h3", { text: "Publish" }),
    h("p", { class: "hint", text: "Moves the job from DRAFT to OPEN, live to installers (for a live job). A job cannot be unpublished." }),
    h("button", {
      type: "button", class: state.env === "live" ? "danger" : "primary", text: "Publish",
      onclick: () => jobAction("Publish", "POST", jobPath(job, "/publish"), {},
        { action: "publish_job", target: job.id, summary: `Publish the LIVE job “${job.title}” to real installers.` }),
    }));
}

function editCard(job) {
  const editable = EDITABLE.includes(job.status);
  const form = h("form", { class: "form-grid" });
  const field = (label, name, value, attrs = {}) => h("label", { class: attrs.wide ? "wide" : "" }, label,
    attrs.textarea ? h("textarea", { name, rows: "2", text: value ?? "" }) : h("input", { name, value: value ?? "", ...attrs.input }));
  form.append(
    field("Title", "title", job.title, { wide: true }),
    field("Description", "description", job.description, { wide: true, textarea: true }),
    field("Preferred start (YYYY-MM-DD)", "preferred_start_date", job.schedule?.preferred_start_date),
    field("Time window", "time_window", job.schedule?.time_window),
    field("Price ex GST ($)", "price_dollars", typeof job.price?.ex_gst_cents === "number" ? (job.price.ex_gst_cents / 100).toFixed(2) : ""),
    job.external_reference ? null : field("Your reference (can be set once)", "external_reference", ""),
    field("Notes", "notes", job.notes, { wide: true, textarea: true }),
    h("div", { class: "wide actions" }, h("button", { type: "submit", class: state.env === "live" ? "danger" : "", text: "Save changes (PATCH)" }),
      h("span", { class: "hint", text: "Only changed fields are sent. A new price usually triggers job.price_changed." })));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = form.elements;
    const v = (name) => (f[name] ? f[name].value.trim() : "");
    const patch = {};
    if (v("title") !== job.title) patch.title = v("title");
    if (v("description") !== job.description) patch.description = v("description");
    if (v("notes") !== (job.notes ?? "")) patch.notes = v("notes") || null;
    const schedule = {};
    if (v("preferred_start_date") !== (job.schedule?.preferred_start_date ?? "")) schedule.preferred_start_date = v("preferred_start_date") || null;
    if (v("time_window") !== (job.schedule?.time_window ?? "")) schedule.time_window = v("time_window") || null;
    if (Object.keys(schedule).length) patch.schedule = schedule;
    const currentPrice = typeof job.price?.ex_gst_cents === "number" ? job.price.ex_gst_cents : null;
    if (v("price_dollars")) {
      const cents = Math.round(Number(v("price_dollars")) * 100);
      if (cents !== currentPrice) patch.price = { ex_gst_cents: cents };
    }
    if (v("external_reference")) patch.external_reference = v("external_reference");
    if (Object.keys(patch).length === 0) {
      state.detailResult = { label: "Edit", r: { ok: false, error: { source: "console", code: "NOTHING_CHANGED", message: "Nothing changed, so nothing was sent." }, calls: [] } };
      renderDetail();
      return;
    }
    jobAction("Edit (PATCH)", "PATCH", jobPath(job), { patch },
      { action: "update_job", target: job.id, summary: `Change the LIVE job “${job.title}”: ${Object.keys(patch).join(", ")}.` });
  });
  const fieldset = h("fieldset", { disabled: !editable }, form);
  return h("div", { class: "card" }, h("h3", { text: "Edit" }),
    editable ? null : h("p", { class: "reason", text: `Disabled: TC answers 409 JOB_LOCKED. Jobs can be edited only while DRAFT or OPEN, and this one is ${job.status}. Changes are made in the TC web app.` }),
    fieldset);
}

function noteCard(job) {
  const text = h("textarea", { rows: "2", placeholder: "Note text (an assigned installer receives it as a message)" });
  return h("div", { class: "card" }, h("h3", { text: "Add a note" }), text,
    h("div", { class: "actions" }, h("button", {
      type: "button", text: "Add note",
      onclick: () => {
        if (!text.value.trim()) return;
        jobAction("Add note", "POST", jobPath(job, "/notes"), { body: text.value.trim() },
          { action: "add_note", target: job.id, summary: `Add a note to the LIVE job “${job.title}”. If an installer is assigned, they receive it.` },
          (note) => dl([["note id", note.id], ["sent to installer", note.message_id ? "yes (as a chat message)" : "no (no installer yet; kept on the job record)"]], ""));
      },
    })));
}

function attachmentCard(job) {
  const blocked = NO_ATTACHMENTS.includes(job.status);
  const file = h("input", { type: "file", accept: ".pdf,.jpg,.jpeg,.png,.heic,.webp" });
  const category = h("select", {}, h("option", { value: "", text: "(no category)" }), ...CATEGORIES.map((c) => h("option", { text: c })));
  const title = h("input", { placeholder: "Title (optional)" });
  const button = h("button", {
    type: "button", text: "Upload (3 steps)", disabled: blocked,
    onclick: async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      const ext = chosen.name.split(".").pop().toLowerCase();
      const contentType = Object.values(CONTENT_TYPES).includes(chosen.type) ? chosen.type : CONTENT_TYPES[ext];
      if (!contentType) { alert("TC accepts PDF, JPEG, PNG, HEIC and WebP files only."); return; }
      if (chosen.size > MAX_ATTACHMENT_BYTES) { alert("TC accepts files up to 25 MB."); return; }
      const dataBase64 = await fileToBase64(chosen);
      const body = { filename: chosen.name.replace(/[\\/]/g, "_"), content_type: contentType, data_base64: dataBase64 };
      if (category.value) body.category = category.value;
      if (title.value.trim()) body.title = title.value.trim();
      jobAction("Upload attachment", "POST", jobPath(job, "/attachments"), body,
        { action: "upload_attachment", target: job.id, summary: `Attach “${chosen.name}” to the LIVE job “${job.title}”.` },
        (record) => dl([["attachment id", record.id], ["file", record.filename], ["type", record.mime_type], ["size", `${record.file_size} bytes`]], ""));
    },
  });
  return h("div", { class: "card" }, h("h3", { text: "Upload an attachment" }),
    blocked ? h("p", { class: "reason", text: `Disabled: TC refuses attachments on ${job.status} jobs (409 JOB_LOCKED).` }) : null,
    h("p", { class: "hint", text: "1. ask TC for a signed upload URL · 2. PUT the bytes to it · 3. tell TC it is done (TC re-checks type, size and file signature)." }),
    h("div", { class: "form-grid" }, h("label", { class: "wide" }, "File", file), h("label", {}, "Category", category), h("label", {}, "Title", title)),
    h("div", { class: "actions" }, button));
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** What TC is likely to charge, from its published rules. TC decides; the response says what it did. */
function feeEstimate(job) {
  if (job.is_sandbox) return "Sandbox cancellations are always free.";
  if (["DRAFT", "OPEN", "OFFERED"].includes(job.status) || !job.assigned_installer) return "Expected: no fee (no installer is assigned yet).";
  if (job.status === "IN_PROGRESS") return "Expected: a call-out fee ($250 + GST by default) if the installer has started on site.";
  const target = job.schedule?.scheduled_date ?? job.schedule?.preferred_start_date;
  if (!target) return "Expected: no fee (no booked date).";
  const hours = (new Date(target).getTime() - Date.now()) / 3600000;
  if (hours < 48 && hours > -24) return `Expected: a late cancellation fee ($200 + GST by default): the booked date is ${Math.round(hours)} hours away.`;
  return "Expected: no fee (the booked date is 48 hours or more away).";
}

function cancelCard(job) {
  const blocked = NOT_CANCELLABLE.includes(job.status);
  const reason = h("input", { placeholder: "Reason (optional)", maxlength: "2000" });
  const estimate = feeEstimate(job);
  return h("div", { class: "card" }, h("h3", { text: "Cancel" }),
    blocked ? h("p", { class: "reason", text: `Disabled: TC refuses to cancel ${job.status} jobs (409 JOB_LOCKED).` }) : null,
    h("ul", { class: "fee-rules" },
      h("li", { text: "No fee before an installer is assigned, or while the booked date is 48 hours or more away." }),
      h("li", { text: "$200 + GST inside 48 hours of the booked date." }),
      h("li", { text: "$250 + GST call-out once the installer has started on site." }),
      h("li", { text: "Sandbox jobs: always free. Amounts are TC's defaults." })),
    h("p", { class: "hint", text: estimate }),
    reason,
    h("div", { class: "actions" }, h("button", {
      type: "button", class: "danger", text: "Cancel job", disabled: blocked,
      onclick: () => {
        if (state.env !== "live" && !confirm(`Cancel the sandbox job “${job.title}”? (Free in sandbox.)`)) return;
        const body = reason.value.trim() ? { reason: reason.value.trim() } : {};
        jobAction("Cancel", "POST", jobPath(job, "/cancel"), body,
          { action: "cancel_job", target: job.id, summary: `Cancel the LIVE job “${job.title}”. ${estimate} The fee, if any, is charged automatically.` },
          (c) => dl([
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
          async (r) => { if (r.ok) await refreshJobQuietly(job.id); });
      },
    })));
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
    return h("button", {
      type: "button", text: target, disabled, class: target === next ? "next-step" : "",
      onclick: () => jobAction(`Simulate ${target}`, "POST", jobPath(job, "/simulate"), { status: target }),
    });
  });
  return h("div", { class: "card" }, h("h3", { text: "Simulate (sandbox)" }),
    h("p", { class: "hint", text: "One step per press gives one job.status_changed per step; jumping several steps gives a single event (first → last). Jobs cannot go backwards." }),
    current === -1 && !SIM_LOCKED.includes(job.status) ? h("p", { class: "reason", text: `${job.status} is not on the simulated path; only CANCELLED is possible.` }) : null,
    h("div", { class: "sim-buttons" }, buttons));
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
    return h("div", { class: "event rejected" },
      h("div", { class: "event-head" },
        h("span", { class: "muted", text: when(ev.received_at) }), envBadge(ev.environment),
        h("span", { class: "cross", text: "✗ refused" }), h("span", { class: "type", text: ev.rejection?.reason ?? "rejected" }),
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
  if (!r.ok) { show($("#installs-result"), r); return; }
  $("#installs-result").replaceChildren(callsList(r.calls) || "");
  state.installs = more ? state.installs.concat(r.data.data) : r.data.data;
  state.installsCursor = r.data.has_more ? r.data.next_cursor : null;
  const body = $("#installs-table tbody");
  body.replaceChildren(...state.installs.map((i) => h("tr", { onclick: () => getInstall(i.serial_number) },
    h("td", { class: "mono", text: i.serial_number }), h("td", { text: i.model_text ?? "-" }),
    h("td", {}, h("span", { class: "badge", text: i.status })), h("td", { text: when(i.updated_at) }))));
  $("#installs-more").hidden = !state.installsCursor;
}

async function getInstall(serial) {
  const r = await api("GET", `/api/installs/${encodeURIComponent(serial)}`);
  show($("#installs-result"), r, (reg) => pre(reg));
}

async function saveInstall(event) {
  event.preventDefault();
  const install = {};
  for (const [key, value] of new FormData($("#install-form"))) if (String(value).trim()) install[key] = String(value).trim();
  const r = await api("POST", "/api/installs", { install }, {
    live: { action: "upsert_install", summary: `Register or update the LIVE install for serial ${install.serial_number}.` },
  });
  show($("#install-form-result"), r, (reg) => pre(reg));
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
  if (!r.ok) { $("#coverage-endpoints").replaceChildren(errorBox(r)); return; }
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
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

function wire() {
  $("#env-sandbox").addEventListener("click", () => switchEnvironment("sandbox"));
  $("#env-live").addEventListener("click", () => switchEnvironment("live"));
  $("#health-btn").addEventListener("click", checkHealth);
  for (const button of document.querySelectorAll(".tabs button")) button.addEventListener("click", () => showTab(button.dataset.tab));

  const statusSelect = $("#filter-status");
  for (const s of STATUSES) statusSelect.append(h("option", { text: s }));
  $("#job-filter").addEventListener("submit", (e) => { e.preventDefault(); listJobs(false); });
  $("#load-more").addEventListener("click", () => listJobs(true));
  $("#ext-lookup").addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = new FormData(e.target).get("ref").trim();
    if (ref) openJob(`ext:${ref}`);
  });

  fillCreateDefaults();
  $("#create-form").addEventListener("submit", createJob);
  $("#create-fresh").addEventListener("click", freshIdentifiers);
  $("#create-load-ref").addEventListener("click", loadReference);
  $("#ref-load").addEventListener("click", loadReference);

  const typeSelect = $("#feed-type");
  for (const t of EVENT_TYPES) typeSelect.append(h("option", { text: t }));
  for (const id of ["#feed-env", "#feed-type", "#feed-rejected"]) $(id).addEventListener("change", renderFeed);

  fillInstallDefaults();
  $("#installs-filter").addEventListener("submit", (e) => { e.preventDefault(); listInstalls(false); });
  $("#installs-more").addEventListener("click", () => listInstalls(true));
  $("#install-form").addEventListener("submit", saveInstall);

  $("#coverage-reset").addEventListener("click", async () => {
    if (!confirm("Reset the coverage checklist for both environments?")) return;
    await api("POST", "/api/coverage/reset", {});
    loadCoverage();
  });
}

async function start() {
  state.token = readToken();
  wire();
  if (!state.token) {
    showTokenMissing();
    return;
  }
  await loadStatus();
  renderJobs();
  renderFeed();
  await pollEvents();
  setInterval(pollEvents, 3000);
  checkHealth();
}

start();
