// Runs the sandbox check for the console: one at a time, sandbox key only, and keeps the last
// few runs in data/. After a run finishes it keeps watching deliveries, so a manual item (press
// Replay in TC, Send test event, a reschedule in the TC web app) ticks when it actually happens.
//
// `npm run check:sandbox` saves its runs in the same file, also while npm start is running. So
// "the latest run" is the newest one, wherever it ran: this process's run only while it is
// running or still the newest. Manual items tick on that newest run too.

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
  /** The run in progress, or the last one this process ran. */
  #latest: CheckRun | null = null;
  #running: Promise<CheckRun> | null = null;
  /** Saves and manual ticks, one after another (each reads the file again before it writes). */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: CheckManagerOptions) {
    this.#options = options;
    this.#history = new CheckHistory(options.config.dataDir);
    options.store.onEvent((event) => {
      if (this.#running) return; // during a run, the run itself ticks them
      this.#enqueue(async () => {
        const run = await this.#newest();
        if (!run || run.state !== "finished") return;
        // The newest run is this process's own object, or a fresh copy read from the file.
        if (applyManualEvent(run, event)) await this.#history.save(run);
      }, "Could not tick a manual item on the sandbox check run");
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
      .catch((error: unknown) => {
        // The check catches its own errors; this is a last guard, so a bug never crashes the server.
        log.error("The sandbox check failed", { error: (error as Error)?.message ?? String(error) });
        run.state = "finished";
        run.finished_at ??= new Date().toISOString();
        return run;
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
    await this.#queue;
  }

  /** The run in progress, else the newest run: kept in data/ or this process's last one. */
  async latest(): Promise<CheckRun | null> {
    await this.#queue;
    return this.#newest();
  }

  /** Every run, newest first, each with its own id. */
  async list(): Promise<CheckRunSummary[]> {
    await this.#queue;
    const kept = await this.#history.summaries();
    const current = this.#latest;
    if (current) {
      const index = kept.findIndex((r) => r.id === current.id);
      if (index === -1) kept.push(runSummary(current));
      else kept.splice(index, 1, runSummary(current));
    }
    return kept.sort(newestFirst);
  }

  /** One run with its report, and the statuses of the run before it (to compare). */
  async get(id: string): Promise<{ run: CheckRun; report: string; previous: PreviousRun | null } | null> {
    await this.#queue;
    const kept = await this.#history.get(id);
    const current = this.#latest?.id === id ? this.#latest : null;
    const run = current ?? kept?.run ?? null;
    if (!run) return null;
    let previous = kept?.previous ?? null;
    if (current && !kept) previous = (await this.#history.list()).find((r) => r.id !== id && r.started_at < run.started_at) ?? null;
    return { run, report: formatReport(run), previous: previous ? previousRun(previous) : null };
  }

  /** This process's run while it runs or while it is still the newest; otherwise the newest kept run. */
  async #newest(): Promise<CheckRun | null> {
    const own = this.#latest;
    if (own && this.#running) return own;
    const kept = (await this.#history.list())[0] ?? null;
    if (!own) return kept;
    if (!kept || kept.id === own.id || newestFirst(own, kept) <= 0) return own;
    return kept;
  }

  #save(run: CheckRun): void {
    if (run.state !== "finished") return;
    this.#enqueue(() => this.#history.save(run), "Could not save the sandbox check run");
  }

  #enqueue(work: () => Promise<void>, failure: string): void {
    this.#queue = this.#queue
      .then(work)
      .catch((error: unknown) => log.error(failure, { error: (error as Error)?.message ?? String(error) }));
  }
}

/** Sorts runs newest first (by when they started). */
function newestFirst(a: { started_at: string }, b: { started_at: string }): number {
  return b.started_at.localeCompare(a.started_at);
}

export interface PreviousRun {
  id: string;
  started_at: string;
  statuses: Record<string, CheckRow["status"]>;
}

function previousRun(run: CheckRun): PreviousRun {
  return { id: run.id, started_at: run.started_at, statuses: Object.fromEntries(run.rows.map((r) => [r.id, r.status])) };
}
