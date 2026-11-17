// Signs test webhook deliveries the way Trade Connector's webhook dispatcher does.
//
// Written fresh from TC's documented and observed behaviour (not copied). It deliberately uses a
// different code path from src/webhooks/verify.ts — WebCrypto HMAC with atob/btoa, as TC runs on
// Deno — so if the verifier and TC's real signing ever disagreed, these tests would fail.
//
//   secret         "whsec_" + base64 key; key bytes = atob(base64)
//   signed string  `${webhookId}.${timestampSeconds}.${body}`, UTF-8
//   signature      "v1," + btoa(HMAC-SHA256(key, signed string))
//   rotation       while the previous secret is unexpired, a second signature made with it is
//                  appended after one space (unless identical)
//   body           JSON.stringify(envelope), envelope = { id, type, created_at, api_version,
//                  data: { job: { ...job, client_status_label }, changes } }, with any `replayed`
//                  field removed from the job

import { randomBytes } from "node:crypto";
import type { Job } from "../../src/tc/types.ts";

export function makeSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

function keyBytes(secret: string): Uint8Array {
  const binary = atob(secret.trim().slice("whsec_".length));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function tcSignature(secret: string, webhookId: string, timestamp: number | string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`)));
  let binary = "";
  for (const byte of mac) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

export async function tcHeaders(params: {
  webhookId: string;
  body: string;
  secret: string;
  previousSecret?: string;
  previousExpiresAt?: Date;
  now?: Date;
}): Promise<Record<string, string>> {
  const now = params.now ?? new Date();
  const timestamp = Math.floor(now.getTime() / 1000);
  const signatures = [await tcSignature(params.secret, params.webhookId, timestamp, params.body)];
  if (params.previousSecret && params.previousExpiresAt && params.previousExpiresAt.getTime() > now.getTime()) {
    const previous = await tcSignature(params.previousSecret, params.webhookId, timestamp, params.body);
    if (previous !== signatures[0]) signatures.push(previous);
  }
  return {
    "webhook-id": params.webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "user-agent": "TradeConnector-Webhooks/1.0",
    "content-type": "application/json",
  };
}

export function tcEnvelope(params: {
  eventId: string;
  type: string;
  job: Partial<Job> | null;
  changes?: Record<string, unknown>;
  createdAt?: string;
  apiVersion?: string;
  statusLabel?: string | null;
}): Record<string, unknown> {
  let job: Record<string, unknown> | null = null;
  if (params.job) {
    const { replayed: _replayed, ...rest } = params.job;
    job = { ...rest, client_status_label: params.statusLabel ?? null };
  }
  return {
    id: params.eventId,
    type: params.type,
    created_at: params.createdAt ?? new Date().toISOString(),
    api_version: params.apiVersion ?? "2026-10-01",
    data: { job, changes: params.changes ?? {} },
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
