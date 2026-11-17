// npm run demo: walks one sandbox job through its whole life, printing it after each step.
//
//   npm run demo                 create → OPEN → ASSIGNED → SCHEDULED → IN_PROGRESS → WORK_COMPLETE → PAID
//   npm run demo -- --cancel     create → OPEN → ASSIGNED → SCHEDULED → cancel (shows the fee fields)
//   npm run demo -- --pause=5000 wait 5 s between steps (default 2 s)
//
// Sandbox only: it refuses to run without a tc_test_ key. If the server (npm start) is running
// with a tunnel and a sandbox webhook endpoint, watch the events arrive in the console.

import { randomUUID } from "node:crypto";
import { ConfigError, loadConfig, loadDotEnv } from "./config.ts";
import { keyPrefix, redact, registerSecret } from "./log.ts";
import { TcClient } from "./tc/client.ts";
import { TcApiError } from "./tc/errors.ts";
import type { CreateJobRequest, Job, SimulateTarget, TradeType } from "./tc/types.ts";

const args = process.argv.slice(2);
const cancelPath = args.includes("--cancel");
const pauseMs = Number(/^--pause=(\d+)$/.exec(args.find((a) => a.startsWith("--pause=")) ?? "")?.[1] ?? 2000);

// The demo prints for a person to read rather than logging, but every line still goes through the
// logger's masking, so a key or webhook secret can never reach the terminal.
const out = (line = "") => process.stdout.write(redact(line) + "\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function money(cents: number | null | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "-";
}

function printJob(label: string, job: Job): void {
  out(`  ${label}`);
  out(`    status ${job.status}   ref ${job.external_reference ?? "-"}   id ${job.id}`);
  out(`    updated_at ${job.updated_at}   scheduled_date ${job.schedule?.scheduled_date ?? "-"}   total ${money(job.price?.total_cents)}`);
  out(`    assigned_installer ${job.assigned_installer ? job.assigned_installer.company_name : "none (sandbox never attaches one)"}`);
}

function printError(error: unknown): void {
  if (error instanceof TcApiError) {
    out(`  ✗ ${error.code} (HTTP ${error.status}): ${error.message}`);
    if (error.details) out(`    details: ${JSON.stringify(error.details)}`);
    out(`    request_id: ${error.requestId ?? "-"}  (quote this to TC support)`);
    if (error.hint) out(`    hint: ${error.hint}`);
  } else {
    out(`  ✗ ${(error as Error)?.message ?? String(error)}`);
  }
}

/** Obviously fake example data. Phone numbers are from ACMA's range reserved for fiction. */
function exampleJob(tradeCodes: string[]): CreateJobRequest {
  const ref = `DEMO-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const start = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    title: "Example battery install (demo)",
    description: "Demo job from tc-example-server. Battery and gateway on an existing solar system.",
    external_reference: ref,
    ...(tradeCodes.length ? { trade_codes: tradeCodes } : {}),
    site: {
      address: "12 Example St",
      suburb: "Exampleton",
      state: "NSW",
      postcode: "2000",
      access_instructions: "Side gate. Example data only.",
    },
    schedule: { preferred_start_date: start, time_window: "MORNING" },
    urgency: "NORMAL",
    end_customer: { name: "Alex Example", email: "alex@example.com", phone: "0491 570 006" },
    contacts: [{ name: "Alex Example", phone: "0491 570 156", email: "alex@example.com", role: "SITE_OWNER" }],
    price: { ex_gst_cents: 150_000 },
    publish: true,
  };
}

function pickTrade(tradeTypes: TradeType[]): string[] {
  const electrical = tradeTypes.find((t) => /ELECTRIC/i.test(t.code));
  const first = electrical ?? tradeTypes[0];
  return first ? [first.code] : [];
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig(); // also refuses a tc_live_ key in the test slot
  const apiKey = config.test.apiKey;
  if (!apiKey || !apiKey.startsWith("tc_test_")) {
    out("The demo is sandbox-only and needs a tc_test_ key in TC_TEST_API_KEY (see .env.example).");
    process.exit(1);
  }
  registerSecret(apiKey);

  const tc = new TcClient({ baseUrl: config.baseUrl, apiKey });
  out(`Trade Connector demo (sandbox) using ${keyPrefix(apiKey)} at ${config.baseUrl}`);
  out(cancelPath ? "Path: create, step to SCHEDULED, then cancel." : "Path: create, then step through to PAID.");
  out();

  out("1. Health check");
  const health = await tc.health();
  out(`  ${health.status} (API ${health.version})`);

  out("2. Reference data");
  let tradeCodes: string[] = [];
  try {
    const [jobTypes, tradeTypes, accreditations] = await Promise.all([
      tc.listJobTypes(),
      tc.listTradeTypes(),
      tc.listAccreditations(),
    ]);
    tradeCodes = pickTrade(tradeTypes);
    out(`  ${jobTypes.length} job types, ${tradeTypes.length} trade types, ${accreditations.length} accreditations`);
    out(`  using trade code: ${tradeCodes[0] ?? "(none)"}`);
  } catch (error) {
    if (error instanceof TcApiError && error.code === "SCOPE_FORBIDDEN") {
      out("  Skipped: this key lacks reference:read. Tick reference:read on your key to use reference data.");
      out("  Carrying on without trade codes (they are optional).");
    } else {
      throw error;
    }
  }

  out("3. Create a published sandbox job (with an Idempotency-Key)");
  const idempotencyKey = randomUUID();
  let job = await tc.createJob(exampleJob(tradeCodes), { idempotencyKey });
  printJob(`created (Idempotency-Key ${idempotencyKey})`, job);

  // A job ref you can use with GET /v1/jobs/ext:<ref>
  const id = job.id;
  const steps: SimulateTarget[] = cancelPath
    ? ["ASSIGNED", "SCHEDULED"]
    : ["ASSIGNED", "SCHEDULED", "IN_PROGRESS", "WORK_COMPLETE", "PAID"];
  if (job.status === "DRAFT") steps.unshift("OPEN");

  let n = 4;
  for (const step of steps) {
    await sleep(pauseMs);
    out(`${n++}. Simulate ${step}  (one call per step, so each job.status_changed arrives separately)`);
    job = await tc.simulate(id, step);
    printJob("now", job);
  }

  if (cancelPath) {
    await sleep(pauseMs);
    out(`${n++}. Cancel (sandbox cancellations are always free)`);
    const result = await tc.cancelJob(id, "Demo: customer changed their mind");
    out(`  ${result.previous_status} → ${result.status}`);
    out(`  fee_applied ${result.fee_applied}   fee ${money(result.fee_amount_cents)} + GST ${money(result.gst_cents)}   type ${result.cancellation_type}`);
    out(`  charge_status ${result.charge_status}   invoice ${result.invoice_number ?? "-"}`);
    out(`  ${result.message}`);
  }

  out();
  out(`Done. Look it up any time: GET /v1/jobs/ext:${job.external_reference}`);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    out(`Configuration problem: ${error.message}`);
  } else {
    printError(error);
  }
  process.exit(1);
});
