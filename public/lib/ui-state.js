// Pure helpers for the console page: no DOM, so Node's tests can import them directly.
// (The page loads this as an ES module; see app.js.)

/**
 * Which accreditations the create form offers, given the ticked trades.
 *
 * TC is adding `trade_type_codes: string[]` to each accreditation within v1 (it is not live yet).
 * - No accreditation carries it: offer them all, exactly as before.
 * - Some do: offer those for the ticked trades, plus any without a trade list (they are not
 *   tied to a trade), plus any already ticked (never hide a choice that will be sent). With no
 *   trade ticked, or "show all" on, offer them all.
 *
 * @param {{ accreditations: Array<{ id: string, trade_type_codes?: string[] }> | null | undefined,
 *           tickedTrades?: string[], showAll?: boolean, selectedIds?: string[] | Set<string> }} input
 * @returns {{ items: Array<any>, canFilter: boolean, filtering: boolean, hiddenCount: number }}
 */
export function filterAccreditations({ accreditations, tickedTrades = [], showAll = false, selectedIds = [] }) {
  const list = Array.isArray(accreditations) ? accreditations : [];
  const canFilter = list.some((a) => Array.isArray(a?.trade_type_codes));
  const trades = new Set(tickedTrades);
  if (!canFilter || showAll || trades.size === 0) {
    return { items: list, canFilter, filtering: false, hiddenCount: 0 };
  }
  const selected = new Set(selectedIds);
  const items = list.filter((a) => {
    const codes = a.trade_type_codes;
    if (!Array.isArray(codes) || codes.length === 0) return true;
    return codes.some((code) => trades.has(code)) || selected.has(a.id);
  });
  return { items, canFilter, filtering: true, hiddenCount: list.length - items.length };
}

/**
 * What a create answered: "created" (201), "replayed" (200, the job first created with this
 * Idempotency-Key) or "error".
 * @param {{ ok: boolean, data?: any, calls?: Array<{ operation: string, status: number }> }} result
 */
export function createOutcome(result) {
  if (!result || !result.ok) return "error";
  const replayedCall = (result.calls || []).some((c) => c.operation === "jobs.create" && c.status === 200);
  return result.data?.replayed === true || replayedCall ? "replayed" : "created";
}

/**
 * Keeps a request from being sent twice: start(key) is false while that key's request runs.
 * Sending again once it has finished is fine (that is how the idempotency replay is shown).
 */
export function createInflight() {
  const busy = new Set();
  return {
    /** @param {string} key */
    start(key) {
      if (busy.has(key)) return false;
      busy.add(key);
      return true;
    },
    /** @param {string} key */
    finish(key) {
      busy.delete(key);
    },
    /** @param {string} key */
    isBusy(key) {
      return busy.has(key);
    },
  };
}

/**
 * The cards for the selected job, in order: details, Edit, Note, Attachments, then for a draft
 * Publish and, after it, Cancel (TC lets you cancel a draft). Past DRAFT: Simulate (sandbox) and
 * Cancel, with the Publish card kept (just before them) only while it holds the result of
 * publishing this job.
 * @param {{ status: string }} job
 * @param {{ hasPublishResult?: boolean }} [options]
 * @returns {string[]}
 */
export function cardOrder(job, { hasPublishResult = false } = {}) {
  const cards = ["details", "edit", "note", "attachments"];
  if (job.status === "DRAFT") return [...cards, "publish", "cancel"];
  if (hasPublishResult) cards.push("publish");
  return [...cards, "simulate", "cancel"];
}

/**
 * What the Edit card sends: only the fields that changed. `values` are the form's trimmed strings.
 * Returns { patch } to send, or { notice } to show instead (nothing is sent).
 *
 * The API can change a price but not remove one (price.ex_gst_cents must be above zero), so an
 * emptied price field is refused with that reason rather than being treated as "no change".
 * @param {{ title: string, description: string | null, notes?: string | null, schedule?: { preferred_start_date?: string | null, time_window?: string | null } | null, price?: { ex_gst_cents?: number | null } | null }} job
 * @param {{ title?: string, description?: string, notes?: string, preferred_start_date?: string, time_window?: string, price_dollars?: string, external_reference?: string }} values
 * @returns {{ patch: Record<string, unknown> } | { notice: string }}
 */
export function editPatch(job, values) {
  const v = (name) => (typeof values[name] === "string" ? values[name].trim() : "");
  const patch = {};
  if (v("title") !== job.title) patch.title = v("title");
  if (v("description") !== (job.description ?? "")) patch.description = v("description");
  if (v("notes") !== (job.notes ?? "")) patch.notes = v("notes") || null;
  const schedule = {};
  if (v("preferred_start_date") !== (job.schedule?.preferred_start_date ?? "")) schedule.preferred_start_date = v("preferred_start_date") || null;
  if (v("time_window") !== (job.schedule?.time_window ?? "")) schedule.time_window = v("time_window") || null;
  if (Object.keys(schedule).length) patch.schedule = schedule;
  const currentPrice = typeof job.price?.ex_gst_cents === "number" ? job.price.ex_gst_cents : null;
  if (v("price_dollars")) {
    const cents = Math.round(Number(v("price_dollars")) * 100);
    if (!Number.isFinite(cents)) return { notice: "The price is not a number: nothing was sent." };
    if (cents !== currentPrice) patch.price = { ex_gst_cents: cents };
  } else if (currentPrice !== null) {
    return { notice: "The API can change a price but not remove one, so nothing was sent. Put a price back (or a new one) to send your other changes." };
  }
  if (v("external_reference")) patch.external_reference = v("external_reference");
  if (Object.keys(patch).length === 0) return { notice: "Nothing changed, so nothing was sent. Change a field first." };
  return { patch };
}

/**
 * "Selected job: EX-2026-11-17-ab12cd34 · OPEN", or "Selected job: none".
 * @param {{ external_reference?: string | null, id: string, status: string } | null} job
 */
export function selectedJobTitle(job) {
  if (!job) return "Selected job: none";
  return `Selected job: ${job.external_reference || job.id} · ${job.status}`;
}
