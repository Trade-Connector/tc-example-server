// Signs test webhook deliveries exactly as Trade Connector signs them, so the verifier is tested
// against TC's real scheme (Standard Webhooks). The scheme fixes the steps; this file carries
// them out on its own path, separate from src/webhooks/verify.ts: WebCrypto with atob/btoa (TC
// runs on Deno), where verify.ts uses node:crypto. If the two ever disagreed, the tests would fail.
//
// The scheme, as TC applies it:
//   secret        "whsec_" + base64; the HMAC key is the decoded bytes
//   signed text   `${webhook-id}.${webhook-timestamp}.${raw body}`, as UTF-8
//   signature     "v1," + base64(HMAC-SHA256(key, signed text))
//   rotation      while the previous secret is unexpired, its signature follows the current one,
//                 separated by one space (and is left out when the two are identical)
//   body          JSON.stringify of { id, type, created_at, api_version, data: { job, changes } },
//                 where job is the job without `replayed`, plus client_status_label

import { randomBytes } from "node:crypto";
import type { Job } from "../../src/tc/types.ts";

export function makeSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

const SECRET_PREFIX = "whsec_";
const encoder = new TextEncoder();

async function hmacSha256Base64(secret: string, text: string): Promise<string> {
  const decoded = atob(secret.trim().slice(SECRET_PREFIX.length));
  const keyBytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) keyBytes[i] = decoded.charCodeAt(i);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/** One `v1,` signature entry. */
export async function tcSignature(secret: string, webhookId: string, timestamp: number | string, body: string): Promise<string> {
  return `v1,${await hmacSha256Base64(secret, `${webhookId}.${timestamp}.${body}`)}`;
}

/** The secrets an endpoint signs with at `at`: the current one, and the previous one in its window. */
function signingSecrets(params: { secret: string; previousSecret?: string; previousExpiresAt?: Date }, at: Date): string[] {
  const secrets = [params.secret];
  const previousLive = params.previousExpiresAt !== undefined && params.previousExpiresAt.getTime() > at.getTime();
  if (params.previousSecret && previousLive) secrets.push(params.previousSecret);
  return secrets;
}

/** The headers of one delivery, as TC sends them. */
export async function tcHeaders(params: {
  webhookId: string;
  body: string;
  secret: string;
  previousSecret?: string;
  previousExpiresAt?: Date;
  now?: Date;
}): Promise<Record<string, string>> {
  const sentAt = params.now ?? new Date();
  const timestamp = Math.floor(sentAt.getTime() / 1000);
  const entries = await Promise.all(signingSecrets(params, sentAt).map((s) => tcSignature(s, params.webhookId, timestamp, params.body)));
  return {
    "webhook-id": params.webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": [...new Set(entries)].join(" "),
    "user-agent": "TradeConnector-Webhooks/1.0",
    "content-type": "application/json",
  };
}

/** The job as a webhook carries it: no `replayed`, and the endpoint's status label (or null). */
function webhookJob(job: Partial<Job>, statusLabel: string | null | undefined): Record<string, unknown> {
  const carried: Record<string, unknown> = { ...job };
  delete carried.replayed;
  carried.client_status_label = statusLabel ?? null;
  return carried;
}

/** A delivery body (parse-ready object; JSON.stringify it to get the bytes TC signs). */
export function tcEnvelope(params: {
  eventId: string;
  type: string;
  job: Partial<Job> | null;
  changes?: Record<string, unknown>;
  createdAt?: string;
  apiVersion?: string;
  statusLabel?: string | null;
}): Record<string, unknown> {
  return {
    id: params.eventId,
    type: params.type,
    created_at: params.createdAt ?? new Date().toISOString(),
    api_version: params.apiVersion ?? "2026-10-01",
    data: {
      job: params.job ? webhookJob(params.job, params.statusLabel) : null,
      changes: params.changes ?? {},
    },
  };
}

/** A complete, obviously fake sandbox job. */
export function sampleJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "6f1c2a8e-1111-4c4c-9d9d-000000000001",
    customer_id: "0b9e7c11-2222-4a4a-8b8b-000000000002",
    external_reference: "EX-TEST-1",
    status: "OPEN",
    is_sandbox: true,
    creation_pathway: "API",
    title: "Example battery install",
    description: "Example data only",
    notes: null,
    job_type_id: null,
    urgency: "NORMAL",
    urgency_level: 2,
    trade_codes: ["ELECTRICAL"],
    accreditation_ids: [],
    site: {
      address: "12 Example St",
      unit: null,
      suburb: "Exampleton",
      state: "NSW",
      postcode: "2000",
      latitude: null,
      longitude: null,
      access_instructions: null,
    },
    schedule: { preferred_start_date: "2026-11-24", preferred_end_date: null, time_window: "MORNING", estimated_hours: null, scheduled_date: null },
    end_customer: null,
    contacts: [],
    price: {
      currency: "AUD",
      price_source: "MANUAL",
      ex_gst_cents: 150000,
      gst_cents: 15000,
      inc_gst_cents: 165000,
      subtotal_cents: 150000,
      total_cents: 165000,
      upper_ex_gst_cents: null,
      upper_inc_gst_cents: null,
      upper_reprice_at: null,
    },
    assigned_installer: null,
    created_at: "2026-11-17T01:00:00.000Z",
    updated_at: "2026-11-17T01:00:00.000Z",
    cancelled_at: null,
    cancellation_reason: null,
    work_completed_at: null,
    ...overrides,
  };
}
