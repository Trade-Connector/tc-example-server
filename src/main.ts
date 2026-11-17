// npm start: runs the webhook listener and the test console.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeEventSource } from "./check/event-source.ts";
import { RetryProbe } from "./check/retry-probe.ts";
import { ConfigError, loadConfig, loadDotEnv, type Config } from "./config.ts";
import { keyPrefix, log, registerSecret, setLogLevel } from "./log.ts";
import { CheckManager } from "./server/check-manager.ts";
import { createConsoleServer } from "./server/console-server.ts";
import { urlHostFor } from "./server/http-util.ts";
import { Coverage } from "./server/coverage.ts";
import { LiveGuard } from "./server/live-guard.ts";
import { createWebhookServer, WEBHOOK_PATHS } from "./server/webhook-listener.ts";
import { ensureDataDir, flushJsonWrites } from "./store/json-file.ts";
import { EventStore } from "./webhooks/store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "public");

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function banner(config: Config, consoleUrl: string, webhookPort: number): string {
  const live = config.liveAvailable
    ? `available (${keyPrefix(config.live.apiKey)}); switch to it in the console`
    : `off: ${config.liveUnavailableReason}`;
  const secret = (set: string | null) => (set ? "secret set" : "NO SECRET: deliveries get 503");
  const publicBase = config.publicWebhookBaseUrl ?? "https://<your-tunnel>";
  return [
    "",
    "Trade Connector example server",
    `  Mode:        SANDBOX (the server always starts in sandbox)`,
    `  Test key:    ${keyPrefix(config.test.apiKey) ?? "not set (TC_TEST_API_KEY)"}`,
    `  Live mode:   ${live}`,
    `  TC base URL: ${config.baseUrl}`,
    "",
    `  Console (this machine only; keep the token private):`,
    `    ${consoleUrl}`,
    "",
    `  Webhook listener on ${config.webhookHost}:${webhookPort}. Expose ONLY this port, for example:`,
    `    cloudflared tunnel --url http://${urlHostFor(config.webhookHost)}:${webhookPort}`,
    `  Then add these endpoint URLs in TC (Settings → API & Webhooks → Webhooks):`,
    `    sandbox: ${publicBase}${WEBHOOK_PATHS.sandbox}  (${secret(config.test.webhookSecret)})`,
    `    live:    ${publicBase}${WEBHOOK_PATHS.live}  (${secret(config.live.webhookSecret)})`,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  // Only now: LOG_LEVEL may come from .env, which loadDotEnv() has just read.
  setLogLevel(config.logLevel);
  for (const secret of [config.test.apiKey, config.test.webhookSecret, config.live.apiKey, config.live.webhookSecret]) {
    registerSecret(secret);
  }
  for (const warning of config.warnings) log.warn(warning);
  if (config.consoleExposed) {
    log.warn("!!! The console is NOT bound to loopback. Read the warning above. !!!");
  }

  await ensureDataDir(config.dataDir);
  const store = await EventStore.open(config.dataDir);
  const coverage = await Coverage.open(config.dataDir);
  store.onEvent((event) => coverage.recordEvent(event));

  const guard = new LiveGuard({
    liveAvailable: config.liveAvailable,
    liveUnavailableReason: config.liveUnavailableReason,
  });

  const token = randomBytes(24).toString("base64url");
  // The sandbox check's one-shot retry switch, shared by the listener and the check.
  const retryProbe = new RetryProbe();
  const webhookServer = createWebhookServer({ config, store, retryProbe });
  const webhookPort = await listen(webhookServer, config.webhookPort, config.webhookHost);

  const checks = new CheckManager({
    config,
    store,
    events: storeEventSource(store),
    coverage,
    retryProbe,
    listenerUrl: `http://${urlHostFor(config.webhookHost)}:${webhookPort}${WEBHOOK_PATHS.sandbox}`,
  });
  const consoleServer = createConsoleServer({
    config,
    guard,
    store,
    coverage,
    checks,
    token,
    publicDir,
  });
  const consolePort = await listen(consoleServer, config.consolePort, config.consoleHost);
  const consoleUrl = `http://${urlHostFor(config.consoleHost)}:${consolePort}/#token=${token}`;
  process.stdout.write(banner(config, consoleUrl, webhookPort) + "\n");

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Stopping (${signal})`);
    webhookServer.close();
    consoleServer.close();
    webhookServer.closeAllConnections();
    consoleServer.closeAllConnections();
    void flushJsonWrites().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    log.error(`Configuration problem: ${error.message}`);
  } else if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    log.error(`A port is already in use: ${(error as Error).message}. Set CONSOLE_PORT or WEBHOOK_PORT.`);
  } else {
    log.error(`Could not start: ${(error as Error)?.message ?? String(error)}`);
  }
  process.exit(1);
});
