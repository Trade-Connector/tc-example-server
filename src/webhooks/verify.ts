// Verifies Trade Connector webhook signatures (the Standard Webhooks scheme,
// https://www.standardwebhooks.com/), exactly as TC signs them:
//
//   secret            whsec_<base64 key bytes>         (shown once when you add the endpoint in TC)
//   signed content    "<webhook-id>.<webhook-timestamp>.<raw body>"
//   signature         base64( HMAC-SHA256(key bytes, signed content) )
//   header            webhook-signature: v1,<signature>
//
// For 24 hours after you rotate an endpoint's secret, TC signs every delivery with BOTH the new
// and the old secret and sends both, separated by a space: "v1,<new> v1,<old>". Accept the
// delivery if ANY entry matches the secret you hold.
//
// Rules this file follows, and your receiver should too:
// 1. Verify the RAW request bytes. Parsing the JSON and serialising it again changes the bytes
//    (spacing, key order, unicode escapes) and the signature no longer matches.
// 2. Compare in constant time (crypto.timingSafeEqual), never with === on strings.
// 3. Refuse timestamps more than 5 minutes from your clock, so a captured delivery cannot be
//    replayed later.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SECRET_PREFIX = "whsec_";
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export type VerifyFailure =
  | "missing_headers"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "no_matching_signature";

export type VerifyResult =
  | { ok: true; webhookId: string; timestamp: number }
  | { ok: false; reason: VerifyFailure; message: string };

/** Header lookup that works for Node's IncomingHttpHeaders (lower-case keys) and for Headers. */
export type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Decodes a `whsec_…` secret into the HMAC key bytes. Throws if it is not a valid secret, so
 * call it at start-up to catch a mistyped secret before the first delivery arrives.
 */
export function decodeWebhookSecret(secret: string): Buffer {
  const trimmed = (secret ?? "").trim();
  if (!trimmed.startsWith(SECRET_PREFIX)) {
    throw new Error("Webhook secret must start with 'whsec_'");
  }
  const b64 = trimmed.slice(SECRET_PREFIX.length);
  // Strict base64, as TC checks it. Buffer.from() alone would silently skip bad characters.
  if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("Webhook secret is not valid base64 after 'whsec_'");
  }
  const key = Buffer.from(b64, "base64");
  if (key.length === 0) throw new Error("Webhook secret decodes to zero bytes");
  return key;
}

/** Computes the expected signature bytes for one delivery. */
export function computeSignature(
  key: Buffer,
  webhookId: string,
  timestamp: string,
  rawBody: Buffer | Uint8Array | string,
): Buffer {
  const hmac = createHmac("sha256", key);
  hmac.update(`${webhookId}.${timestamp}.`, "utf8");
  hmac.update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody);
  return hmac.digest();
}

export interface VerifyOptions {
  /** The endpoint's `whsec_…` secret, or its already-decoded key bytes. */
  secret: string | Buffer;
  headers: HeaderSource;
  /** The request body exactly as received. */
  rawBody: Buffer | Uint8Array | string;
  /** Defaults to the current time. */
  nowSeconds?: number;
  /** Defaults to 300 seconds. */
  toleranceSeconds?: number;
}

/** Verifies one webhook delivery. Never throws for a bad delivery; returns { ok: false } instead. */
export function verifyWebhook(options: VerifyOptions): VerifyResult {
  const key = typeof options.secret === "string" ? decodeWebhookSecret(options.secret) : options.secret;

  const webhookId = header(options.headers, "webhook-id");
  const timestampHeader = header(options.headers, "webhook-timestamp");
  const signatureHeader = header(options.headers, "webhook-signature");
  if (!webhookId || !timestampHeader || !signatureHeader) {
    return {
      ok: false,
      reason: "missing_headers",
      message: "webhook-id, webhook-timestamp and webhook-signature headers are required",
    };
  }

  if (!/^\d+$/.test(timestampHeader)) {
    return { ok: false, reason: "invalid_timestamp", message: "webhook-timestamp must be Unix seconds" };
  }
  const timestamp = Number(timestampHeader);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) {
    return {
      ok: false,
      reason: "timestamp_out_of_tolerance",
      message: `webhook-timestamp is more than ${tolerance} seconds from this server's clock (check the clock, or this is a replay)`,
    };
  }

  const expected = computeSignature(key, webhookId, timestampHeader, options.rawBody);

  // "v1,<sig>" entries separated by spaces. Ignore entries for other versions or that are malformed.
  for (const entry of signatureHeader.trim().split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
    const candidate = Buffer.from(entry.slice(comma + 1), "base64");
    // timingSafeEqual throws on different lengths, so check the length first.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true, webhookId, timestamp };
    }
  }

  return {
    ok: false,
    reason: "no_matching_signature",
    message: "No v1 signature matched. Is the secret in .env the signing secret of THIS endpoint in TC?",
  };
}
