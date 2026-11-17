# Trade Connector example server

An example integration with the [Trade Connector](https://tradeconnector.com.au) (TC) Partner API v1.

It does three things:

- **An API client** you can copy into your own system: create jobs, follow them, cancel them, add notes and files.
- **A webhook receiver** that verifies TC's signatures properly and handles repeats and out-of-order deliveries.
- **A test console** in your browser that exercises every API call and every webhook event, against the sandbox by default.

It is MIT licensed, so you can use the code in commercial software.

For how the API itself works (keys, errors, statuses, cancellation, webhooks), read the
[integration guide](docs/guide.md).

## What you need

- Node.js 22.18 or newer (`node --version`). Node runs the TypeScript files directly; there is no build step.
- A Trade Connector company account with access to **Settings → API & Webhooks**.
- For webhooks: a way to give your machine a public HTTPS address. This guide uses
  [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (no account needed); any HTTPS tunnel works.

## Quick start (sandbox)

1. **Get a test key.** In the TC web app, go to Settings → API & Webhooks → API keys and create a **test** key
   (it starts with `tc_test_`). New keys get `jobs:read` and `jobs:write`. To try everything, also tick
   `jobs:cancel`, `attachments:write` and `reference:read`. The key is shown once.

2. **Configure.**

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Put the key in `TC_TEST_API_KEY`. Leave the live settings empty.

   `TC_BASE_URL` is already set to the Partner API address,
   `https://teclldqbxvjjjcuyhawv.supabase.co/functions/v1/partner-api`. TC may move to a custom domain later
   and will announce it; when that happens, change only this setting.

3. **Install and start.**

   ```sh
   npm install
   npm start
   ```

   The server prints the console address, for example `http://127.0.0.1:3000/#token=…`. Open that exact URL.
   The token at the end is new each time the server starts.

4. **Expose only the webhook port.** In a second terminal:

   ```sh
   cloudflared tunnel --url http://127.0.0.1:3001
   ```

   It prints an address like `https://example-name.trycloudflare.com`. Never tunnel port 3000 (the console).

5. **Add a sandbox webhook endpoint in TC.** In Settings → API & Webhooks → Webhooks, add an endpoint for the
   **sandbox** environment with the URL `https://example-name.trycloudflare.com/webhooks/tc/sandbox`. Subscribe
   to all events (`*`). Copy its signing secret (it starts with `whsec_`) into `TC_TEST_WEBHOOK_SECRET` in
   `.env`, then restart `npm start`.

6. **Check the connection.** Press **Send test event** on the endpoint in TC. A `webhook.test` event appears in
   the console's Webhooks tab with a green tick (signature verified).

7. **Drive a job.** In the console's Jobs tab, open **New job** (it is prefilled with fake example data), publish
   it, then press the simulate buttons one step at a time. Watch each event arrive in the job's timeline and the
   **Test coverage** tab fill up. Or run the whole walk from the command line:

   ```sh
   npm run demo             # create → ASSIGNED → SCHEDULED → IN_PROGRESS → WORK_COMPLETE → PAID
   npm run demo -- --cancel # create → ASSIGNED → SCHEDULED → cancel
   ```

   The demo only ever uses the sandbox key.

8. **Check everything in one go.** In the console's **Sandbox check** tab, press **Run full sandbox check**
   (or run `npm run check:sandbox`). It walks every API call and waits for every webhook, then shows what
   passed, what failed and what needs you. See [One-click sandbox check](#one-click-sandbox-check).

If a call fails, the console shows TC's `error.code`, message, details and `request_id`. Quote the `request_id`
to TC support. A `403 SCOPE_FORBIDDEN` on reference data means the key needs `reference:read` ticked.

## What the console covers

| Area | What you can do |
| --- | --- |
| Header | Switch Sandbox / Live, see the key prefix, base URL and API health, and the webhook URLs to paste into TC. |
| Jobs | The list loads when the console opens: status and `updated_since` filters, open a job by your own reference (`ext:`), load more (keyset pagination). **New job** loads reference data by itself and creates jobs as draft or published with an `Idempotency-Key`; pressing Create again with the same key shows TC's replay (amber, no new job). When TC lists trades per accreditation, only the ticked trades' accreditations are offered (with "Show all"). |
| Selected job | Headed "Selected job: reference · status". Cards in order: details and raw JSON, edit (disabled with the reason once TC would answer `JOB_LOCKED`), add a note, upload an attachment (all three steps, choosing who can see it), then publish and cancel for a draft; past DRAFT, one button per sandbox simulate step, then cancel (fee rules shown first, TC's fee fields after). Each card shows its own result under its button. |
| Webhooks | A live feed of every delivery and a timeline per job: type, environment, signature check, and duplicate or out-of-order flags, with the raw payload. |
| Reference data | Job types, trade types and accreditations. |
| Installs | For manufacturers, production keys only: list, look up and register installs. |
| Sandbox check | The whole API and every webhook in one press, sandbox only. See below. |
| Test coverage | Every API operation and webhook event type, ticked when it succeeds or arrives (the sandbox check ticks it too). Events the sandbox cannot produce say how to trigger them instead. Kept in `data/` until you reset it. |

Every button shows that it was pressed, is busy (and disabled) while its request runs, then flashes green or red.
A double-click never sends a request twice. A button that has nothing to send says why instead ("Choose a file
first", "Write a note first").

## One-click sandbox check

The **Sandbox check** tab's **Run full sandbox check** button and `npm run check:sandbox` run the same code. It
uses only the sandbox key: the button is not on the page in live mode, and the command refuses to run without a
`tc_test_` key. It creates two jobs of its own, `CHECK-<date>-<tag>-A` (the full lifecycle) and `-B` (the cancel
path), and never changes any other job. It takes a few minutes, because it waits for every webhook (TC sends
each within about a minute).

| Group | What it checks |
| --- | --- |
| Keys & health | The key is a `tc_test_` key, checked before any request (with any other key nothing is sent); `GET /v1/health`; the sandbox webhook secret is set; each scope, worked out from the calls that need it, with what to tick if one is missing. |
| Reference data | Job types, trade types and accreditations. |
| Jobs | Create a draft with an `Idempotency-Key`, then the same key and body again (200, the same job); a second, published job; get by id and by `ext:`; list with `updated_since`, one page at a time; PATCH a field and the price; add a note; publish; and a PATCH after ASSIGNED must get `409 JOB_LOCKED`. |
| Attachments | All three upload steps with a tiny generated PNG, private, `SITE_PHOTO`. |
| Sandbox lifecycle | Simulate one step per call, OPEN → ASSIGNED → SCHEDULED → IN_PROGRESS → WORK_COMPLETE → PAID; simulate the second job to ASSIGNED, then cancel it with a reason (CANCELLED, and `fee_applied` false: a sandbox cancel stays free after an installer is assigned, too). |
| Webhooks | Every event those steps should send (worked out from TC's event triggers) arrives, signature verified, with the right job and status; the last copy of each job matches a fresh `GET`; and nothing unexpected arrived. Waits up to 2 minutes per step. |
| Security | A forged signature and an unsigned delivery, posted to this server's own listener, both get 401. |

**Also test TC retries** (a tick box; adds about 2 minutes): the listener answers 500, once, to the next delivery
for the check's own job, and the check expects TC to send the same `webhook-id` again about a minute later. The
switch is sandbox-only, for that one job and one delivery, expires on its own, and never answers 410.

Some things only a person can do. They show amber, not failed, and tick when they really happen (the console keeps
watching after a run): press **Replay** on a delivery in TC (Settings → API & Webhooks → Webhooks → Deliveries)
and see it flagged duplicate; `job.rescheduled`, which needs the TC web app; and `webhook.test` from **Send test
event**.

Each row opens to show the requests and answers, timing, and TC's error code and `request_id` on failure. A live
timeline shows each status with its webhooks dropping in. **Copy report** copies a plain-text summary (no
formatting) ready to paste into WhatsApp or an email. The last five runs are kept in `data/sandbox-check-runs.json`
and can be viewed in the tab, with rows that changed since the run before marked, to compare before and after a
TC release.

From a terminal:

```sh
npm run check:sandbox                # the full check
npm run check:sandbox -- --retries   # also test TC retries
```

If `npm start` is not running, the command listens on the webhook port itself (your tunnel must point there). If
it is running, the server receives the webhooks and the command reads them from `data/`; the retry test then needs
the console button. The command prints the same plain-text report and exits 1 if anything failed (items that need
you do not count).

## Going live

Live mode talks to production. Live jobs reach real installers, and cancelling a job once an installer is
assigned can incur a fee under your company's cancellation terms with Trade Connector (see the
[guide](docs/guide.md#cancelling-a-job)).

To make live mode available:

1. Create a **live** key (`tc_live_…`) in the TC web app, and a **production** webhook endpoint with the URL
   `https://<your-tunnel>/webhooks/tc/live`.
2. In `.env`, set `TC_LIVE_API_KEY`, `TC_LIVE_WEBHOOK_SECRET` and `TC_ALLOW_LIVE=true`.
3. Restart. The server still starts in sandbox. Press **Live** in the console and type `LIVE` to switch.

In live mode:

- A red banner stays on screen.
- Reading (health, reference data, jobs, installs) works as normal.
- **Every write** (create, edit, publish, note, attachment, cancel, install) asks you to type `LIVE`. The server
  enforces this, not just the page: a write must carry a one-time token issued for that exact action, job and
  request body.
- Simulate and the sandbox check are not offered (TC only allows simulate in the sandbox).
- `npm run demo` never uses the live key.

The server refuses to start if a `tc_live_` key is in a test setting or a `tc_test_` key is in a live setting.

## Keeping keys safe

- Keys and webhook secrets live only in `.env` on your machine. Run `chmod 600 .env` so only you can read it.
  `.env` is git-ignored.
- They never reach the browser. The console shows only a prefix such as `tc_test_ab12…`.
- They are never logged and never written to `data/`. The logger masks anything shaped like a key or secret.
- The console listens on `127.0.0.1` only, checks the `Host` header (against DNS rebinding) and needs the per-run
  token on every call. Only the webhook port should ever be reachable from the internet, through your tunnel.
- The webhook listener also listens on `127.0.0.1` only (`WEBHOOK_HOST`), so only the tunnel on your machine can
  reach it. Set `WEBHOOK_HOST=0.0.0.0` only if the tunnel runs on another machine.
- To rotate a key, use TC's two-active-keys rule: create the new key, put it in `.env`, restart, check it works,
  then revoke the old key. To rotate a webhook secret, rotate it in TC, put the new secret in `.env` and restart:
  for 24 hours TC signs with both secrets, so no delivery is lost while you switch.

## Project layout

```
src/
  tc/              The API client: client.ts, errors.ts, types.ts   ← copy these
  webhooks/        verify.ts (signatures), store.ts (dedupe, ordering), events.ts
  check/           The sandbox check: sandbox-check.ts (the steps), report.ts, history.ts,
                   retry-probe.ts (the listener's one-shot 500 switch), event-source.ts
  server/          webhook-listener.ts, console-server.ts, console-api.ts, check-manager.ts,
                   live-guard.ts (live confirmations), coverage.ts
  config.ts        Environment variables and the key-slot checks
  log.ts           Logger that masks secrets
  main.ts          npm start
  demo.ts          npm run demo
  check-sandbox.ts npm run check:sandbox
public/            The console page: index.html, app.js, styles.css (no build step)
  lib/             The page's logic without the DOM (tested in Node)
  brand/           brand.css (every colour) and icon.svg: swap these to rebrand
test/              node:test suites; helpers/tc-signer.ts signs like TC does
docs/              The integration guide and notes on API versions
data/              Received events, refused deliveries, job snapshots, coverage (git-ignored, created on start)
```

## Using the code in your own system

- **Calling the API:** copy `src/tc/` (three files, no dependencies). It uses the global `fetch` in Node 18+,
  Deno, Bun and browsers. Store the `Idempotency-Key` with your own record, so a retried create never makes a
  second job.
- **Receiving webhooks:** copy `src/webhooks/verify.ts` and call `verifyWebhook()` with the **raw** request body,
  before you parse it. In Express, use `express.raw({ type: "application/json" })` on the webhook route; in other
  frameworks, read the body as bytes. Then dedupe on `webhook-id` and keep the newer `data.job.updated_at`, as
  `src/webhooks/store.ts` does. In production, save the event to durable storage before you answer 2xx.
- **Never answer 410** to a webhook: TC treats it as "disable this endpoint".
- If you compile to JavaScript instead of running TypeScript directly, add `"rewriteRelativeImportExtensions": true`
  to your tsconfig, because the imports use `.ts` extensions.

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Starts the webhook listener (127.0.0.1:3001) and the console (127.0.0.1:3000). |
| `npm run demo` | Walks one sandbox job through its life. Add `-- --cancel` for the cancel path, `-- --pause=5000` to slow it down. |
| `npm test` | Runs the tests. They make no network calls. |
| `npm run check:sandbox` | Runs the one-click sandbox check from the terminal. Add `-- --retries` to also test TC's retries. |
| `npm run typecheck` | Type-checks with `tsc`. |

## Dependencies

There are no runtime dependencies. Node's built-ins do the work: `fetch` for HTTP calls, `node:http` for the
two servers (it gives the raw request body directly, which signature checks need), `node:crypto` for HMAC and
constant-time comparison, `node:test` for tests, and `process.loadEnvFile` for `.env`.

Development only:

- `typescript`: type-checking (`npm run typecheck`).
- `@types/node` (version 22): Node's type definitions, pinned to the oldest supported Node so the code uses
  nothing newer.

## Brand and trademarks

The Trade Connector name and logo are trademarks of Solar Cutter Solutions Pty Ltd and are not covered by the MIT
licence.

The console's brand is kept in one folder, `public/brand/`: `brand.css` holds every colour the console uses (as
CSS variables) and `icon.svg` is the logo. To use your own brand, replace those two files and change the title in
`public/index.html`. The reusable code (`src/tc/`, `src/webhooks/`) carries no brand.

## License

[MIT](LICENSE). The Trade Connector name and logo are not covered (see above).
