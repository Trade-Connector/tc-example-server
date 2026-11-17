# Trade Connector Partner API v1: integration guide

This guide explains how to connect your system to Trade Connector (TC): sending jobs in, and hearing back as each
job moves along. It describes the API as it actually behaves. Where TC's published OpenAPI document differs, this
guide says so (see [Known differences from the published OpenAPI document](#known-differences-from-the-published-openapi-document)).

The code in this repository is a working example of everything here.

**Contents**

1. [How it fits together](#how-it-fits-together)
2. [Keys, scopes and environments](#keys-scopes-and-environments)
3. [Conventions](#conventions)
4. [Errors](#errors)
5. [Jobs](#jobs)
6. [Statuses, and what can change when](#statuses-and-what-can-change-when)
7. [Cancelling a job](#cancelling-a-job)
8. [Notes](#notes)
9. [Attachments](#attachments)
10. [Reference data](#reference-data)
11. [Sandbox simulation](#sandbox-simulation)
12. [Webhooks](#webhooks)
13. [Installs (manufacturers)](#installs-manufacturers)
14. [Request log](#request-log)
15. [What v1 does not do](#what-v1-does-not-do)
16. [Known differences from the published OpenAPI document](#known-differences-from-the-published-openapi-document)

## How it fits together

- **Jobs in (the API).** Your system creates jobs, changes them while they are still a draft or looking for an
  installer, adds notes and files, and cancels them.
- **Updates out (webhooks).** TC sends your system an HTTPS POST each time something happens to one of your jobs:
  an installer accepts it, a date is booked, work is complete, it is cancelled.
- Everything else about the job (finding and vetting installers, scheduling, approvals, payment) happens in TC.
  Your staff still use the TC web app for decisions such as approving quotes and variations.

Base URL: TC gives you the address. The example configuration uses
`https://api.tradeconnector.com.au/functions/v1/partner-api`; every path below is added to it, for example
`GET {base}/v1/health`.

## Keys, scopes and environments

**Keys.** A company admin creates keys in the TC web app: Settings → API & Webhooks → API keys.

- A key looks like `tc_test_` or `tc_live_` followed by 48 hexadecimal characters.
- `tc_test_` keys work in the **sandbox**; `tc_live_` keys work in **production**.
- The key is shown once. TC stores only a hash.
- At most two keys can be active per environment, so you can rotate without downtime: create the new key, deploy
  it, then revoke the old one.
- A key can have an expiry date and an IP allow-list (calls from other addresses get `403 IP_NOT_ALLOWED`).
- Revoking a key takes effect immediately.

**Scopes.** Each key carries scopes. A call outside them gets `403 SCOPE_FORBIDDEN`.

| Scope | Allows |
| --- | --- |
| `jobs:read` | `GET /v1/jobs`, `GET /v1/jobs/{id}` |
| `jobs:write` | `POST /v1/jobs`, `PATCH /v1/jobs/{id}`, `POST /v1/jobs/{id}/notes`, sandbox simulate |
| `jobs:cancel` | `POST /v1/jobs/{id}/cancel` |
| `attachments:write` | `POST /v1/jobs/{id}/attachments` and `.../attachments/{attachment_id}/complete` |
| `reference:read` | `GET /v1/reference/job-types`, `/trade-types`, `/accreditations` |
| `installs:read` | `GET /v1/installs`, `GET /v1/installs/{serial}` (production keys, manufacturers) |
| `installs:write` | `POST /v1/installs` (production keys, manufacturers) |
| `webhooks:manage` | Reserved. Webhooks are managed in the web app; there is no API route for them in v1. |

**A new key gets only `jobs:read` and `jobs:write`.** Tick the others when you create the key. In particular,
reference data needs `reference:read`: without it, those routes answer `403 SCOPE_FORBIDDEN` with the message
`API key lacks required scope 'reference:read'`.

**Environments.** Sandbox and production are completely separate: jobs, external references and webhook
endpoints. A sandbox key cannot see production jobs, and the other way round (a job in the other environment
answers `404`). Sandbox jobs never reach a real installer: they are invisible to trades, never offered, never
paid, need no payment method, and always cancel free.

## Conventions

| Topic | Rule |
| --- | --- |
| Authentication | `Authorization: Bearer tc_test_…` (or `tc_live_…`). `X-API-Key: <key>` is also accepted. |
| Format | JSON over HTTPS. Request bodies are strict: an unknown field is refused with `400 VALIDATION_ERROR`. Maximum body 256 KB. |
| Open routes | `GET /v1/health` (`{"status":"ok","version":"v1"}`) and `GET /v1/openapi.json` need no key. |
| Job ids | `{id}` is TC's UUID, or `ext:<your external_reference>` (URL-encode the reference; 1 to 255 characters). Example: `GET /v1/jobs/ext:WO-10042`. |
| Idempotency | Send an `Idempotency-Key` header (1 to 255 characters) on `POST /v1/jobs`. Keys are kept for 24 hours, per API key. The same key with the same body returns the original job with `200`, the header `Idempotent-Replayed: true` and `"replayed": true`. The same key with a different body returns `422 IDEMPOTENCY_KEY_REUSED`. |
| External reference | Your own job number. Unique per environment: a duplicate returns `409 DUPLICATE_EXTERNAL_REFERENCE` with `details.job_id` set to the existing job. It cannot be changed once set. |
| Rate limit | 120 requests per minute per key by default (a fixed 60-second window). Every response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (Unix seconds). A `429` adds `Retry-After` (seconds). The limit is checked before the request runs, so retrying after the wait is always safe. |
| Pagination | Keyset. `limit` 1 to 100 (default 20). The response is `{ "data": [...], "has_more": true, "next_cursor": "..." }`, newest change first (by `updated_at`). Pass `next_cursor` back as `cursor`; it contains a `|`, so URL-encode it. |
| Syncing | Poll `GET /v1/jobs?updated_since=<ISO 8601>` (inclusive) and page through. |
| Money | Integer cents, Australian dollars. GST is 10%. |
| Times | Timestamps are ISO 8601 in UTC. Schedule dates are plain `YYYY-MM-DD`. `time_window` is site local time with no time zone. |
| Request id | Every response has an `X-Request-Id` header (and errors repeat it as `error.request_id`). Quote it to TC support. |

## Errors

Every error has the same shape:

```json
{
  "error_code": "VALIDATION_ERROR",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "site.postcode: postcode must be a 4-digit Australian postcode",
    "details": { "issues": [{ "path": "site.postcode", "message": "...", "code": "invalid_format" }] },
    "request_id": "0f9c0c1e-…"
  }
}
```

`details` is present only when there is something useful in it.

| HTTP | `error.code` | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | The request is malformed: a missing or unknown field, a bad value, a bad query parameter, or a rule such as "an external reference cannot be changed". Schema problems list `details.issues`. Upper-budget problems carry `details.reason_code`. | Fix the request. Do not retry unchanged. |
| 401 | `UNAUTHORIZED` | Missing, mistyped, expired or revoked key. Unknown routes also answer 401 when no valid key is sent. | Check the key and its environment. |
| 402 | `PAYMENT_METHOD_REQUIRED` | Publishing a production job without a payment method on the company's TC account. | Add a payment method in the web app. |
| 403 | `SCOPE_FORBIDDEN` | The key lacks the scope, or the route belongs to the other environment (simulate needs a test key; installs need a live key). | Create a key with the scope ticked, or use the right key. |
| 403 | `IP_NOT_ALLOWED` | The key has an IP allow-list and this address is not on it. | Call from an allowed address, or change the list. |
| 403 | `CLIENT_COMPANY_NOT_ACTIVE` | The company is not active, so it cannot publish production jobs. Drafts still work. | Ask TC. |
| 403 | `NOT_A_MANUFACTURER`, `FEATURE_DISABLED` | Installs routes, for a company that is not a manufacturer or does not have the service. | Ask TC. |
| 404 | `NOT_FOUND` | No such job (or it belongs to another company or environment), or no such route. | Check the id and the environment. |
| 409 | `JOB_LOCKED` | The job's status does not allow this change (see [statuses](#statuses-and-what-can-change-when)). | Make the change in the TC web app. |
| 409 | `DUPLICATE_EXTERNAL_REFERENCE` | That external reference is already used in this environment. `details.job_id` is the existing job. | Use that job, or a new reference. |
| 413 | `PAYLOAD_TOO_LARGE` | The body is over 256 KB. | Send less. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | The idempotency key was used in the last 24 hours with a different body. | Use a new key for a new job. |
| 422 | `VALIDATION_ERROR` | Attachment completion: the stored file's type, size or file signature does not match. The file is deleted. | Upload again with the correct type. |
| 429 | `RATE_LIMITED` | Over the per-minute limit. | Wait `Retry-After` seconds, then retry. |
| 500 | `INTERNAL_ERROR` | Something went wrong at TC. | Retry later; report the `request_id` if it persists. |
| 503 | `PEPPER_NOT_CONFIGURED` | Installs writes are temporarily unavailable. | Ask TC. |

## Jobs

### Create: `POST /v1/jobs` (`jobs:write`)

Returns `201` with the job (or `200` for an idempotent replay).

| Field | Type and rules |
| --- | --- |
| `title` * | 1 to 255 characters |
| `description` * | 1 to 10,000 characters |
| `site` * | `address` * (up to 500), `unit`, `suburb` *, `state` * (`NSW`, `VIC`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`), `postcode` * (4 digits), `latitude`, `longitude`, `access_instructions` (up to 2,000) |
| `external_reference` | Your job number, 1 to 255 characters, unique per environment, cannot be changed once set |
| `job_type_id` | An id from `/v1/reference/job-types` |
| `trade_codes` | 1 to 20 codes from `/v1/reference/trade-types`; the first is the primary trade |
| `accreditation_ids` | Up to 50 UUIDs from `/v1/reference/accreditations` |
| `schedule` | `preferred_start_date`, `preferred_end_date` (not before the start), `time_window` (`MORNING`, `AFTERNOON`, `FULL_DAY`, `HH:MM-HH:MM` or `HH:MM`), `estimated_hours` |
| `urgency` | 1 to 5, or `LOW`, `NORMAL` (default), `HIGH`, `URGENT`, `EMERGENCY` |
| `end_customer` | `name`, `email`, `phone` |
| `contacts` | Up to 20 site contacts: `name` *, `email`, `phone`, `role` (`SITE_OWNER`, `PROPERTY_MANAGER`, `TENANT`, `OTHER`). The first is the primary contact. |
| `price` | `ex_gst_cents` (your price ex GST; TC adds GST at 10%). Optional `upper_ex_gst_cents`: an upper budget, greater than `ex_gst_cents`, under which TC may accept a trade's quote automatically. |
| `notes` | Up to 10,000 characters, internal to your company |
| `publish` | `false` (default) saves a `DRAFT`. `true` creates it `OPEN`, live to installers. |

```sh
curl -X POST "$BASE/v1/jobs" \
  -H "Authorization: Bearer $TC_KEY" \
  -H "Idempotency-Key: WO-10042-create" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Battery install",
    "description": "Battery and gateway on an existing solar system",
    "external_reference": "WO-10042",
    "trade_codes": ["ELECTRICAL"],
    "site": { "address": "12 Example St", "suburb": "Exampleton", "state": "NSW", "postcode": "2000" },
    "schedule": { "preferred_start_date": "2026-11-24", "time_window": "MORNING" },
    "contacts": [{ "name": "Alex Example", "phone": "0400 000 000", "role": "SITE_OWNER" }],
    "publish": true
  }'
```

### The job object

Every job route returns it, and every webhook carries it as `data.job`.

| Field | Notes |
| --- | --- |
| `id`, `customer_id` | TC's ids |
| `external_reference` | Yours, or null |
| `status` | See [statuses](#statuses-and-what-can-change-when). Treat unknown values gracefully. |
| `is_sandbox` | `true` for sandbox jobs |
| `creation_pathway` | How the job was created, e.g. `API` |
| `title`, `description`, `notes`, `job_type_id`, `trade_codes`, `accreditation_ids` | As sent |
| `urgency`, `urgency_level` | `NORMAL` and `2`, for example |
| `site` | As sent |
| `schedule` | As sent, plus `scheduled_date` once a date is booked |
| `end_customer`, `contacts` | Contacts gain `id` and `is_primary` |
| `price` | `currency` (`AUD`), `price_source`, `ex_gst_cents`, `gst_cents`, `inc_gst_cents`, `subtotal_cents`, `total_cents`, `upper_ex_gst_cents`, `upper_inc_gst_cents`, `upper_reprice_at` (all integers in cents or null; `upper_reprice_at` is always null in the sandbox) |
| `assigned_installer` | `{ company_name, accreditations: [{ name, issuing_body, number, expiry }] }` once an installer is assigned, else null. No installer contact details are shared. |
| `replayed` | `true` only on an idempotent replay of a create. Not present in webhooks. |
| `created_at`, `updated_at`, `cancelled_at`, `cancellation_reason`, `work_completed_at` | Timestamps |

### Read: `GET /v1/jobs/{id}` and `GET /v1/jobs` (`jobs:read`)

The list takes `status` (one, or several comma-separated), `external_reference`, `updated_since` (ISO 8601,
inclusive), `cursor` and `limit`. Unknown query parameters are refused.

### Update: `PATCH /v1/jobs/{id}` (`jobs:write`)

- Same fields as create, all optional. Send only what changes.
- **Only while the job is `DRAFT` or `OPEN`.** After that TC answers `409 JOB_LOCKED`, and changes are made in
  the TC web app, so the installer always works from one agreed version.
- `contacts` replaces the whole list. `null` clears `contacts` or `schedule`.
- `price` must always include `ex_gst_cents`. A new price normally changes the job's total and sends a
  `job.price_changed` webhook.
- `external_reference` can be set only while the job has none. Sending it when the job already has one is
  refused with `VALIDATION_ERROR`, even if it is the same value, so leave it out of updates.
- `publish: true` moves a `DRAFT` to `OPEN`. A job cannot be unpublished.

## Statuses, and what can change when

| Status | Meaning | Edit (PATCH) | Cancel | Attachments | Notes |
| --- | --- | --- | --- | --- | --- |
| `DRAFT` | Saved, not sent to installers | yes | yes, free | yes | yes |
| `OPEN` | Live, finding an installer | yes | yes, free | yes | yes |
| `OFFERED` | Offered to an installer, awaiting acceptance | no | yes, free | yes | yes |
| `ASSIGNED` | An installer accepted | no | yes, fee rules apply | yes | yes |
| `SCHEDULED` | A date is booked | no | yes, fee rules apply | yes | yes |
| `IN_PROGRESS` | Work started on site | no | yes, fee rules apply | yes | yes |
| `WORK_COMPLETE` | Finished, evidence uploaded | no | no (409) | yes | yes |
| `PENDING_CUSTOMER_SIG` | Waiting for the end customer's sign-off | no | see note | yes | yes |
| `PAID` | Settled | no | no (409) | no (409) | yes |
| `CANCELLED` | Cancelled | no | no (409) | no (409) | yes |
| `DISPUTED` | Under dispute with TC | no | no (409) | yes | yes |

Note on `PENDING_CUSTOMER_SIG`: TC's cancel rules do not currently list it as final, so a cancel is not refused
with 409. Treat a job awaiting sign-off as finished work and do not cancel it through the API; ask TC instead.

New statuses may appear. Store unknown values as they are and do not fail on them.

## Cancelling a job

`POST /v1/jobs/{id}/cancel` (`jobs:cancel`), with an optional body `{"reason": "..."}` (up to 2,000 characters).

This uses the same rules as cancelling on the TC website, and **any fee is charged automatically**:

- **No fee** before an installer is assigned, or while the booked date (or, failing that, the preferred start
  date) is 48 hours or more away, or when there is no date at all.
- **$200 + GST** (a late cancellation) inside 48 hours of the booked date.
- **$250 + GST** (a call-out) once the installer has started work on site.
- **Sandbox cancellations are always free.**

These amounts and the 48-hour window are TC's current defaults; TC can change them. `WORK_COMPLETE`, `PAID`,
`CANCELLED` and `DISPUTED` jobs cannot be cancelled (`409 JOB_LOCKED`).

The response tells you what happened:

| Field | Meaning |
| --- | --- |
| `status`, `previous_status` | `CANCELLED`, and what it was before |
| `fee_applied`, `fee_amount_cents`, `gst_cents` | Whether a fee was charged, and how much (ex GST, and the GST) |
| `cancellation_type` | `CLEAN` (no fee), `LATE_CANCEL` or `NO_SHOW` (call-out) |
| `charge_status` | `PAID`, `INVOICED`, `RECONCILE_REQUIRED` or `NONE` |
| `invoice_number`, `card_last4`, `decline_reason` | Details of the charge, when there is one |
| `trade_notified`, `payment_cancelled` | Side effects |
| `message` | A plain-English summary |

## Notes

`POST /v1/jobs/{id}/notes` (`jobs:write`) with `{"body": "..."}` (1 to 10,000 characters). Any status. Returns
`201`. Once an installer is assigned, the note is also sent to them as a chat message from your company's primary
contact (`message_id` is then set). Before that, it goes on the job's record only.

## Attachments

Three steps (`attachments:write`). Allowed types: PDF, JPEG, PNG, HEIC and WebP, up to 25 MB. Categories:
`SITE_PHOTO`, `SPEC_SHEET`, `PLAN`, `PERMIT`, `CONTRACT`, `INVOICE`, `COMPLIANCE`, `OTHER`.

1. `POST /v1/jobs/{id}/attachments` with `{ "filename", "content_type", "size_bytes", "category"?, "title"? }`.
   TC returns `{ attachment_id, upload_url, token, storage_path, expires_in: 7200, ... }`.
2. `PUT` the file bytes to `upload_url`, with the same `Content-Type`, within 2 hours. This URL is a storage
   address, not the API: do not send your API key to it.
3. `POST /v1/jobs/{id}/attachments/{attachment_id}/complete` with the same `filename`, `content_type` and
   `size_bytes` (and optionally `storage_path`, `category`, `title`). TC re-checks the stored file's type, size
   and file signature. On a mismatch the file is deleted and you get `422 VALIDATION_ERROR`.

Not allowed on `CANCELLED` or `PAID` jobs (`409 JOB_LOCKED`). Listing or downloading attachments is not in v1.

## Reference data

Needs `reference:read`, which new keys do not get by default.

| Route | Returns `data: [...]` of |
| --- | --- |
| `GET /v1/reference/job-types` | `{ id, name, service_category_id, description }` |
| `GET /v1/reference/trade-types` | `{ code, name, category }` |
| `GET /v1/reference/accreditations` | `{ id, name, category, issuing_body, type, scope }` |

## Sandbox simulation

`POST /v1/sandbox/jobs/{id}/simulate` with `{"status": "<target>"}`. `tc_test_` keys and sandbox jobs only
(`jobs:write`). It moves a job forward so you can test your status handling and webhooks.

- Targets: `OPEN`, `ASSIGNED`, `SCHEDULED`, `IN_PROGRESS`, `WORK_COMPLETE`, `PAID`, `CANCELLED`.
- The job walks forward through `DRAFT → OPEN → ASSIGNED → SCHEDULED → IN_PROGRESS → WORK_COMPLETE → PAID`.
  It cannot go backwards (`400 VALIDATION_ERROR`), and `OFFERED` is not simulated.
- `CANCELLED` works from any status except `CANCELLED`, `PAID` and `DISPUTED`.
- Asking for the status the job already has changes nothing and sends no event.
- `SCHEDULED` sets `scheduled_date` to the preferred start date, or to tomorrow.
- No installer is attached, so `assigned_installer` stays null.
- **Call once per step.** A jump of several steps in one call sends a single `job.status_changed` (from the
  first status to the last), not one per step.
- Price changes and reschedules cannot be simulated.

What each step sends (all events also cover the job's new state in `data.job`):

| Step | Webhooks |
| --- | --- |
| create (draft or published) | `job.created` (a create that includes a price may also send `job.price_changed`, from no total to the new total) |
| publish (`PATCH publish: true`) or simulate `OPEN` | `job.status_changed` |
| simulate `ASSIGNED` | `job.status_changed`, `job.assigned` |
| simulate `SCHEDULED` | `job.status_changed`, `job.scheduled` |
| simulate `IN_PROGRESS` | `job.status_changed` |
| simulate `WORK_COMPLETE` | `job.status_changed`, `job.completed`, `job.evidence_ready` |
| simulate `PAID` | `job.status_changed` |
| cancel, or simulate `CANCELLED` | `job.status_changed`, `job.cancelled` |
| `PATCH` a new price on a `DRAFT` or `OPEN` job | `job.price_changed` |

`job.rescheduled` cannot be produced through the API: a scheduled job is locked to `PATCH`, and simulate cannot
reschedule. It needs a change to the booked date or window in the TC web app.

## Webhooks

### Setting up an endpoint

A company admin adds endpoints in the TC web app: Settings → API & Webhooks → Webhooks. There is no API route for
this in v1.

- The URL must be HTTPS, on port 443 or 1024 to 65535, at a public address. Redirects are not followed.
- Each endpoint belongs to one environment, sandbox or production, fixed when you add it. Sandbox events go only
  to sandbox endpoints.
- Subscribe to `*` or to chosen events. Up to 10 endpoints per company.
- The signing secret (`whsec_…`) is shown once.
- An optional mapping lets you give TC's statuses your own names. Your label arrives as
  `data.job.client_status_label` (null when there is no mapping for the status).
- **Send test event** sends a `webhook.test` delivery with a dummy job (id `00000000-0000-0000-0000-000000000000`,
  external reference `TEST-WEBHOOK-001`) to that one endpoint.

### Events

| Event | Fires when |
| --- | --- |
| `job.created` | A job is created, through the API or on the TC website |
| `job.status_changed` | Any status change; `changes.job_status` has `from` and `to` |
| `job.assigned` | An installer is assigned, or the status becomes `ASSIGNED` |
| `job.scheduled` | A date is booked or confirmed for the first time |
| `job.rescheduled` | A booked date or time window changes on an already scheduled job |
| `job.completed` | The status becomes `WORK_COMPLETE` (`PAID` arrives as a status change only) |
| `job.evidence_ready` | The status becomes `WORK_COMPLETE`, or completion evidence or serial numbers are added later. At most once per job per 15 minutes. No file links. |
| `job.price_changed` | The job's total or GST changes |
| `job.cancelled` | The job is cancelled; `changes` includes `cancellation_reason` |
| `webhook.test` | Someone pressed Send test event |

Events cover all of your company's jobs, not only those created through the API. New event types may be added:
store and ignore types you do not know.

### Payload

```json
{
  "id": "6f1c…",
  "type": "job.status_changed",
  "created_at": "2026-11-20T03:12:44.120Z",
  "api_version": "2026-10-01",
  "data": {
    "job": { "…the job object…": "", "client_status_label": null },
    "changes": { "job_status": { "from": "ASSIGNED", "to": "SCHEDULED" } }
  }
}
```

- `id` is the event id, the same value as the `webhook-id` header.
- `data.changes` holds `{ "from", "to" }` pairs for what changed. If several changes of one type happen in the same
  TC transaction, they arrive as one event with the first `from` and the last `to`.
- `data.changes.reason`, when present, is a plain string (not a pair): TC changed the job for a stated reason.
- `data.job` is the job as it stood when the event happened (captured when TC saved the change). A retry resends
  that same snapshot. When in doubt, read the job again with `GET /v1/jobs/{id}`.

### Signatures (Standard Webhooks)

Every delivery carries three headers:

| Header | Value |
| --- | --- |
| `webhook-id` | The event id |
| `webhook-timestamp` | Unix seconds when the delivery was signed |
| `webhook-signature` | `v1,<base64 signature>`; during secret rotation, two entries separated by a space |

The signature is `base64(HMAC-SHA256(key, "<webhook-id>.<webhook-timestamp>.<raw body>"))`, where `key` is the
base64-decoded part of your secret after `whsec_`.

To verify a delivery:

1. Read the **raw** body bytes. Do not parse and re-serialise the JSON first; the bytes would change.
2. Refuse it if `webhook-timestamp` is more than 5 minutes from your clock.
3. Compute the signature and compare it, in **constant time**, with each `v1,` entry in `webhook-signature`.
   Accept if any entry matches.
4. Only then parse the JSON.

For 24 hours after you rotate an endpoint's secret in TC, each delivery is signed with both the new and the old
secret. Update your stored secret during that window and nothing is lost.

In Node, with this repository's `src/webhooks/verify.ts`:

```ts
import { verifyWebhook } from "./webhooks/verify.ts";

// rawBody: the request body as a Buffer, exactly as received.
const result = verifyWebhook({ secret: process.env.TC_TEST_WEBHOOK_SECRET!, headers: req.headers, rawBody });
if (!result.ok) {
  res.writeHead(401).end(); // never 410
  return;
}
res.writeHead(200).end(); // answer quickly…
queueForProcessing(JSON.parse(rawBody.toString("utf8"))); // …then do the work
```

Without this repository, the core is a few lines of `node:crypto`:

```js
const crypto = require("node:crypto");

function verify(rawBody, headers, secret) {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sigs = headers["webhook-signature"];
  if (!id || !/^\d+$/.test(ts ?? "") || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.`).update(rawBody).digest();
  return sigs.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}
```

### Delivery and retries

- Deliveries go out within about a minute, with a 10-second timeout.
- **Any 2xx is success.** Answer quickly, then do the work. Ideally save the event to durable storage first.
- Anything else is a failure and is retried after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours and
  24 hours (8 attempts over about 45 hours).
- **`410 Gone` disables the endpoint at once.** Never answer 410 unless you mean that. Use 401 for a bad
  signature, and 5xx for a temporary problem.
- 3xx answers are failures (redirects are not followed). 50 failures in a row also disable the endpoint.
- The Deliveries tab in the web app shows the last 200 attempts with response code and latency, and can replay a
  delivery. A replay keeps the original `webhook-id`. Events are kept for 30 days.

### Delivery is at least once, and not in order

- **Deduplicate on `webhook-id`.** Retries and replays carry the same id. Process each id once.
- **Do not let an older job overwrite a newer one.** Compare `data.job.updated_at` with what you hold, and keep
  the newer.

`src/webhooks/store.ts` in this repository does both.

## Installs (manufacturers)

For manufacturer companies that register installed products. These routes have no sandbox: they need a `tc_live_`
key (a test key gets `403 SCOPE_FORBIDDEN`), and the company must be a manufacturer with the service turned on
(`403 NOT_A_MANUFACTURER` or `FEATURE_DISABLED` otherwise).

| Route | Scope | Does |
| --- | --- | --- |
| `POST /v1/installs` | `installs:write` | Creates (`201`) or updates (`200`) the registration for a `serial_number`, with optional `model`, `installed_on`, `shipped_on`, installer, site and homeowner fields and `external_reference` |
| `GET /v1/installs` | `installs:read` | Lists registrations; filters `serial`, `status` (comma-separated: `REGISTERED`, `PENDING_VERIFICATION`, `VERIFIED`, `REJECTED`, `REPLACED`), `updated_since`, `cursor`, `limit`; same keyset pagination as jobs |
| `GET /v1/installs/{serial}` | `installs:read` | One registration, with its computed warranty `coverage` |

## Request log

Settings → API & Webhooks shows one row per authenticated request: key, request id, method, route, status,
latency, IP address and user agent. Request bodies are not stored. Rows are kept for 90 days. Quote the request id
when you raise an issue.

## What v1 does not do

These stay in the TC web app:

- reading quotes, variations, invoices, messages, completion photos, certificates or serial numbers, and listing or
  downloading attachments;
- changing a job after an installer is assigned;
- managing webhook endpoints;
- bulk endpoints.

## Known differences from the published OpenAPI document

`GET /v1/openapi.json` is useful, but at the time of writing TC's copy differs from the live API. TC is
correcting it. Until then, follow this guide:

- The server URL in the document is not live yet. Use the base URL TC gives you.
- The job status list includes `EXPIRED`, which is never used, and lacks `PENDING_CUSTOMER_SIG`, which is.
- There is no webhooks section. Webhooks are described [above](#webhooks).
- The sandbox simulate body is `{"status": "..."}`. Older TC material shows `{"action": "..."}`; that is wrong.
