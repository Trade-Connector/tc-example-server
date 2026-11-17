# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- One-click sandbox check: `npm run check:sandbox` and the console's **Run full sandbox check** button run the same
  code. Sandbox key only, with two jobs of its own. It checks every API call, waits for every webhook the steps
  should send (signature verified, the right job and status, matching a fresh `GET`), reports missing and
  unexpected events, infers the key's scopes, and self-tests the listener with a forged and an unsigned delivery.
  The second job is cancelled after ASSIGNED, so the check shows a sandbox cancel stays free there too. Optional
  retry test (a one-shot 500 for the check's own job, never 410). Manual items tick when they happen, on the
  newest run, whether the console or the command line ran it. Plain-text report; the last five runs are kept in
  `data/`.
- Console branding: "Trade Connector API Console", the TC logo and green, all colours in `public/brand/brand.css`.
- `Accreditation.trade_type_codes` (optional): TC is adding it within v1. The console offers only the ticked
  trades' accreditations when it is present, and all of them when it is not.
- Dependabot for npm and GitHub Actions, weekly.

### Changed

- Console: the job list and the New job form's reference data load by themselves; an idempotent replay shows an
  amber box; results appear under the button that was used; the right panel is headed "Selected job"; cards are
  in a fixed order (Publish, then Cancel, for a draft); every button shows busy, success and failure, and a double-click
  never sends twice; buttons that have nothing to send say why.

### Fixed

- A stray "null" beside "Price ex GST" in the console's Edit card.

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
