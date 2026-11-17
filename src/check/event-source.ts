// Where the sandbox check reads the webhook deliveries that arrived while it ran.
//
// - In the console (npm start), and in the CLI when it runs its own listener: the in-process store.
// - In the CLI while npm start is running (the server owns the webhook port): the server's
//   data/webhook-events.json, read only. The server writes it atomically (temp file + rename)
//   after every delivery, so a read never sees half a file.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EventStore, StoredEvent } from "../webhooks/store.ts";

export interface CheckEventSource {
  /** The highest seq stored so far (0 when there are none). */
  latestSeq(): Promise<number>;
  /** Verified deliveries with seq greater than `afterSeq`, oldest first. */
  since(afterSeq: number): Promise<StoredEvent[]>;
}

export function storeEventSource(store: EventStore): CheckEventSource {
  return {
    async latestSeq() {
      return store.listEvents({ limit: 1 })[0]?.seq ?? 0;
    },
    async since(afterSeq) {
      return store
        .listEvents({ afterSeq, limit: 2200 })
        .filter((event) => event.verified)
        .reverse();
    },
  };
}

/** Reads another process's events file. Never writes to it. */
export function fileEventSource(dataDir: string): CheckEventSource {
  const file = path.join(dataDir, "webhook-events.json");
  let cache: { mtimeMs: number; size: number; events: StoredEvent[] } | null = null;

  async function load(): Promise<StoredEvent[]> {
    let info;
    try {
      info = await stat(file);
    } catch {
      return [];
    }
    if (cache && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.events;
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { events?: StoredEvent[] };
      const events = Array.isArray(parsed.events) ? parsed.events : [];
      cache = { mtimeMs: info.mtimeMs, size: info.size, events };
      return events;
    } catch {
      // Replaced between stat and read, or unreadable: try again on the next poll.
      return cache?.events ?? [];
    }
  }

  return {
    async latestSeq() {
      const events = await load();
      return events.reduce((max, e) => Math.max(max, e.seq), 0);
    },
    async since(afterSeq) {
      const events = await load();
      return events.filter((e) => e.verified && e.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    },
  };
}
