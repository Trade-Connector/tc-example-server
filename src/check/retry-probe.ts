// A one-shot switch for the sandbox check's optional retry test.
//
// When armed for one job, the webhook listener answers 500 to the NEXT verified delivery for that
// job on the SANDBOX path, once, and records it as refused (not as received). TC then retries the
// same webhook-id a minute or more later (in a later batch), and the check expects to see it arrive.
//
// It is narrow on purpose, so real deliveries are never affected:
// - sandbox path only (there is no way to arm it for live);
// - one job id (a job the check has just created);
// - one delivery, then it disarms itself;
// - it expires on its own if nothing arrives;
// - the answer is 500, NEVER 410 (410 makes TC disable the endpoint).

const UUID_FORMAT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** How long an armed probe waits for a delivery before it disarms itself. */
export const RETRY_PROBE_TTL_MS = 10 * 60 * 1000;

export interface RefusedDelivery {
  webhookId: string;
  jobId: string;
  /** clock time (ms) when the 500 was sent */
  at: number;
}

export class RetryProbe {
  readonly #now: () => number;
  #armed: { jobId: string; expiresAt: number } | null = null;
  #refused: RefusedDelivery | null = null;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Arms the probe for one sandbox job. Replaces any earlier arming and forgets the last refusal. */
  arm(jobId: string, ttlMs: number = RETRY_PROBE_TTL_MS): void {
    if (!UUID_FORMAT.test(jobId)) throw new Error("RetryProbe.arm: jobId must be TC's job UUID");
    this.#armed = { jobId: jobId.toLowerCase(), expiresAt: this.#now() + Math.min(ttlMs, RETRY_PROBE_TTL_MS) };
    this.#refused = null;
  }

  disarm(): void {
    this.#armed = null;
  }

  get armed(): boolean {
    if (this.#armed && this.#now() > this.#armed.expiresAt) this.#armed = null;
    return this.#armed !== null;
  }

  /** The delivery it refused, once it has. */
  get refused(): RefusedDelivery | null {
    return this.#refused;
  }

  /**
   * Called by the listener for every VERIFIED delivery. True means "answer 500 to this one now";
   * the probe has then disarmed itself.
   */
  take(environment: string, jobId: unknown, webhookId: string): boolean {
    const armed = this.#armed;
    if (!armed) return false;
    if (this.#now() > armed.expiresAt) {
      this.#armed = null;
      return false;
    }
    if (environment !== "sandbox" || typeof jobId !== "string" || jobId.toLowerCase() !== armed.jobId) return false;
    this.#armed = null;
    this.#refused = { webhookId, jobId: armed.jobId, at: this.#now() };
    return true;
  }
}
