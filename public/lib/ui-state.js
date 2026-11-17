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
 * The cards for the selected job, in order: details, Edit, Note, Attachments, then Publish last
 * for a draft. Past DRAFT: Simulate (sandbox) and Cancel, with the Publish card kept (just before
 * them) only while it holds the result of publishing this job.
 * @param {{ status: string }} job
 * @param {{ hasPublishResult?: boolean }} [options]
 * @returns {string[]}
 */
export function cardOrder(job, { hasPublishResult = false } = {}) {
  const cards = ["details", "edit", "note", "attachments"];
  if (job.status === "DRAFT") return [...cards, "publish"];
  if (hasPublishResult) cards.push("publish");
  return [...cards, "simulate", "cancel"];
}

/**
 * "Selected job: EX-2026-11-17-ab12cd34 · OPEN", or "Selected job: none".
 * @param {{ external_reference?: string | null, id: string, status: string } | null} job
 */
export function selectedJobTitle(job) {
  if (!job) return "Selected job: none";
  return `Selected job: ${job.external_reference || job.id} · ${job.status}`;
}
