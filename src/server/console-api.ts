// The console's JSON API. The page in public/ talks only to these routes; they call Trade
// Connector server-side, so API keys and webhook secrets never reach the browser.
//
// Every route returns { data, calls } on success, where `calls` lists the TC requests made
// (operation, status, request_id), or { error, calls } on failure.

import type { Config } from "../config.ts";
import { keyPrefix, log } from "../log.ts";
import { TcClient, type ResponseInfo } from "../tc/client.ts";
import { TcApiError } from "../tc/errors.ts";
import {
  ATTACHMENT_CONTENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  SIMULATE_TARGETS,
  type AttachmentCategory,
  type AttachmentContentType,
  type CreateJobRequest,
  type ListInstallsQuery,
  type ListJobsQuery,
  type SimulateTarget,
  type UpdateJobRequest,
  type UpsertInstallRequest,
} from "../tc/types.ts";
import type { EventStore } from "../webhooks/store.ts";
import type { Coverage } from "./coverage.ts";
import { GuardError, type ConsoleEnvironment, type LiveAction, type LiveGuard } from "./live-guard.ts";
import { WEBHOOK_PATHS } from "./webhook-listener.ts";

export interface ConsoleContext {
  config: Config;
  guard: LiveGuard;
  store: EventStore;
  coverage: Coverage;
  /** For tests: the fetch used to call TC. */
  fetch?: typeof fetch;
}

export interface ApiRequest {
  method: string;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  /** The X-Live-Confirmation header, if any. */
  liveToken: string | null;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

/** A problem found by the console itself, before or instead of calling TC. */
export class ConsoleError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Handler = (ctx: ConsoleContext, req: ApiRequest, tc: () => TcCall) => Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** Route depends on the current environment: the page must say which one it thinks is active. */
  envBound: boolean;
  /** Larger body limit (attachments carry the file as base64). */
  largeBody?: boolean;
}

/** A TC client for the active environment that records every call it makes. */
interface TcCall {
  client: TcClient;
  environment: ConsoleEnvironment;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The named, non-empty query parameters; `limit` becomes a number. */
function pick(query: URLSearchParams, names: readonly string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const name of names) {
    const value = str(query.get(name) ?? undefined);
    if (value) out[name] = name === "limit" ? Number(value) : value;
  }
  return out;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleError(400, "BAD_REQUEST", `${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function apiKeyFor(config: Config, environment: ConsoleEnvironment): string | null {
  return environment === "live" ? config.live.apiKey : config.test.apiKey;
}

function requireKey(ctx: ConsoleContext, call: TcCall): void {
  if (!apiKeyFor(ctx.config, call.environment)) {
    throw new ConsoleError(
      400,
      "NO_API_KEY",
      call.environment === "live"
        ? "TC_LIVE_API_KEY is not set."
        : "TC_TEST_API_KEY is not set. Create a test key in the TC web app (Settings → API & Webhooks → API keys) and add it to .env.",
    );
  }
}

/** Live writes go through the guard; sandbox writes pass straight through. */
function authorize(ctx: ConsoleContext, req: ApiRequest, action: LiveAction, target: string): void {
  ctx.guard.authorizeWrite({ action, target, body: req.body, token: req.liveToken });
}

function sandboxOnly(call: TcCall): void {
  if (call.environment !== "sandbox") {
    throw new ConsoleError(403, "SANDBOX_ONLY", "Simulate is sandbox-only and is never offered in live mode.");
  }
}

function liveOnly(call: TcCall): void {
  if (call.environment !== "live") {
    throw new ConsoleError(409, "LIVE_ONLY", "Installs have no sandbox in TC: they need a live key and live mode.");
  }
}

const routes: Route[] = [];
function route(method: string, pattern: RegExp, handler: Handler, options: { envBound?: boolean; largeBody?: boolean } = {}) {
  routes.push({ method, pattern, handler, envBound: options.envBound ?? true, ...(options.largeBody ? { largeBody: true } : {}) });
}

// ---------------------------------------------------------------------------------------------
// Console state
// ---------------------------------------------------------------------------------------------

route(
  "GET",
  /^\/api\/status$/,
  async (ctx) => {
    const { config, guard } = ctx;
    const base = config.publicWebhookBaseUrl;
    return {
      environment: guard.environment,
      live_available: guard.liveAvailable,
      live_unavailable_reason: guard.liveUnavailableReason,
      base_url: config.baseUrl,
      keys: {
        sandbox: { api_key: keyPrefix(config.test.apiKey), webhook_secret_configured: Boolean(config.test.webhookSecret) },
        live: { api_key: keyPrefix(config.live.apiKey), webhook_secret_configured: Boolean(config.live.webhookSecret) },
      },
      webhooks: {
        port: config.webhookPort,
        public_base_url: base,
        sandbox: base ? base + WEBHOOK_PATHS.sandbox : WEBHOOK_PATHS.sandbox,
        live: base ? base + WEBHOOK_PATHS.live : WEBHOOK_PATHS.live,
      },
      console_exposed: config.consoleExposed,
    };
  },
  { envBound: false },
);

route(
  "POST",
  /^\/api\/environment$/,
  async (ctx, req) => {
    const target = req.body.environment;
    if (target !== "sandbox" && target !== "live") {
      throw new ConsoleError(400, "BAD_REQUEST", "environment must be sandbox or live");
    }
    ctx.guard.switchTo(target, req.body.typed);
    log.warn(`Console switched to ${target.toUpperCase()} mode`);
    return { environment: ctx.guard.environment };
  },
  { envBound: false },
);

route(
  "POST",
  /^\/api\/live\/confirm$/,
  async (ctx, req) =>
    ctx.guard.issue({ action: req.body.action, target: req.body.target, body: req.body.body, typed: req.body.typed }),
  { largeBody: true },
);

// ---------------------------------------------------------------------------------------------
// Open routes and reference data
// ---------------------------------------------------------------------------------------------

route("GET", /^\/api\/health$/, async (_ctx, _req, tc) => tc().client.health());

route("GET", /^\/api\/openapi$/, async (_ctx, _req, tc) => tc().client.openApi());

route("GET", /^\/api\/reference\/(job-types|trade-types|accreditations)$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  switch (req.params[0]) {
    case "job-types":
      return call.client.listJobTypes();
    case "trade-types":
      return call.client.listTradeTypes();
    default:
      return call.client.listAccreditations();
  }
});

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

route("GET", /^\/api\/jobs$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  return call.client.listJobs(
    pick(req.query, ["status", "external_reference", "updated_since", "cursor", "limit"]) as ListJobsQuery,
  );
});

route("POST", /^\/api\/jobs$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  const job = requireObject(req.body.job, "job") as unknown as CreateJobRequest;
  authorize(ctx, req, "create_job", "");
  const idempotencyKey = str(req.body.idempotency_key);
  return call.client.createJob(job, idempotencyKey ? { idempotencyKey } : {});
});

route("GET", /^\/api\/jobs\/([^/]+)$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  return call.client.getJob(req.params[0]!);
});

route("PATCH", /^\/api\/jobs\/([^/]+)$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  const patch = requireObject(req.body.patch, "patch") as UpdateJobRequest;
  authorize(ctx, req, "update_job", req.params[0]!);
  return call.client.updateJob(req.params[0]!, patch);
});

route("POST", /^\/api\/jobs\/([^/]+)\/publish$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  authorize(ctx, req, "publish_job", req.params[0]!);
  return call.client.publishJob(req.params[0]!);
});

route("POST", /^\/api\/jobs\/([^/]+)\/notes$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  const body = str(req.body.body);
  if (!body) throw new ConsoleError(400, "BAD_REQUEST", "body (the note text) is required");
  authorize(ctx, req, "add_note", req.params[0]!);
  return call.client.addNote(req.params[0]!, body);
});

route(
  "POST",
  /^\/api\/jobs\/([^/]+)\/attachments$/,
  async (ctx, req, tc) => {
    const call = tc();
    requireKey(ctx, call);
    const filename = str(req.body.filename);
    const contentType = str(req.body.content_type) as AttachmentContentType | undefined;
    const data = typeof req.body.data_base64 === "string" ? req.body.data_base64 : "";
    if (!filename || !contentType || !data) {
      throw new ConsoleError(400, "BAD_REQUEST", "filename, content_type and data_base64 are required");
    }
    if (!(ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      throw new ConsoleError(400, "BAD_REQUEST", `TC accepts ${ATTACHMENT_CONTENT_TYPES.join(", ")} only`);
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new ConsoleError(400, "BAD_REQUEST", "Files must be between 1 byte and 25 MB");
    }
    authorize(ctx, req, "upload_attachment", req.params[0]!);
    const category = str(req.body.category) as AttachmentCategory | undefined;
    const title = str(req.body.title);
    return call.client.uploadAttachment(req.params[0]!, {
      filename,
      content_type: contentType,
      bytes: new Uint8Array(bytes),
      ...(category ? { category } : {}),
      ...(title ? { title } : {}),
    });
  },
  { largeBody: true },
);

route("POST", /^\/api\/jobs\/([^/]+)\/cancel$/, async (ctx, req, tc) => {
  const call = tc();
  requireKey(ctx, call);
  authorize(ctx, req, "cancel_job", req.params[0]!);
  return call.client.cancelJob(req.params[0]!, str(req.body.reason));
});

route("POST", /^\/api\/jobs\/([^/]+)\/simulate$/, async (ctx, req, tc) => {
  const call = tc();
  sandboxOnly(call);
  requireKey(ctx, call);
  const status = req.body.status;
  if (!(SIMULATE_TARGETS as readonly unknown[]).includes(status)) {
    throw new ConsoleError(400, "BAD_REQUEST", `status must be one of ${SIMULATE_TARGETS.join(", ")}`);
  }
  return call.client.simulate(req.params[0]!, status as SimulateTarget);
});

// ---------------------------------------------------------------------------------------------
// Installs (live only)
// ---------------------------------------------------------------------------------------------

route("GET", /^\/api\/installs$/, async (ctx, req, tc) => {
  const call = tc();
  liveOnly(call);
  requireKey(ctx, call);
  return call.client.listInstalls(
    pick(req.query, ["serial", "status", "updated_since", "cursor", "limit"]) as ListInstallsQuery,
  );
});

route("GET", /^\/api\/installs\/([^/]+)$/, async (ctx, req, tc) => {
  const call = tc();
  liveOnly(call);
  requireKey(ctx, call);
  return call.client.getInstall(req.params[0]!);
});

route("POST", /^\/api\/installs$/, async (ctx, req, tc) => {
  const call = tc();
  liveOnly(call);
  requireKey(ctx, call);
  const install = requireObject(req.body.install, "install") as unknown as UpsertInstallRequest;
  authorize(ctx, req, "upsert_install", "");
  return call.client.upsertInstall(install);
});

// ---------------------------------------------------------------------------------------------
// Webhook events and coverage (local data, no TC call)
// ---------------------------------------------------------------------------------------------

route(
  "GET",
  /^\/api\/events$/,
  async (ctx, req) => {
    const { job_id: jobId, after, limit } = pick(req.query, ["job_id", "after", "limit"]);
    return {
      events: ctx.store.listEvents({
        ...(typeof jobId === "string" ? { jobId } : {}),
        ...(after !== undefined ? { afterSeq: Number(after) } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
      }),
      snapshot:
        typeof jobId === "string"
          ? (ctx.store.getSnapshot("sandbox", jobId) ?? ctx.store.getSnapshot("live", jobId))
          : null,
    };
  },
  { envBound: false },
);

route("GET", /^\/api\/coverage$/, async (ctx) => ctx.coverage.report(), { envBound: false });

route(
  "POST",
  /^\/api\/coverage\/reset$/,
  async (ctx) => {
    ctx.coverage.reset();
    return ctx.coverage.report();
  },
  { envBound: false },
);

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export function findRoute(method: string, pathname: string): { route: Route; params: string[] } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(pathname);
    if (match) {
      let params: string[];
      try {
        params = match.slice(1).map((p) => decodeURIComponent(p));
      } catch {
        throw new ConsoleError(400, "BAD_REQUEST", "Malformed path");
      }
      return { route: candidate, params };
    }
  }
  return null;
}

export async function runRoute(
  ctx: ConsoleContext,
  found: { route: Route; params: string[] },
  req: Omit<ApiRequest, "params">,
): Promise<ApiResult> {
  const calls: ResponseInfo[] = [];
  const environment = ctx.guard.environment;
  const makeCall = (): TcCall => ({
    environment,
    client: new TcClient({
      baseUrl: ctx.config.baseUrl,
      apiKey: apiKeyFor(ctx.config, environment),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      onResponse: (info) => {
        calls.push(info);
        ctx.coverage.recordResponse(environment, info);
        log.info(`TC ${info.method} ${info.path}`, {
          env: environment,
          status: info.status,
          error: info.errorCode ?? undefined,
          request_id: info.requestId ?? undefined,
          ms: info.durationMs,
        });
      },
    }),
  });

  const callList = () =>
    calls.map((c) => ({
      operation: c.operation,
      method: c.method,
      path: c.path,
      status: c.status,
      error_code: c.errorCode,
      request_id: c.requestId,
      duration_ms: c.durationMs,
      rate_limit: c.rateLimit,
    }));

  try {
    const data = await found.route.handler(ctx, { ...req, params: found.params }, makeCall);
    return { status: 200, body: { data, environment, calls: callList() } };
  } catch (error) {
    if (error instanceof TcApiError) {
      return {
        status: error.status >= 400 ? error.status : 502,
        body: { error: { source: "tc", ...error.toJSON() }, environment, calls: callList() },
      };
    }
    if (error instanceof GuardError || error instanceof ConsoleError) {
      return {
        status: error.status,
        body: { error: { source: "console", code: error.code, message: error.message }, environment, calls: callList() },
      };
    }
    log.error("Console API error", { error: (error as Error).message });
    return {
      status: 500,
      body: { error: { source: "console", code: "INTERNAL", message: "Unexpected error; see the server log." }, environment, calls: callList() },
    };
  }
}
