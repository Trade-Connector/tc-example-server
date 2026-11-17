# About these docs

- [guide.md](guide.md) is the integration guide: how the Trade Connector Partner API behaves, written for
  developers connecting their own system.

## How versions work

There are two version numbers to know about.

**The API version: v1.** It is in every path (`/v1/jobs`), and `GET /v1/health` answers `"version": "v1"`.
Within v1, TC adds things without breaking existing integrations: new optional request fields, new response
fields, new job statuses and new webhook event types. Write your code to ignore fields it does not know, and to
store unknown statuses and event types rather than fail on them. A change that would break existing
integrations would come as a new version (`/v2`).

**The webhook payload version: a date.** Every webhook envelope carries `api_version`, currently
`"2026-10-01"`. It is set per webhook endpoint in TC and describes the shape of the envelope and the job inside it.
If TC changes that shape, it will publish a new date, and you can move each endpoint over when you are ready.

## The OpenAPI spec

TC publishes a machine-readable spec at `GET /v1/openapi.json`. Today's published copy has known errors (listed at
the end of [the guide](guide.md#known-differences-from-the-published-openapi-document)), so this repository does
not include a copy yet.

Once TC publishes the corrected spec, a frozen copy of each release will be kept here, under `docs/openapi/`, named
by API version and date (for example `docs/openapi/v1-2026-12-01.json`), so you can see exactly what changed
between releases.
