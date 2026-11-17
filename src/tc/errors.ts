// Errors returned by the Trade Connector API.
//
// Every TC error has the same shape:
//   { "error_code": "SCOPE_FORBIDDEN",
//     "error": { "code": "SCOPE_FORBIDDEN", "message": "...", "details": {...}?, "request_id": "..." } }
// plus an X-Request-Id header. Quote the request_id to TC support when you report a problem.

export type TcErrorCode =
  | "UNAUTHORIZED"
  | "IP_NOT_ALLOWED"
  | "SCOPE_FORBIDDEN"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "DUPLICATE_EXTERNAL_REFERENCE"
  | "IDEMPOTENCY_KEY_REUSED"
  | "JOB_LOCKED"
  | "PAYMENT_METHOD_REQUIRED"
  | "CLIENT_COMPANY_NOT_ACTIVE"
  | "NOT_A_MANUFACTURER"
  | "FEATURE_DISABLED"
  | "PEPPER_NOT_CONFIGURED"
  | "INTERNAL_ERROR"
  // Not from TC: the response was not TC's JSON error shape (for example a proxy error page),
  // or the request never got an answer.
  | "UNEXPECTED_RESPONSE"
  | "NETWORK_ERROR"
  | (string & {});

export class TcApiError extends Error {
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  readonly code: TcErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** TC's request id (from the body, else the X-Request-Id header). */
  readonly requestId: string | null;
  /** Seconds to wait, from Retry-After on a 429. */
  readonly retryAfterSeconds: number | null;

  constructor(init: {
    status: number;
    code: TcErrorCode;
    message: string;
    details?: Record<string, unknown> | undefined;
    requestId?: string | null;
    retryAfterSeconds?: number | null;
  }) {
    super(init.message);
    this.name = "TcApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }

  /** A short hint for the person reading the error, when the fix is not obvious from TC's message. */
  get hint(): string | null {
    return hintFor(this.code, this.message);
  }

  toJSON() {
    return {
      status: this.status,
      code: this.code,
      message: this.message,
      details: this.details ?? null,
      request_id: this.requestId,
      hint: this.hint,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds a TcApiError from a non-2xx response whose body has already been read as text. */
export function parseTcError(status: number, bodyText: string, headers: Headers): TcApiError {
  const headerRequestId = headers.get("x-request-id");
  const retryAfterSeconds = parseRetryAfter(headers.get("retry-after"));

  let parsed: unknown = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  const err = isRecord(parsed) ? parsed.error : undefined;
  if (isRecord(err) && typeof err.code === "string" && typeof err.message === "string") {
    return new TcApiError({
      status,
      code: err.code,
      message: err.message,
      details: isRecord(err.details) ? err.details : undefined,
      requestId: typeof err.request_id === "string" ? err.request_id : headerRequestId,
      retryAfterSeconds,
    });
  }

  // Not TC's error shape. Keep a short, safe excerpt of the body for debugging.
  const excerpt = bodyText.replace(/\s+/g, " ").trim().slice(0, 200);
  return new TcApiError({
    status,
    code: "UNEXPECTED_RESPONSE",
    message: `HTTP ${status} without a Trade Connector error body${excerpt ? `: ${excerpt}` : ""}`,
    requestId: headerRequestId,
    retryAfterSeconds,
  });
}

/** Retry-After is either a number of seconds or an HTTP date. Returns whole seconds, or null. */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.ceil((dateMs - nowMs) / 1000));
}

/** Plain-English hints for errors whose fix lives outside your code. */
export function hintFor(code: string, message: string): string | null {
  switch (code) {
    case "SCOPE_FORBIDDEN": {
      // TC uses SCOPE_FORBIDDEN both for a missing scope ("API key lacks required scope 'x'")
      // and for a route used from the wrong environment.
      const scope = /lacks required scope '([^']+)'/.exec(message)?.[1];
      if (scope) {
        return `Your API key does not have the '${scope}' scope. New keys get only jobs:read and jobs:write. In the Trade Connector web app, go to Settings → API & Webhooks → API keys and create a key with '${scope}' ticked, then put it in .env.`;
      }
      if (/tc_test_|tc_live_|sandbox|production/i.test(message)) {
        return "This route works in one environment only: sandbox simulate needs a tc_test_ key and a sandbox job; installs need a tc_live_ key.";
      }
      return "Your API key does not allow this call. Check the key's scopes in Settings → API & Webhooks → API keys.";
    }
    case "UNAUTHORIZED":
      return "The key is missing, mistyped, expired or revoked. Check .env, and that the key belongs to this environment (tc_test_ = sandbox, tc_live_ = production).";
    case "IP_NOT_ALLOWED":
      return "The key has an IP allow-list and this machine's address is not on it.";
    case "RATE_LIMITED":
      return "Too many requests for this key in the current minute (default 120). Wait for Retry-After.";
    case "JOB_LOCKED":
      return "The job's status does not allow this change. Jobs can be edited only while DRAFT or OPEN; after that, changes are made in the Trade Connector web app.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "This Idempotency-Key was already used (within 24 hours) with a different body. Use a new key for a new job.";
    case "DUPLICATE_EXTERNAL_REFERENCE":
      return "A job with this external_reference already exists in this environment; details.job_id is that job.";
    case "PAYMENT_METHOD_REQUIRED":
      return "Publishing a live job needs a payment method on the company's Trade Connector account.";
    case "CLIENT_COMPANY_NOT_ACTIVE":
      return "The company is not active yet, so it cannot publish live jobs. Drafts still work.";
    case "NOT_A_MANUFACTURER":
    case "FEATURE_DISABLED":
      return "Installs are only for manufacturer companies with the fleet service turned on.";
    default:
      return null;
  }
}
