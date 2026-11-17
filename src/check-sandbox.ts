// npm run check:sandbox: the same one-click sandbox check as the console's "Run full sandbox
// check" button, from the command line.
//
//   npm run check:sandbox                 the full check (takes a few minutes: it waits for webhooks)
//   npm run check:sandbox -- --retries    also test TC's retries (adds about 2 minutes)
//
// Sandbox only: it refuses to run without a tc_test_ key, and never uses a live key. It creates
// its own two jobs (CHECK-<date>-<tag>-A and -B) and changes no other job.
//
// Webhooks: if npm start is NOT running, this command listens on the webhook port itself (so your
// tunnel reaches it) and stores deliveries in data/ as the server would. If npm start IS running,
// it reads the deliveries the server stores in data/; the retry test then needs the console button,
// because the server owns the port.
//
// The run is kept in data/sandbox-check-runs.json with the last few, and the console shows it.
// Exit code: 0 when nothing failed (items that need you do not count), 1 otherwise.

import type { Server } from "node:http";
import { fileEventSource, storeEventSource, type CheckEventSource } from "./check/event-source.ts";
import { CheckHistory } from "./check/history.ts";
import { formatReport } from "./check/report.ts";
import { RetryProbe } from "./check/retry-probe.ts";
import { startSandboxCheck } from "./check/sandbox-check.ts";
import type { CheckRow } from "./check/types.ts";
import { ConfigError, loadConfig, loadDotEnv } from "./config.ts";
import { keyPrefix, redact, registerSecret, setLogLevel } from "./log.ts";
import { Coverage } from "./server/coverage.ts";
import { urlHostFor } from "./server/http-util.ts";
import { createWebhookServer, WEBHOOK_PATHS } from "./server/webhook-listener.ts";
import { ensureDataDir, flushJsonWrites } from "./store/json-file.ts";
import { EventStore } from "./webhooks/store.ts";

const args = process.argv.slice(2);
const testRetries = args.includes("--retries");

// Every line goes through the logger's masking, so a key or secret can never reach the terminal.
const out = (line = "") => process.stdout.write(redact(line) + "\n");

const MARKS: Record<CheckRow["status"], string> = {
  pass: "✓",
  needs_you: "!",
  fail: "✕",
  skipped: "–",
  waiting: " ",
  running: "…",
};

function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(true);
    });
  });
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig(); // also refuses a tc_live_ key in the test slot
  const apiKey = config.test.apiKey;
  if (!apiKey || !apiKey.startsWith("tc_test_")) {
    out("The sandbox check needs a tc_test_ key in TC_TEST_API_KEY (see .env.example). It never uses a live key.");
    process.exit(1);
  }
  for (const secret of [config.test.apiKey, config.test.webhookSecret, config.live.apiKey, config.live.webhookSecret]) registerSecret(secret);
  // Only warnings and errors from the server code: the check prints its own progress.
  setLogLevel("warn");

  await ensureDataDir(config.dataDir);
  const store = await EventStore.open(config.dataDir);
  const retryProbe = new RetryProbe();
  const listener = createWebhookServer({ config, store, retryProbe });
  const ownListener = await listen(listener, config.webhookPort, config.webhookHost);
  const listenerUrl = `http://${urlHostFor(config.webhookHost)}:${config.webhookPort}${WEBHOOK_PATHS.sandbox}`;

  let events: CheckEventSource;
  let coverage: Coverage | null = null;
  if (ownListener) {
    events = storeEventSource(store);
    coverage = await Coverage.open(config.dataDir);
    const tick = coverage;
    store.onEvent((event) => tick.recordEvent(event));
  } else {
    // npm start owns the port: read what it stores, write nothing of its own except the run.
    events = fileEventSource(config.dataDir);
  }

  out(`Trade Connector sandbox check using ${keyPrefix(apiKey)} at ${config.baseUrl}`);
  out(
    ownListener
      ? `Listening for webhooks on ${urlHostFor(config.webhookHost)}:${config.webhookPort} (npm start is not running). Your tunnel must point here.`
      : `npm start is running, so its webhook listener receives deliveries; this reads them from ${config.dataDir}/.`,
  );
  out("It takes a few minutes: TC sends each webhook within about a minute, and the check waits for every one.");
  out();

  const printed = new Set<string>();
  const { run, finished } = startSandboxCheck({
    source: "cli",
    baseUrl: config.baseUrl,
    apiKey,
    events,
    webhookSecretConfigured: Boolean(config.test.webhookSecret),
    listenerUrl,
    retryProbe: ownListener ? retryProbe : null,
    retryUnavailableReason:
      "The retry test needs the listener in this process, but npm start owns the webhook port. Use the console's Run full sandbox check button with the retry box ticked, or stop npm start first.",
    coverage,
    options: { testRetries },
    onUpdate: (_run, row) => {
      if (!row || printed.has(`${row.id}:${row.status}`)) return;
      if (row.status === "waiting" || row.status === "running") return;
      printed.add(`${row.id}:${row.status}`);
      const time = row.duration_ms !== null && row.status !== "needs_you" ? ` (${row.duration_ms} ms)` : "";
      out(`${MARKS[row.status]} ${row.title}${time}${row.status !== "pass" && row.reason ? `\n    ${row.reason}` : ""}`);
    },
  });

  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    out("\nStopping. The sandbox jobs the check made so far stay in the sandbox.");
    retryProbe.disarm();
    listener.close();
    listener.closeAllConnections();
    void flushJsonWrites().finally(() => process.exit(130));
  });

  const done = await finished;
  await new CheckHistory(config.dataDir).save(done);
  if (ownListener) {
    listener.close();
    listener.closeAllConnections();
  }
  await flushJsonWrites();

  out();
  out(formatReport(done));
  out();
  out(`Kept in ${config.dataDir}/sandbox-check-runs.json (run ${run.id}); the console's Sandbox check tab shows it.`);
  process.exit(done.summary.failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  out(error instanceof ConfigError ? `Configuration problem: ${error.message}` : `The check could not run: ${(error as Error)?.message ?? String(error)}`);
  process.exit(1);
});
