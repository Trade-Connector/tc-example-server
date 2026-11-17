// Stores received webhook events and the latest snapshot of each job, in JSON files under data/.
//
// TC delivers events AT LEAST ONCE and NOT IN ORDER. Two rules follow, and this store applies both:
// 1. Deduplicate on the webhook-id header (it is also the envelope's "id"). A retry or a replay
//    from TC's Deliveries tab carries the same id. A duplicate is recorded (so you can see it)
//    but never processed again.
// 2. Never let an older job overwrite a newer one: compare data.job.updated_at with what you
//    already hold, and keep the newer.
//
// Unknown event types and unknown job statuses are stored and flagged, never dropped.
//
// A real system would use its database for this. A JSON file keeps the example readable.

import path from "node:path";
import { log } from "../log.ts";
import { isKnownJobStatus, type Job } from "../tc/types.ts";
import { isKnownEventType, TEST_EVENT_JOB_ID, type WebhookEnvelope } from "./events.ts";
import { readJsonFile, writeJsonFile } from "../store/json-file.ts";

/** Which receive path the event came in on. TC endpoints are per environment. */
export type ReceiveEnvironment = "sandbox" | "live";

export interface EventFlags {
  /** Same webhook-id seen before on this path: not processed again. */
  duplicate: boolean;
  /** data.job.updated_at is older than the snapshot already held: snapshot left alone. */
  out_of_order: boolean;
  /** data.job.is_sandbox disagrees with the path it arrived on. */
  environment_mismatch: boolean;
  unknown_type: boolean;
  unknown_status: boolean;
  /** webhook.test: carries a dummy job, so it never touches snapshots. */
  test_event: boolean;
}

export interface StoredEvent {
  seq: number;
  received_at: string;
  environment: ReceiveEnvironment;
  verified: boolean;
  /** Why a delivery was refused (verified: false only). */
  rejection: { reason: string; message: string } | null;
  webhook_id: string | null;
  event_type: string | null;
  event_created_at: string | null;
  api_version: string | null;
  job_id: string | null;
  external_reference: string | null;
  job_status: string | null;
  job_updated_at: string | null;
  changes: Record<string, unknown> | null;
  flags: EventFlags;
  /** The body exactly as received (verified deliveries only). */
  raw_body: string | null;
}

export interface JobSnapshot {
  environment: ReceiveEnvironment;
  job: Job;
  last_event_type: string;
  last_webhook_id: string;
  stored_at: string;
}

const NO_FLAGS: EventFlags = {
  duplicate: false,
  out_of_order: false,
  environment_mismatch: false,
  unknown_type: false,
  unknown_status: false,
  test_event: false,
};

const MAX_EVENTS = 2000;
const MAX_SEEN_IDS = 20_000;

interface PersistedEvents {
  next_seq: number;
  events: StoredEvent[];
  seen_ids: string[];
}

export class EventStore {
  readonly #eventsFile: string;
  readonly #snapshotsFile: string;
  #nextSeq = 1;
  #events: StoredEvent[] = [];
  /** `${environment}:${webhook-id}` of every processed delivery. */
  #seen = new Set<string>();
  #snapshots: Record<string, JobSnapshot> = {};
  #listeners = new Set<(event: StoredEvent) => void>();

  private constructor(dataDir: string) {
    this.#eventsFile = path.join(dataDir, "webhook-events.json");
    this.#snapshotsFile = path.join(dataDir, "job-snapshots.json");
  }

  static async open(dataDir: string): Promise<EventStore> {
    const store = new EventStore(dataDir);
    const persisted = await readJsonFile<PersistedEvents>(store.#eventsFile, {
      next_seq: 1,
      events: [],
      seen_ids: [],
    });
    store.#nextSeq = persisted.next_seq;
    store.#events = persisted.events;
    store.#seen = new Set(persisted.seen_ids);
    store.#snapshots = await readJsonFile<Record<string, JobSnapshot>>(store.#snapshotsFile, {});
    return store;
  }

  /** Called for every stored event (the coverage checklist listens). */
  onEvent(listener: (event: StoredEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Records a delivery whose signature has been verified, applying dedupe and ordering.
   * `envelope` is the parsed body; `rawBody` is the exact text that was signed.
   */
  async recordVerified(input: {
    environment: ReceiveEnvironment;
    webhookId: string;
    envelope: WebhookEnvelope;
    rawBody: string;
    receivedAt?: Date;
  }): Promise<StoredEvent> {
    const { environment, webhookId, envelope } = input;
    const job: Job | null =
      envelope?.data && typeof envelope.data.job === "object" ? envelope.data.job : null;
    const type = typeof envelope?.type === "string" ? envelope.type : null;

    const flags: EventFlags = { ...NO_FLAGS };
    const seenKey = `${environment}:${webhookId}`;
    flags.duplicate = this.#seen.has(seenKey);
    flags.unknown_type = !isKnownEventType(type);
    flags.test_event = type === "webhook.test" || job?.id === TEST_EVENT_JOB_ID;
    if (job) {
      flags.unknown_status = !isKnownJobStatus(job.status);
      flags.environment_mismatch =
        typeof job.is_sandbox === "boolean" && job.is_sandbox !== (environment === "sandbox");
    }

    if (flags.unknown_type) log.warn("Webhook with an unknown event type: stored, not processed", { type, webhookId });
    if (flags.unknown_status) log.warn("Webhook job has an unknown status: stored as is", { status: job?.status, webhookId });
    if (flags.environment_mismatch) {
      log.warn("Webhook job.is_sandbox does not match the path it arrived on", {
        path: environment,
        is_sandbox: job?.is_sandbox,
        webhookId,
      });
    }

    if (!flags.duplicate) {
      this.#seen.add(seenKey);
      if (job && !flags.test_event && typeof job.id === "string") {
        flags.out_of_order = !this.#applySnapshot(environment, job, type ?? "unknown", webhookId);
      }
    }

    const event: StoredEvent = {
      seq: this.#nextSeq++,
      received_at: (input.receivedAt ?? new Date()).toISOString(),
      environment,
      verified: true,
      rejection: null,
      webhook_id: webhookId,
      event_type: type,
      event_created_at: typeof envelope?.created_at === "string" ? envelope.created_at : null,
      api_version: typeof envelope?.api_version === "string" ? envelope.api_version : null,
      job_id: typeof job?.id === "string" ? job.id : null,
      external_reference: typeof job?.external_reference === "string" ? job.external_reference : null,
      job_status: typeof job?.status === "string" ? job.status : null,
      job_updated_at: typeof job?.updated_at === "string" ? job.updated_at : null,
      changes:
        envelope?.data && typeof envelope.data.changes === "object" ? envelope.data.changes : null,
      flags,
      raw_body: input.rawBody,
    };
    await this.#append(event);
    return event;
  }

  /** Records a refused delivery (bad signature etc.). The body is NOT kept: it is untrusted. */
  async recordRejected(input: {
    environment: ReceiveEnvironment;
    webhookId: string | null;
    reason: string;
    message: string;
    receivedAt?: Date;
  }): Promise<StoredEvent> {
    const event: StoredEvent = {
      seq: this.#nextSeq++,
      received_at: (input.receivedAt ?? new Date()).toISOString(),
      environment: input.environment,
      verified: false,
      rejection: { reason: input.reason, message: input.message },
      webhook_id: input.webhookId ? input.webhookId.slice(0, 200) : null,
      event_type: null,
      event_created_at: null,
      api_version: null,
      job_id: null,
      external_reference: null,
      job_status: null,
      job_updated_at: null,
      changes: null,
      flags: { ...NO_FLAGS },
      raw_body: null,
    };
    await this.#append(event);
    return event;
  }

  /** Newest first. */
  listEvents(filter: { jobId?: string; afterSeq?: number; limit?: number } = {}): StoredEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), MAX_EVENTS);
    const out: StoredEvent[] = [];
    for (let i = this.#events.length - 1; i >= 0 && out.length < limit; i--) {
      const event = this.#events[i]!;
      if (filter.afterSeq !== undefined && event.seq <= filter.afterSeq) break;
      if (filter.jobId && event.job_id !== filter.jobId) continue;
      out.push(event);
    }
    return out;
  }

  getSnapshot(environment: ReceiveEnvironment, jobId: string): JobSnapshot | null {
    return this.#snapshots[`${environment}:${jobId}`] ?? null;
  }

  /**
   * Keeps the newer of the held snapshot and `job`. Returns false when `job` is older than
   * what is held (an out-of-order delivery), true when it was stored or is the same age.
   */
  #applySnapshot(environment: ReceiveEnvironment, job: Job, type: string, webhookId: string): boolean {
    const key = `${environment}:${job.id}`;
    const held = this.#snapshots[key];
    if (held) {
      const heldMs = Date.parse(held.job.updated_at);
      const incomingMs = Date.parse(job.updated_at);
      if (!Number.isNaN(heldMs) && !Number.isNaN(incomingMs) && incomingMs < heldMs) {
        return false;
      }
    }
    this.#snapshots[key] = {
      environment,
      job,
      last_event_type: type,
      last_webhook_id: webhookId,
      stored_at: new Date().toISOString(),
    };
    void writeJsonFile(this.#snapshotsFile, this.#snapshots).catch((error: Error) =>
      log.error("Could not save job snapshots", { error: error.message }),
    );
    return true;
  }

  async #append(event: StoredEvent): Promise<void> {
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    if (this.#seen.size > MAX_SEEN_IDS) {
      this.#seen = new Set([...this.#seen].slice(-MAX_SEEN_IDS));
    }
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error("Event listener failed", { error: (error as Error).message });
      }
    }
    await writeJsonFile(this.#eventsFile, {
      next_seq: this.#nextSeq,
      events: this.#events,
      seen_ids: [...this.#seen],
    } satisfies PersistedEvents);
  }
}
