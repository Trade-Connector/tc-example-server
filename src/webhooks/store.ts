// Stores received webhook events and the latest snapshot of each job, in JSON files under data/.
//
// TC delivers events AT LEAST ONCE and NOT IN ORDER. Two rules follow, and this store applies both:
// 1. Deduplicate on the webhook-id header (it is also the envelope's "id"). A retry or a replay
//    from TC's Deliveries tab carries the same id. A duplicate is recorded (so you can see it)
//    but never processed again.
// 2. Never let an older job overwrite a newer one: compare data.job.updated_at with what you
//    already hold, and keep the newer. TC's timestamps carry microseconds, and two changes can
//    fall in the same millisecond, so compare at full precision (not with Date.parse).
//
// Nothing is dropped. Unknown event types, and jobs whose is_sandbox disagrees with the path they
// arrived on, are stored and flagged but not processed: they never change a job snapshot.
// Unknown job statuses are stored and processed as they are.
//
// Refused deliveries (bad signature and so on) are kept apart, in a small log of their own, so
// junk sent to the public webhook URL can never push real events out of the event log.
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
  /** data.job.is_sandbox disagrees with the path it arrived on: stored, not processed. */
  environment_mismatch: boolean;
  /** An event type this example does not know: stored, not processed. */
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
/** Refused deliveries kept for the console. Small, so a flood of junk costs little to save. */
export const MAX_REJECTED_DELIVERIES = 200;
const MAX_SEEN_IDS = 20_000;

interface PersistedEvents {
  next_seq: number;
  events: StoredEvent[];
  seen_ids: string[];
}

interface PersistedRejections {
  next_seq: number;
  rejections: StoredEvent[];
}

/**
 * An ISO 8601 timestamp as nanoseconds since 1970, keeping every fractional digit (TC sends
 * microseconds, e.g. "2026-11-17T01:00:00.123456+00:00"). Null when it cannot be parsed.
 */
export function preciseInstant(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  const match = /^(.+T\d{2}:\d{2}:\d{2})(?:[.,](\d+))?(.*)$/.exec(value.trim());
  if (!match) return null;
  const wholeSecondsMs = Date.parse(`${match[1]}${match[3]}`);
  if (Number.isNaN(wholeSecondsMs)) return null;
  const nanos = (match[2] ?? "").slice(0, 9).padEnd(9, "0");
  return BigInt(wholeSecondsMs) * 1_000_000n + BigInt(nanos);
}

export class EventStore {
  readonly #eventsFile: string;
  readonly #rejectionsFile: string;
  readonly #snapshotsFile: string;
  #nextSeq = 1;
  /** Verified deliveries, oldest first. */
  #events: StoredEvent[] = [];
  /** Refused deliveries, oldest first. Shares the seq counter with #events. */
  #rejections: StoredEvent[] = [];
  /** `${environment}:${webhook-id}` of every delivery whose writes have FINISHED. Persisted. */
  #seen = new Set<string>();
  /** Deliveries being written right now. Never persisted, so a restart can't mistake a delivery
   *  that never finished for a done one. Settles (never rejects) when that attempt ends. */
  #inFlight = new Map<string, Promise<void>>();
  #snapshots: Record<string, JobSnapshot> = {};
  #listeners = new Set<(event: StoredEvent) => void>();

  private constructor(dataDir: string) {
    this.#eventsFile = path.join(dataDir, "webhook-events.json");
    this.#rejectionsFile = path.join(dataDir, "webhook-rejections.json");
    this.#snapshotsFile = path.join(dataDir, "job-snapshots.json");
  }

  static async open(dataDir: string): Promise<EventStore> {
    const store = new EventStore(dataDir);
    const persisted = await readJsonFile<PersistedEvents>(store.#eventsFile, {
      next_seq: 1,
      events: [],
      seen_ids: [],
    });
    const rejected = await readJsonFile<PersistedRejections>(store.#rejectionsFile, { next_seq: 1, rejections: [] });
    store.#nextSeq = Math.max(persisted.next_seq, rejected.next_seq);
    store.#events = persisted.events;
    store.#rejections = rejected.rejections;
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
    // If the same webhook-id is being written right now (TC retried or replayed it mid-write), wait for
    // that attempt: if it finished, this one is a duplicate; if it failed, this one does the work.
    for (let pending = this.#inFlight.get(seenKey); pending; pending = this.#inFlight.get(seenKey)) {
      await pending;
    }
    flags.duplicate = this.#seen.has(seenKey);
    flags.unknown_type = !isKnownEventType(type);
    flags.test_event = type === "webhook.test" || job?.id === TEST_EVENT_JOB_ID;
    if (job) {
      flags.unknown_status = !isKnownJobStatus(job.status);
      flags.environment_mismatch =
        typeof job.is_sandbox === "boolean" && job.is_sandbox !== (environment === "sandbox");
    }

    if (flags.unknown_type) log.warn("Webhook with an unknown event type: stored, not processed", { type, webhookId });
    if (flags.unknown_status) log.warn("Webhook job has an unknown status: stored and processed as is", { status: job?.status, webhookId });
    if (flags.environment_mismatch) {
      log.warn("Webhook job.is_sandbox does not match the path it arrived on: stored, not processed", {
        path: environment,
        is_sandbox: job?.is_sandbox,
        webhookId,
      });
    }

    // Processing = updating the job snapshot. Only for a first delivery of a known event type
    // that carries a real job from the right environment.
    let snapshotSaved: Promise<void> = Promise.resolve();
    let settle: () => void = () => {};
    if (!flags.duplicate) {
      this.#inFlight.set(seenKey, new Promise<void>((resolve) => (settle = resolve)));
      const processable = !flags.unknown_type && !flags.environment_mismatch && !flags.test_event;
      if (job && processable && typeof job.id === "string") {
        const applied = this.#applySnapshot(environment, job, type ?? "unknown", webhookId);
        flags.out_of_order = applied === null;
        if (applied) snapshotSaved = applied;
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
    // Write the snapshot change (if any), then the event. The webhook-id counts as "seen" only once
    // both writes have succeeded, and it is persisted with this delivery's own event write, never by
    // another delivery's write while this one is still in flight. If a write fails, the caller answers
    // 500 and TC's retry is processed in full. (Marking an id seen before its work is saved, and
    // persisting that, silently loses the update after a restart.)
    try {
      await snapshotSaved;
      await this.#append(event, flags.duplicate ? null : seenKey);
      if (!flags.duplicate) this.#seen.add(seenKey);
    } finally {
      if (!flags.duplicate) {
        this.#inFlight.delete(seenKey);
        settle();
      }
    }
    return event;
  }

  /**
   * Records a refused delivery (bad signature etc.) in the separate, small rejection log. The body
   * is NOT kept: it is untrusted.
   */
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
    this.#rejections.push(event);
    if (this.#rejections.length > MAX_REJECTED_DELIVERIES) {
      this.#rejections.splice(0, this.#rejections.length - MAX_REJECTED_DELIVERIES);
    }
    this.#notify(event);
    await writeJsonFile(this.#rejectionsFile, {
      next_seq: this.#nextSeq,
      rejections: this.#rejections,
    } satisfies PersistedRejections);
    return event;
  }

  /** Verified and refused deliveries together, newest first (by seq). */
  listEvents(filter: { jobId?: string; afterSeq?: number; limit?: number } = {}): StoredEvent[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), MAX_EVENTS + MAX_REJECTED_DELIVERIES);
    const out: StoredEvent[] = [];
    let i = this.#events.length - 1;
    let j = this.#rejections.length - 1;
    while (out.length < limit && (i >= 0 || j >= 0)) {
      const verified = this.#events[i];
      const refused = this.#rejections[j];
      // Both lists are in seq order: take the newer head of the two.
      const event = !refused || (verified && verified.seq > refused.seq) ? this.#events[i--]! : this.#rejections[j--]!;
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
   * Keeps the newer of the held snapshot and `job`. Returns null when `job` is older than what is
   * held (an out-of-order delivery); otherwise stores it and returns the pending file write.
   */
  #applySnapshot(environment: ReceiveEnvironment, job: Job, type: string, webhookId: string): Promise<void> | null {
    const key = `${environment}:${job.id}`;
    const held = this.#snapshots[key];
    if (held) {
      const heldAt = preciseInstant(held.job.updated_at);
      const incomingAt = preciseInstant(job.updated_at);
      if (heldAt !== null && incomingAt !== null && incomingAt < heldAt) {
        return null;
      }
    }
    this.#snapshots[key] = {
      environment,
      job,
      last_event_type: type,
      last_webhook_id: webhookId,
      stored_at: new Date().toISOString(),
    };
    return writeJsonFile(this.#snapshotsFile, this.#snapshots);
  }

  #notify(event: StoredEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error("Event listener failed", { error: (error as Error).message });
      }
    }
  }

  /** `ownSeenKey`: this delivery's id, saved with its own event so a restart knows it is done. */
  async #append(event: StoredEvent, ownSeenKey: string | null = null): Promise<void> {
    this.#events.push(event);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    if (this.#seen.size > MAX_SEEN_IDS) {
      this.#seen = new Set([...this.#seen].slice(-MAX_SEEN_IDS));
    }
    try {
      await writeJsonFile(this.#eventsFile, {
        next_seq: this.#nextSeq,
        events: this.#events,
        seen_ids: ownSeenKey ? [...this.#seen, ownSeenKey] : [...this.#seen],
      } satisfies PersistedEvents);
    } catch (error) {
      // The caller answers 500 and TC retries this delivery, so don't keep (or show) this attempt:
      // the retry records it. (A write for another delivery that runs in between may still have
      // saved it; the retry then shows as a second, non-duplicate entry. That is harmless here, and a
      // database transaction avoids it in a real system.)
      const index = this.#events.indexOf(event);
      if (index !== -1) this.#events.splice(index, 1);
      throw error;
    }
    // Tell the console only once the event has been written.
    this.#notify(event);
  }
}
