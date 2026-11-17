// Keeps live (production) mode deliberate, and enforces it on the server, not only in the page.
//
// - The console always starts in sandbox. Switching to live needs live mode to be enabled in
//   config AND the user to type LIVE.
// - In live mode, every write needs a one-time confirmation token. The page gets one by sending
//   the exact action it is about to perform, plus the word LIVE typed by the user. The token is
//   bound to that action, that job and a hash of that request body; it works once and expires
//   after two minutes. A write without a matching token is refused before anything reaches TC.

import { createHash, randomBytes } from "node:crypto";

export type ConsoleEnvironment = "sandbox" | "live";

export type LiveAction =
  | "create_job"
  | "update_job"
  | "publish_job"
  | "add_note"
  | "upload_attachment"
  | "cancel_job"
  | "upsert_install";

export const LIVE_ACTIONS: readonly LiveAction[] = [
  "create_job",
  "update_job",
  "publish_job",
  "add_note",
  "upload_attachment",
  "cancel_job",
  "upsert_install",
];

export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const CONFIRM_WORD = "LIVE";

export class GuardError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "GuardError";
    this.status = status;
    this.code = code;
  }
}

/** Canonical JSON (sorted keys) so the same body always hashes the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

export function digestBody(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(body ?? null)))
    .digest("hex");
}

interface PendingConfirmation {
  action: LiveAction;
  target: string;
  digest: string;
  expiresAt: number;
}

export class LiveGuard {
  readonly liveAvailable: boolean;
  readonly liveUnavailableReason: string | null;
  #environment: ConsoleEnvironment = "sandbox";
  #pending = new Map<string, PendingConfirmation>();
  #now: () => number;

  constructor(options: { liveAvailable: boolean; liveUnavailableReason?: string | null; now?: () => number }) {
    this.liveAvailable = options.liveAvailable;
    this.liveUnavailableReason = options.liveUnavailableReason ?? null;
    this.#now = options.now ?? Date.now;
  }

  get environment(): ConsoleEnvironment {
    return this.#environment;
  }

  /** Switches environment. Going to live needs live mode enabled and the word LIVE. */
  switchTo(environment: ConsoleEnvironment, typed?: unknown): void {
    if (environment === "sandbox") {
      this.#environment = "sandbox";
      this.#pending.clear();
      return;
    }
    if (environment !== "live") throw new GuardError(400, "BAD_ENVIRONMENT", "environment must be sandbox or live");
    if (!this.liveAvailable) {
      throw new GuardError(403, "LIVE_NOT_AVAILABLE", this.liveUnavailableReason ?? "Live mode is not enabled.");
    }
    if (typed !== CONFIRM_WORD) {
      throw new GuardError(400, "CONFIRMATION_WORD_REQUIRED", "Type LIVE to switch to live mode.");
    }
    this.#environment = "live";
  }

  /** Issues a one-time token for exactly this action, target and body. Live mode only. */
  issue(input: { action: unknown; target?: unknown; body?: unknown; typed?: unknown }): {
    token: string;
    expires_in_seconds: number;
  } {
    if (this.#environment !== "live") {
      throw new GuardError(409, "NOT_IN_LIVE_MODE", "Confirmations are only needed, and only issued, in live mode.");
    }
    if (!LIVE_ACTIONS.includes(input.action as LiveAction)) {
      throw new GuardError(400, "UNKNOWN_ACTION", "Unknown action for a live confirmation.");
    }
    if (input.typed !== CONFIRM_WORD) {
      throw new GuardError(400, "CONFIRMATION_WORD_REQUIRED", "Type LIVE to confirm a live write.");
    }
    this.#purgeExpired();
    const token = randomBytes(32).toString("base64url");
    this.#pending.set(token, {
      action: input.action as LiveAction,
      target: typeof input.target === "string" ? input.target : "",
      digest: digestBody(input.body),
      expiresAt: this.#now() + CONFIRMATION_TTL_MS,
    });
    return { token, expires_in_seconds: CONFIRMATION_TTL_MS / 1000 };
  }

  /**
   * Call before every write. In sandbox it does nothing. In live mode it refuses unless `token`
   * was issued for exactly this action, target and body; a matching token is used up.
   */
  authorizeWrite(input: { action: LiveAction; target?: string; body?: unknown; token?: string | null }): void {
    if (this.#environment !== "live") return;
    const token = input.token ?? "";
    if (!token) {
      throw new GuardError(428, "LIVE_CONFIRMATION_REQUIRED", "Live writes need a confirmation: type LIVE when asked.");
    }
    const pending = this.#pending.get(token);
    // A presented token is spent even if it does not match, so it cannot be probed.
    this.#pending.delete(token);
    if (!pending || pending.expiresAt < this.#now()) {
      throw new GuardError(403, "LIVE_CONFIRMATION_INVALID", "The live confirmation is unknown, used or expired. Confirm again.");
    }
    if (
      pending.action !== input.action ||
      pending.target !== (input.target ?? "") ||
      pending.digest !== digestBody(input.body)
    ) {
      throw new GuardError(403, "LIVE_CONFIRMATION_MISMATCH", "The live confirmation was issued for a different action. Confirm again.");
    }
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAt < now) this.#pending.delete(token);
    }
  }
}
