// Small helpers for keeping state in JSON files under data/.
// Writes go to a temporary file first and are then renamed over the real one, so a crash
// mid-write never leaves a half-written file. Writes to one file are queued, never interleaved.
// There is no fsync: a finished write survives the process crashing, but not a power cut or an OS
// crash. That is fine for this example; in production, use a database or queue as the durable step.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureDataDir(dir: string): Promise<void> {
  // 0700: only the current user can read the stored events.
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(`Could not read ${file}: ${(error as Error).message}`);
  }
}

const queues = new Map<string, Promise<void>>();

/**
 * Queues a write of `value` to `file`. Pass a function to build the value when the write RUNS
 * rather than when it is queued, for content that must reflect everything finished by then.
 */
export function writeJsonFile(file: string, value: unknown | (() => unknown)): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await ensureDataDir(path.dirname(file));
      const tmp = `${file}.${process.pid}.tmp`;
      const data = typeof value === "function" ? (value as () => unknown)() : value;
      await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
      await rename(tmp, file);
    });
  queues.set(file, next);
  return next;
}

/** Waits for every queued write to finish (used on shutdown and in tests). */
export async function flushJsonWrites(): Promise<void> {
  await Promise.allSettled([...queues.values()]);
}
