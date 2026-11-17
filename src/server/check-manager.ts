// Runs the sandbox check for the console: one at a time, sandbox key only, and keeps the last
// few runs in data/. After a run finishes it keeps watching deliveries, so a manual item (press
// Replay in TC, Send test event, a reschedule in the TC web app) ticks when it actually happens.

import type { CheckEventSource } from "../check/event-source.ts";
import { CheckHistory } from "../check/history.ts";
import { formatReport } from "../check/report.ts";
import type { RetryProbe } from "../check/retry-probe.ts";
import { applyManualEvent, startSandboxCheck, type CheckClock, type CheckTimings } from "../check/sandbox-check.ts";
import { runSummary, type CheckRun, type CheckRunSummary, type CheckRow } from "../check/types.ts";
import type { Config } from "../config.ts";
import { log } from "../log.ts";
import type { EventStore } from "../webhooks/store.ts";
import type { Coverage } from "./coverage.ts";

export class CheckRunningError extends Error {
  constructor() {
    super("A sandbox check is already running. Wait for it to finish.");
    this.name = "CheckRunningError";
  }
}

export interface CheckManagerOptions {
  config: Pick<Config, "baseUrl" | "test" | "dataDir">;
  store: EventStore;
  events: CheckEventSource;
  coverage?: Coverage | null;
  retryProbe: RetryProbe | null;
  /** The listener's sandbox URL, for the security self-test. */
  listenerUrl: string;
  /** For tests. */
  fetch?: typeof fetch;
  listenerFetch?: typeof fetch;
  clock?: CheckClock;
  timings?: Partial<CheckTimings>;
}

export class CheckManager {
  readonly #options: CheckManagerOptions;
  readonly #history: CheckHistory;
  /** The run in progress, or the last one this process ran (still ticking manual items). */
  #latest: CheckRun | null = null;
  #running: Promise<CheckRun> | null = null;
  #saving: Promise<void> = Promise.resolve();

  constructor(options: CheckManagerOptions) {
    this.#options = options;
    this.#history = new CheckHistory(options.config.dataDir);
    options.store.onEvent((event) => {
      const run = this.#latest;
      if (!run || run.state !== "finished") return; // during a run, the run itself ticks them
      if (applyManualEvent(run, event)) this.#save(run);
    });
  }

  get running(): boolean {
    return this.#running !== null;
  }

  get retryAvailable(): boolean {
    return this.#options.retryProbe !== null;
  }

  /** Starts a run. Throws CheckRunningError if one is under way. The caller checks sandbox mode. */
  start(options: { testRetries: boolean }): CheckRun {
    if (this.#running) throw new CheckRunningError();
    const { config } = this.#options;
    const { run, finished } = startSandboxCheck({
      source: "console",
      baseUrl: config.baseUrl,
      apiKey: config.test.apiKey,
      events: this.#options.events,
      webhookSecretConfigured: Boolean(config.test.webhookSecret),
      listenerUrl: this.#options.listenerUrl,
      retryProbe: this.#options.retryProbe,
      coverage: this.#options.coverage ?? null,
      options: { testRetries: options.testRetries },
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.listenerFetch ? { listenerFetch: this.#options.listenerFetch } : {}),
      ...(this.#options.clock ? { clock: this.#options.clock } : {}),
      ...(this.#options.timings ? { timings: this.#options.timings } : {}),
    });
    this.#latest = run;
    log.info("Sandbox check started", { run: run.id, retries: options.testRetries });
    this.#running = finished
      .then((done) => {
        log.info("Sandbox check finished", { run: done.id, ...done.summary });
        return done;
      })
      .finally(() => {
        this.#running = null;
        this.#save(run);
      });
    return run;
  }

  /** Resolves when the current run (if any) has finished and been saved. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.#running?.catch(() => undefined);
    await this.#saving;
  }

  /** The run in progress, else the newest kept run. */
  async latest(): Promise<CheckRun | null> {
    if (this.#latest) return this.#latest;
    return (await this.#history.list())[0] ?? null;
  }

  async list(): Promise<CheckRunSummary[]> {
    const kept = await this.#history.summaries();
    const current = this.#latest;
    if (current && !kept.some((r) => r.id === current.id)) kept.unshift(runSummary(current));
    else if (current) kept.splice(kept.findIndex((r) => r.id === current.id), 1, runSummary(current));
    return kept;
  }

  /** One run with its report, and the statuses of the run before it (to compare). */
  async get(id: string): Promise<{ run: CheckRun; report: string; previous: PreviousRun | null } | null> {
    const kept = await this.#history.get(id);
    const current = this.#latest?.id === id ? this.#latest : null;
    const run = current ?? kept?.run ?? null;
    if (!run) return null;
    let previous = kept?.previous ?? null;
    if (current && !kept) previous = (await this.#history.list()).find((r) => r.id !== id && r.started_at < run.started_at) ?? null;
    return { run, report: formatReport(run), previous: previous ? previousRun(previous) : null };
  }

  #save(run: CheckRun): void {
    if (run.state !== "finished") return;
    this.#saving = this.#saving
      .then(() => this.#history.save(run))
      .catch((error: unknown) => log.error("Could not save the sandbox check run", { error: (error as Error)?.message ?? String(error) }));
  }
}

export interface PreviousRun {
  id: string;
  started_at: string;
  statuses: Record<string, CheckRow["status"]>;
}

function previousRun(run: CheckRun): PreviousRun {
  return { id: run.id, started_at: run.started_at, statuses: Object.fromEntries(run.rows.map((r) => [r.id, r.status])) };
}
