# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-17

First version.

### Added

- API client for the Trade Connector Partner API v1 (`src/tc/`): health, OpenAPI, reference data, jobs (create,
  get, list, update, publish, cancel, notes), three-step attachment upload with an explicit `is_public`, sandbox
  simulate and installs. Typed errors with `code`, `message`, `details` and `request_id`; `Idempotency-Key` on
  create; `ext:` ids, with job ids checked before anything is sent; keyset
  pagination; bounded retry on `429` with `Retry-After`. No runtime dependencies.
- Webhook verification (`src/webhooks/verify.ts`) matching TC's Standard Webhooks signing: raw body, constant-time
  comparison, dual signatures during secret rotation, 5-minute timestamp tolerance.
- Webhook listener with separate sandbox and live paths, on loopback by default. It stores each event before
  answering 200, in a file store that deduplicates on `webhook-id`, keeps the newest job snapshot (comparing
  `updated_at` to the microsecond) and flags duplicates, out-of-order deliveries, environment mismatches and
  unknown types or statuses. Refused deliveries go to a separate, capped log.
- Local web console for testing every API operation and webhook event, sandbox by default. Live mode needs a live
  key plus `TC_ALLOW_LIVE=true`, and every live write needs a server-enforced, one-time `LIVE` confirmation.
- Test coverage checklist of every operation and event type, with how to trigger events the sandbox cannot produce.
- `npm run demo`: walks a sandbox job from creation to `PAID`, or through the cancel path.
- Tests with `node:test` and no network calls; CI on Node 22 and 24.
- Integration guide (`docs/guide.md`).
