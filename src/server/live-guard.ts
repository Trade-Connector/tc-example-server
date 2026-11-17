// Keeps live (production) mode deliberate, and enforces it on the server, not only in the page.
//
// - The console always starts in sandbox. Switching to live needs live mode to be enabled in
//   config AND the user to type LIVE.
// - In live mode, every write needs a one-time confirmation token. The page gets one by sending
//   the exact action it is about to perform, plus the word LIVE typed by the user. The token is
//   bound to that action, that job and a fingerprint of that request body; it works once and
//   expires after two minutes. A write without a matching token is refused before anything
//   reaches TC.
// - Each write is checked against the environment its TC client was built for (and so the key it
//   holds), not only the console's current mode. If the two differ, the console switched while
//   the request was being handled, and the write is refused.

import { createHash, randomBytes, type Hash } from "node:crypto";

export type ConsoleEnvironment = "sandbox" | "live";

export const LIVE_ACTIONS = [
  "create_job",
  "update_job",
  "publish_job",
  "add_note",
  "upload_attachment",
  "cancel_job",
  "upsert_install",
] as const;

export type LiveAction = (typeof LIVE_ACTIONS)[number];

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

function isLiveAction(value: unknown): value is LiveAction {
  return (LIVE_ACTIONS as readonly unknown[]).includes(value);
}

// ---------------------------------------------------------------------------------------------
// Body fingerprints
// ---------------------------------------------------------------------------------------------

/**
 * SHA-256 of a request body, independent of key order: the body is serialised straight into the
 * hash with object keys sorted. Properties whose value is undefined are skipped and everything
 * else is written as JSON writes it, so `{a:1,b:2}` and `{b:2,a:1}` match and `{a:1}` and
 * `{a:"1"}` do not.
 */
export function bodyFingerprint(body: unknown): string {
  const hash = createHash("sha256");
  feed(hash, body);
  return hash.digest("hex");
}

function feed(hash: Hash, value: unknown): void {
  if (Array.isArray(value)) {
    hash.update("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) hash.update(",");
      feed(hash, value[i]);
    }
    hash.update("]");
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    hash.update("{");
    let separator = "";
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      hash.update(`${separator}${JSON.stringify(key)}:`);
      feed(hash, record[key]);
      separator = ",";
    }
    hash.update("}");
  } else {
    // A missing body, or undefined inside an array, counts as null (as in JSON).
    hash.update(JSON.stringify(value) ?? "null");
  }
}

// ---------------------------------------------------------------------------------------------
// Outstanding confirmations
// ---------------------------------------------------------------------------------------------

/** What one confirmation token allows: one action, on one target, with one exact body. */
interface Permit {
  action: LiveAction;
  target: string;
  fingerprint: string;
  expiresAt: number;
}

/** One-time tokens and what each allows. A token can be taken out once only. */
class PermitBook {
  readonly #permits = new Map<string, Permit>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  add(permit: Omit<Permit, "expiresAt">): string {
    this.#dropExpired();
    const token = randomBytes(32).toString("base64url");
    this.#permits.set(token, { ...permit, expiresAt: this.#now() + CONFIRMATION_TTL_MS });
    return token;
  }

  /** Removes the token and returns its permit if it is still valid. Used or unknown → null. */
  takeOut(token: string): Permit | null {
    const permit = this.#permits.get(token) ?? null;
    this.#permits.delete(token);
    if (!permit || permit.expiresAt < this.#now()) return null;
    return permit;
  }

  clear(): void {
    this.#permits.clear();
  }

  #dropExpired(): void {
    const now = this.#now();
    for (const [token, permit] of this.#permits) {
      if (permit.expiresAt < now) this.#permits.delete(token);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------

export interface WriteCheck {
  /** The environment the TC client for this call was built for (it holds that key). */
  environment: ConsoleEnvironment;
  action: LiveAction;
  target?: string;
  body?: unknown;
  /** The X-Live-Confirmation header, if any. */
  token?: string | null;
}

export class LiveGuard {
  readonly liveAvailable: boolean;
  readonly liveUnavailableReason: string | null;
  #mode: ConsoleEnvironment = "sandbox";
  readonly #permits: PermitBook;

  constructor(options: { liveAvailable: boolean; liveUnavailableReason?: string | null; now?: () => number }) {
    this.liveAvailable = options.liveAvailable;
    this.liveUnavailableReason = options.liveUnavailableReason ?? null;
    this.#permits = new PermitBook(options.now ?? Date.now);
  }

  /** The console's current mode. */
  get environment(): ConsoleEnvironment {
    return this.#mode;
  }

  /** Back to sandbox: always allowed, and every outstanding confirmation is forgotten. */
  #leaveLive(): void {
    this.#mode = "sandbox";
    this.#permits.clear();
  }

  /** Switches mode. Going to live needs live mode enabled and the word LIVE. */
  switchTo(environment: ConsoleEnvironment, typed?: unknown): void {
    switch (environment) {
      case "sandbox":
        this.#leaveLive();
        return;
      case "live":
        if (!this.liveAvailable) {
          throw new GuardError(403, "LIVE_NOT_AVAILABLE", this.liveUnavailableReason ?? "Live mode is not enabled.");
        }
        if (typed !== CONFIRM_WORD) {
          throw new GuardError(400, "CONFIRMATION_WORD_REQUIRED", "Type LIVE to switch to live mode.");
        }
        this.#mode = "live";
        return;
      default:
        throw new GuardError(400, "BAD_ENVIRONMENT", "environment must be sandbox or live");
    }
  }

  /** Issues a one-time token for exactly this action, target and body. Live mode only. */
  issue(request: { action: unknown; target?: unknown; body?: unknown; typed?: unknown }): {
    token: string;
    expires_in_seconds: number;
  } {
    if (this.#mode !== "live") {
      throw new GuardError(409, "NOT_IN_LIVE_MODE", "Confirmations are only needed, and only issued, in live mode.");
    }
    if (!isLiveAction(request.action)) {
      throw new GuardError(400, "UNKNOWN_ACTION", "Unknown action for a live confirmation.");
    }
    if (request.typed !== CONFIRM_WORD) {
      throw new GuardError(400, "CONFIRMATION_WORD_REQUIRED", "Type LIVE to confirm a live write.");
    }
    const token = this.#permits.add({
      action: request.action,
      target: typeof request.target === "string" ? request.target : "",
      fingerprint: bodyFingerprint(request.body),
    });
    return { token, expires_in_seconds: CONFIRMATION_TTL_MS / 1000 };
  }

  /**
   * Call before every write, with the environment the call's TC client was built for.
   * - That environment differs from the console's mode: refused (409), nothing is sent.
   * - Sandbox: allowed.
   * - Live: allowed only with a token issued for exactly this action, target and body. A
   *   presented token is used up even when it does not match, so tokens cannot be probed.
   */
  authorizeWrite(check: WriteCheck): void {
    if (check.environment !== this.#mode) {
      throw new GuardError(
        409,
        "ENVIRONMENT_CHANGED",
        `The console switched to ${this.#mode} mode while this ${check.environment} request was being handled. Nothing was sent to TC. Reload the page and try again.`,
      );
    }
    if (check.environment === "sandbox") return;

    if (!check.token) {
      throw new GuardError(428, "LIVE_CONFIRMATION_REQUIRED", "Live writes need a confirmation: type LIVE when asked.");
    }
    const permit = this.#permits.takeOut(check.token);
    if (!permit) {
      throw new GuardError(403, "LIVE_CONFIRMATION_INVALID", "The live confirmation is unknown, used or expired. Confirm again.");
    }
    const matches =
      permit.action === check.action &&
      permit.target === (check.target ?? "") &&
      permit.fingerprint === bodyFingerprint(check.body);
    if (!matches) {
      throw new GuardError(403, "LIVE_CONFIRMATION_MISMATCH", "The live confirmation was issued for a different action. Confirm again.");
    }
  }
}
