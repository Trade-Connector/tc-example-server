// The test coverage checklist: every API operation and every webhook event type, ticked when it
// is exercised or received. Kept in data/coverage.json until you press Reset, so a test session
// can span restarts.

import path from "node:path";
import type { OperationId, ResponseInfo } from "../tc/client.ts";
import { EVENT_INFO, isKnownEventType } from "../webhooks/events.ts";
import type { StoredEvent } from "../webhooks/store.ts";
import { readJsonFile, writeJsonFile } from "../store/json-file.ts";
import type { ConsoleEnvironment } from "./live-guard.ts";

export interface EndpointInfo {
  operation: OperationId;
  method: string;
  path: string;
  scope: string | null;
  /** Which environments can use it at all. */
  environments: "both" | "sandbox" | "live";
  note?: string;
}

export const ENDPOINTS: readonly EndpointInfo[] = [
  { operation: "health", method: "GET", path: "/v1/health", scope: null, environments: "both" },
  { operation: "openapi", method: "GET", path: "/v1/openapi.json", scope: null, environments: "both", note: "TC's published copy has known errors." },
  { operation: "reference.job_types", method: "GET", path: "/v1/reference/job-types", scope: "reference:read", environments: "both" },
  { operation: "reference.trade_types", method: "GET", path: "/v1/reference/trade-types", scope: "reference:read", environments: "both" },
  { operation: "reference.accreditations", method: "GET", path: "/v1/reference/accreditations", scope: "reference:read", environments: "both" },
  { operation: "jobs.create", method: "POST", path: "/v1/jobs", scope: "jobs:write", environments: "both" },
  { operation: "jobs.list", method: "GET", path: "/v1/jobs", scope: "jobs:read", environments: "both" },
  { operation: "jobs.get", method: "GET", path: "/v1/jobs/{id}", scope: "jobs:read", environments: "both" },
  { operation: "jobs.update", method: "PATCH", path: "/v1/jobs/{id}", scope: "jobs:write", environments: "both", note: "Edit or publish." },
  { operation: "jobs.cancel", method: "POST", path: "/v1/jobs/{id}/cancel", scope: "jobs:cancel", environments: "both" },
  { operation: "jobs.notes", method: "POST", path: "/v1/jobs/{id}/notes", scope: "jobs:write", environments: "both" },
  { operation: "attachments.create", method: "POST", path: "/v1/jobs/{id}/attachments", scope: "attachments:write", environments: "both", note: "Attachment step 1." },
  { operation: "attachments.upload", method: "PUT", path: "(signed upload_url)", scope: null, environments: "both", note: "Attachment step 2, to storage." },
  { operation: "attachments.complete", method: "POST", path: "/v1/jobs/{id}/attachments/{attachment_id}/complete", scope: "attachments:write", environments: "both", note: "Attachment step 3." },
  { operation: "sandbox.simulate", method: "POST", path: "/v1/sandbox/jobs/{id}/simulate", scope: "jobs:write", environments: "sandbox" },
  { operation: "installs.upsert", method: "POST", path: "/v1/installs", scope: "installs:write", environments: "live", note: "Manufacturers only." },
  { operation: "installs.list", method: "GET", path: "/v1/installs", scope: "installs:read", environments: "live", note: "Manufacturers only." },
  { operation: "installs.get", method: "GET", path: "/v1/installs/{serial}", scope: "installs:read", environments: "live", note: "Manufacturers only." },
];

export interface EndpointMark {
  /** When it last succeeded (2xx). The tick. */
  ok_at: string | null;
  last_at: string;
  last_status: number;
  last_error_code: string | null;
  last_request_id: string | null;
}

export interface EventMark {
  first_at: string;
  last_at: string;
  count: number;
}

interface EnvironmentCoverage {
  endpoints: Record<string, EndpointMark>;
  events: Record<string, EventMark>;
}

interface CoverageState {
  started_at: string;
  sandbox: EnvironmentCoverage;
  live: EnvironmentCoverage;
}

function emptyState(): CoverageState {
  return {
    started_at: new Date().toISOString(),
    sandbox: { endpoints: {}, events: {} },
    live: { endpoints: {}, events: {} },
  };
}

export class Coverage {
  readonly #file: string;
  #state: CoverageState = emptyState();

  private constructor(dataDir: string) {
    this.#file = path.join(dataDir, "coverage.json");
  }

  static async open(dataDir: string): Promise<Coverage> {
    const coverage = new Coverage(dataDir);
    coverage.#state = await readJsonFile<CoverageState>(coverage.#file, emptyState());
    return coverage;
  }

  recordResponse(environment: ConsoleEnvironment, info: ResponseInfo): void {
    const marks = this.#state[environment].endpoints;
    const now = new Date().toISOString();
    const previous = marks[info.operation];
    marks[info.operation] = {
      ok_at: info.ok ? now : (previous?.ok_at ?? null),
      last_at: now,
      last_status: info.status,
      last_error_code: info.errorCode,
      last_request_id: info.requestId,
    };
    this.#save();
  }

  recordEvent(event: StoredEvent): void {
    if (!event.verified || !event.event_type || event.flags.duplicate) return;
    const marks = this.#state[event.environment].events;
    const now = event.received_at;
    const previous = marks[event.event_type];
    marks[event.event_type] = {
      first_at: previous?.first_at ?? now,
      last_at: now,
      count: (previous?.count ?? 0) + 1,
    };
    this.#save();
  }

  reset(): void {
    this.#state = emptyState();
    this.#save();
  }

  /** The checklist as the console shows it. */
  report() {
    const envs = ["sandbox", "live"] as const;
    const otherEventTypes = new Set<string>();
    for (const env of envs) {
      for (const type of Object.keys(this.#state[env].events)) {
        if (!isKnownEventType(type)) otherEventTypes.add(type);
      }
    }
    return {
      started_at: this.#state.started_at,
      endpoints: ENDPOINTS.map((endpoint) => ({
        ...endpoint,
        sandbox: this.#state.sandbox.endpoints[endpoint.operation] ?? null,
        live: this.#state.live.endpoints[endpoint.operation] ?? null,
      })),
      events: EVENT_INFO.map((info) => ({
        type: info.type,
        fires_when: info.firesWhen,
        sandbox_api: info.sandboxApi,
        how_to_trigger: info.howToTrigger,
        sandbox: this.#state.sandbox.events[info.type] ?? null,
        live: this.#state.live.events[info.type] ?? null,
      })),
      // Event types TC sent that this example does not know yet.
      unknown_events: [...otherEventTypes].map((type) => ({
        type,
        sandbox: this.#state.sandbox.events[type] ?? null,
        live: this.#state.live.events[type] ?? null,
      })),
    };
  }

  #save(): void {
    void writeJsonFile(this.#file, this.#state).catch(() => undefined);
  }
}
