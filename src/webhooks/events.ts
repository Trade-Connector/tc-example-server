// The webhook event types TC sends, and what each one carries.
//
// Every delivery is a JSON envelope:
//   {
//     "id": "<event uuid>",            // same value as the webhook-id header
//     "type": "job.status_changed",
//     "created_at": "<ISO 8601>",
//     "api_version": "2026-10-01",
//     "data": {
//       "job": { ...the Job object, plus client_status_label... },   // null never happens for job events
//       "changes": { "job_status": { "from": "OPEN", "to": "ASSIGNED" } }
//     }
//   }
//
// data.changes holds { from, to } pairs for the fields that changed. One exception:
// data.changes.reason is a plain string, present when TC changed the job for a stated reason.

import type { Job } from "../tc/types.ts";

export const KNOWN_EVENT_TYPES = [
  "job.created",
  "job.status_changed",
  "job.assigned",
  "job.scheduled",
  "job.rescheduled",
  "job.completed",
  "job.evidence_ready",
  "job.price_changed",
  "job.cancelled",
  "webhook.test",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];
export type EventType = KnownEventType | (string & {});

export function isKnownEventType(value: unknown): value is KnownEventType {
  return typeof value === "string" && (KNOWN_EVENT_TYPES as readonly string[]).includes(value);
}

export interface WebhookEnvelope {
  id: string;
  type: EventType;
  created_at: string;
  api_version: string;
  data: {
    job: Job | null;
    changes: Record<string, unknown>;
  };
}

/** How to make each event happen, for the console's coverage checklist. */
export interface EventInfo {
  type: KnownEventType;
  firesWhen: string;
  /** Can a tc_test_ key make it happen through the API alone? */
  sandboxApi: boolean;
  howToTrigger: string;
}

// Worked out from TC's event triggers, not only its docs. Notable: sandbox simulate DOES produce
// job.assigned, job.scheduled, job.completed and job.evidence_ready, because those fire on the
// status change itself, not only when a real installer is involved.
export const EVENT_INFO: readonly EventInfo[] = [
  {
    type: "job.created",
    firesWhen: "A job is created, through the API or on the TC website.",
    sandboxApi: true,
    howToTrigger: "Create a job (draft or published).",
  },
  {
    type: "job.status_changed",
    firesWhen: "Any status change. changes.job_status has from and to.",
    sandboxApi: true,
    howToTrigger: "Publish a draft, run any simulate step, or cancel.",
  },
  {
    type: "job.assigned",
    firesWhen: "An installer is assigned, or the status becomes ASSIGNED.",
    sandboxApi: true,
    howToTrigger: "Simulate ASSIGNED. In sandbox no installer is attached, so data.job.assigned_installer stays null.",
  },
  {
    type: "job.scheduled",
    firesWhen: "A date is booked for the first time (or the status becomes SCHEDULED).",
    sandboxApi: true,
    howToTrigger: "Simulate SCHEDULED. scheduled_date becomes the preferred start date, or tomorrow.",
  },
  {
    type: "job.rescheduled",
    firesWhen: "A booked date or time window changes on an already scheduled job.",
    sandboxApi: false,
    howToTrigger:
      "Cannot be done through the API: a scheduled job is locked to PATCH and simulate cannot reschedule. Change the booked date or window of a SCHEDULED job in the TC web app (ask TC to do it on the demo company's job), or use Send test event to check delivery only.",
  },
  {
    type: "job.completed",
    firesWhen: "The status becomes WORK_COMPLETE. (PAID arrives as a status change only.)",
    sandboxApi: true,
    howToTrigger: "Simulate WORK_COMPLETE.",
  },
  {
    type: "job.evidence_ready",
    firesWhen:
      "The status becomes WORK_COMPLETE, or completion evidence or serials are added later. At most once per job per 15 minutes; no file links.",
    sandboxApi: true,
    howToTrigger: "Simulate WORK_COMPLETE (it arrives alongside job.completed).",
  },
  {
    type: "job.price_changed",
    firesWhen: "The job's client total or GST changes.",
    sandboxApi: true,
    howToTrigger:
      "Not by simulate. Edit a DRAFT or OPEN job and send a different price (ex GST); this changes the total. If no event arrives, TC can change the price on the demo company's job in the web app.",
  },
  {
    type: "job.cancelled",
    firesWhen: "The job is cancelled. changes includes cancellation_reason.",
    sandboxApi: true,
    howToTrigger: "Cancel the job, or simulate CANCELLED.",
  },
  {
    type: "webhook.test",
    firesWhen: "Someone presses Send test event on the endpoint in TC.",
    sandboxApi: false,
    howToTrigger:
      "In the TC web app: Settings → API & Webhooks → Webhooks → your endpoint → Send test event. The job inside is a dummy (id 00000000-…).",
  },
];

/** The dummy job id used by webhook.test. */
export const TEST_EVENT_JOB_ID = "00000000-0000-0000-0000-000000000000";
