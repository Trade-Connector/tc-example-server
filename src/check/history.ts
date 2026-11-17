// The last few sandbox check runs, kept in data/sandbox-check-runs.json so you can compare a run
// before and after a TC release. Newest first.
//
// The CLI and the console can both save here (the CLI while npm start is running, too), so every
// save reads the file again first and changes only its own run.

import path from "node:path";
import { readJsonFile, writeJsonFile } from "../store/json-file.ts";
import { runSummary, type CheckRun, type CheckRunSummary } from "./types.ts";

export const MAX_KEPT_RUNS = 5;

interface PersistedRuns {
  runs: CheckRun[];
}

export class CheckHistory {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "sandbox-check-runs.json");
  }

  async list(): Promise<CheckRun[]> {
    const persisted = await readJsonFile<PersistedRuns>(this.file, { runs: [] });
    return Array.isArray(persisted.runs) ? persisted.runs : [];
  }

  async summaries(): Promise<CheckRunSummary[]> {
    return (await this.list()).map(runSummary);
  }

  async get(id: string): Promise<{ run: CheckRun; previous: CheckRun | null } | null> {
    const runs = await this.list();
    const index = runs.findIndex((r) => r.id === id);
    if (index === -1) return null;
    return { run: runs[index]!, previous: runs[index + 1] ?? null };
  }

  /** Adds the run, or replaces the copy with the same id, and keeps the newest MAX_KEPT_RUNS. */
  async save(run: CheckRun): Promise<void> {
    const runs = (await this.list()).filter((r) => r.id !== run.id);
    runs.push(run);
    runs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    await writeJsonFile(this.file, { runs: runs.slice(0, MAX_KEPT_RUNS) } satisfies PersistedRuns);
  }
}
