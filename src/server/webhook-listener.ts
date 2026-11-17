// The webhook listener: the ONLY port you expose to the internet (for example with
// `cloudflared tunnel --url http://localhost:3001`).
//
// It serves exactly two routes and answers 404 to everything else:
//   POST /webhooks/tc/sandbox   verified with TC_TEST_WEBHOOK_SECRET
//   POST /webhooks/tc/live      verified with TC_LIVE_WEBHOOK_SECRET
// (TC endpoints are per environment, so each gets its own URL and secret.)
//
// Status codes matter to TC:
//   2xx  delivered. Answer quickly (TC waits 10 seconds), then do the work.
//   401  bad signature. TC retries with backoff, and the delivery shows as failed in TC.
//   410  NEVER send this: TC treats 410 Gone as "disable this endpoint" and stops all deliveries.
//   other non-2xx: TC retries after 1 m, 5 m, 30 m, 2 h, 6 h, 12 h and 24 h.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { WebhookEnvelope } from "../webhooks/events.ts";
import type { EventStore, ReceiveEnvironment } from "../webhooks/store.ts";
import { decodeWebhookSecret, verifyWebhook } from "../webhooks/verify.ts";
import { BodyTooLargeError, pathnameOf, readBody, sendJson, sendText } from "./http-util.ts";

export const WEBHOOK_PATHS: Record<ReceiveEnvironment, string> = {
  sandbox: "/webhooks/tc/sandbox",
  live: "/webhooks/tc/live",
};

// TC's payloads are a few kilobytes. Anything this big is not from TC.
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export interface WebhookServerOptions {
  config: Pick<Config, "test" | "live">;
  store: EventStore;
  /** For tests: the current time in Unix seconds. */
  nowSeconds?: () => number;
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  // Decode the secrets once. loadConfig() already checked they are valid.
  const keys: Record<ReceiveEnvironment, Buffer | null> = {
    sandbox: options.config.test.webhookSecret ? decodeWebhookSecret(options.config.test.webhookSecret) : null,
    live: options.config.live.webhookSecret ? decodeWebhookSecret(options.config.live.webhookSecret) : null,
  };

  return createServer((req, res) => {
    const pathname = pathnameOf(req);
    const environment = (Object.keys(WEBHOOK_PATHS) as ReceiveEnvironment[]).find(
      (env) => WEBHOOK_PATHS[env] === pathname,
    );
    if (req.method !== "POST" || !environment) {
      req.resume();
      sendText(res, 404, "Not found");
      return;
    }
    handleDelivery(req, res, environment, keys[environment], options).catch((error: Error) => {
      log.error("Webhook handler failed", { error: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
}

async function handleDelivery(
  req: IncomingMessage,
  res: ServerResponse,
  environment: ReceiveEnvironment,
  key: Buffer | null,
  options: WebhookServerOptions,
): Promise<void> {
  if (!key) {
    req.resume();
    // 503, not 410: TC keeps retrying, so nothing is lost once the secret is added.
    log.warn("Webhook refused: no secret configured for this path", { environment });
    sendJson(res, 503, { error: `No webhook secret configured for ${environment}` });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "Payload too large" });
      return;
    }
    throw error;
  }

  const webhookIdHeader = req.headers["webhook-id"];
  const webhookId = typeof webhookIdHeader === "string" ? webhookIdHeader : null;

  // 1. Verify the signature over the raw bytes, before trusting anything in the body.
  const result = verifyWebhook({
    secret: key,
    headers: req.headers,
    rawBody,
    ...(options.nowSeconds ? { nowSeconds: options.nowSeconds() } : {}),
  });
  if (!result.ok) {
    sendJson(res, 401, { error: "invalid signature", reason: result.reason });
    log.warn("Webhook refused: signature check failed", { environment, reason: result.reason, webhookId });
    await options.store.recordRejected({ environment, webhookId, reason: result.reason, message: result.message });
    return;
  }

  // 2. Parse. The body is signed by TC, so a parse failure is a bug worth seeing in TC's log.
  const rawText = rawBody.toString("utf8");
  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawText) as WebhookEnvelope;
  } catch {
    sendJson(res, 400, { error: "body is not JSON" });
    await options.store.recordRejected({ environment, webhookId: result.webhookId, reason: "invalid_json", message: "Signed body is not valid JSON" });
    return;
  }

  // 3. Acknowledge at once, then do the work.
  // In your own system, write the raw event to durable storage (a table or queue) BEFORE
  // answering 2xx, then process it from there; a crash after the 2xx would otherwise lose it.
  sendJson(res, 200, { received: true });

  setImmediate(() => {
    options.store
      .recordVerified({ environment, webhookId: result.webhookId, envelope, rawBody: rawText })
      .then((event) => {
        log.info("Webhook received", {
          environment,
          type: event.event_type,
          webhookId: event.webhook_id,
          job: event.external_reference ?? event.job_id,
          status: event.job_status,
          duplicate: event.flags.duplicate || undefined,
          out_of_order: event.flags.out_of_order || undefined,
        });
      })
      .catch((error: Error) => log.error("Could not store webhook event", { error: error.message }));
  });
}
