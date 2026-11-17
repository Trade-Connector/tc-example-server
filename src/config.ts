// Configuration, read from environment variables (and .env, if present).
//
// Safety rules enforced here, before anything starts:
// - A test slot must never hold a live key, and the live slot never a test key.
// - Live mode exists only when TC_LIVE_API_KEY is set AND TC_ALLOW_LIVE=true. Even then the
//   server starts in sandbox; switching to live is a deliberate action in the console.
// - Webhook secrets must decode, so a mistyped secret fails now rather than at the first delivery.

import { isLogLevel, LOG_LEVELS, type LogLevel } from "./log.ts";
import { decodeWebhookSecret } from "./webhooks/verify.ts";

// TC may move the API to a custom domain later and will announce it; keep the URL in config (TC_BASE_URL).
export const DEFAULT_BASE_URL = "https://teclldqbxvjjjcuyhawv.supabase.co/functions/v1/partner-api";
const API_KEY_FORMAT = /^tc_(live|test)_[a-f0-9]{48}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface KeySet {
  apiKey: string | null;
  webhookSecret: string | null;
}

export interface Config {
  baseUrl: string;
  test: KeySet;
  live: KeySet;
  /** True only when a live key is set AND TC_ALLOW_LIVE=true. */
  liveAvailable: boolean;
  /** Why live mode is not available, in plain words (null when it is). */
  liveUnavailableReason: string | null;
  consoleHost: string;
  consolePort: number;
  /** CONSOLE_HOST was set to something other than a loopback address. */
  consoleExposed: boolean;
  webhookHost: string;
  webhookPort: number;
  /** Optional: your tunnel's public URL, so the console can show the full webhook URLs. */
  publicWebhookBaseUrl: string | null;
  dataDir: string;
  /** From LOG_LEVEL (debug, info, warn or error); info when unset or unknown. */
  logLevel: LogLevel;
  /** Problems worth printing at start-up that do not stop the server. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function port(env: Env, name: string, fallback: number): number {
  const raw = clean(env[name]);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new ConfigError(`${name} must be a port number (0-65535), got "${raw}"`);
  }
  return n;
}

function checkKey(slot: string, key: string | null, expected: "test" | "live", warnings: string[]): void {
  if (!key) return;
  const other = expected === "test" ? "live" : "test";
  if (key.startsWith(`tc_${other}_`)) {
    throw new ConfigError(
      `${slot} holds a tc_${other}_ key. Put sandbox keys (tc_test_…) in TC_TEST_API_KEY and production keys (tc_live_…) in TC_LIVE_API_KEY.`,
    );
  }
  if (!key.startsWith(`tc_${expected}_`)) {
    throw new ConfigError(`${slot} must start with tc_${expected}_`);
  }
  if (!API_KEY_FORMAT.test(key)) {
    warnings.push(`${slot} does not look like a complete key (tc_${expected}_ followed by 48 hex characters); TC will answer 401.`);
  }
}

function checkSecret(slot: string, secret: string | null): void {
  if (!secret) return;
  try {
    decodeWebhookSecret(secret);
  } catch (error) {
    throw new ConfigError(`${slot}: ${(error as Error).message}`);
  }
}

export function loadConfig(env: Env = process.env): Config {
  const warnings: string[] = [];

  const baseUrl = (clean(env.TC_BASE_URL) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new ConfigError(`TC_BASE_URL is not a valid URL: "${baseUrl}"`);
  }
  if (parsedBase.protocol !== "https:") {
    throw new ConfigError("TC_BASE_URL must use https:// (API keys must never travel unencrypted)");
  }

  const test: KeySet = {
    apiKey: clean(env.TC_TEST_API_KEY),
    webhookSecret: clean(env.TC_TEST_WEBHOOK_SECRET),
  };
  const live: KeySet = {
    apiKey: clean(env.TC_LIVE_API_KEY),
    webhookSecret: clean(env.TC_LIVE_WEBHOOK_SECRET),
  };

  checkKey("TC_TEST_API_KEY", test.apiKey, "test", warnings);
  checkKey("TC_LIVE_API_KEY", live.apiKey, "live", warnings);
  checkSecret("TC_TEST_WEBHOOK_SECRET", test.webhookSecret);
  checkSecret("TC_LIVE_WEBHOOK_SECRET", live.webhookSecret);
  if (test.webhookSecret && live.webhookSecret && test.webhookSecret === live.webhookSecret) {
    throw new ConfigError("TC_TEST_WEBHOOK_SECRET and TC_LIVE_WEBHOOK_SECRET are the same. Each TC endpoint has its own secret.");
  }

  const allowLive = clean(env.TC_ALLOW_LIVE) === "true";
  let liveUnavailableReason: string | null = null;
  if (!live.apiKey && !allowLive) liveUnavailableReason = "No live key configured (TC_LIVE_API_KEY) and TC_ALLOW_LIVE is not true.";
  else if (!live.apiKey) liveUnavailableReason = "TC_ALLOW_LIVE is true but TC_LIVE_API_KEY is not set.";
  else if (!allowLive) liveUnavailableReason = "TC_LIVE_API_KEY is set, but TC_ALLOW_LIVE is not true.";
  const liveAvailable = liveUnavailableReason === null;

  if (!test.apiKey) warnings.push("TC_TEST_API_KEY is not set: sandbox calls will fail until you add a test key.");
  if (!test.webhookSecret) warnings.push("TC_TEST_WEBHOOK_SECRET is not set: sandbox webhooks will be refused (503). Every refusal counts towards TC's 50-failures-in-a-row cutoff, which disables the endpoint: add the secret before TC starts sending.");
  if (liveAvailable && !live.webhookSecret) warnings.push("TC_LIVE_WEBHOOK_SECRET is not set: live webhooks will be refused (503). Every refusal counts towards TC's 50-failures-in-a-row cutoff, which disables the endpoint: add the secret before TC starts sending.");

  // The console is bound to loopback unless CONSOLE_HOST is set explicitly.
  const explicitConsoleHost = clean(env.CONSOLE_HOST);
  const consoleHost = explicitConsoleHost ?? "127.0.0.1";
  const consoleExposed = !LOOPBACK_HOSTS.has(consoleHost);
  if (consoleExposed) {
    warnings.push(
      `CONSOLE_HOST is "${consoleHost}", not a loopback address. Anyone who can reach this address and learns the console token can act with your API keys. Do not do this on a shared network, and never tunnel the console port.`,
    );
  }

  const rawLogLevel = clean(env.LOG_LEVEL)?.toLowerCase() ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLogLevel) ? rawLogLevel : "info";
  if (!isLogLevel(rawLogLevel)) {
    warnings.push(`LOG_LEVEL "${env.LOG_LEVEL}" is not one of ${LOG_LEVELS.join(", ")}; using info.`);
  }

  const publicWebhookBaseUrl = clean(env.PUBLIC_WEBHOOK_BASE_URL)?.replace(/\/+$/, "") ?? null;
  if (publicWebhookBaseUrl && !publicWebhookBaseUrl.startsWith("https://")) {
    warnings.push("PUBLIC_WEBHOOK_BASE_URL should start with https:// (TC only delivers to HTTPS URLs).");
  }

  return {
    baseUrl,
    test,
    live,
    liveAvailable,
    liveUnavailableReason,
    consoleHost,
    consolePort: port(env, "CONSOLE_PORT", 3000),
    consoleExposed,
    // Loopback by default: the tunnel (cloudflared on this machine) reaches it there, and nothing
    // else on the network can post to it. Use 0.0.0.0 only if the tunnel runs on another machine.
    webhookHost: clean(env.WEBHOOK_HOST) ?? "127.0.0.1",
    webhookPort: port(env, "WEBHOOK_PORT", 3001),
    publicWebhookBaseUrl,
    dataDir: clean(env.DATA_DIR) ?? "data",
    logLevel,
    warnings,
  };
}

/** Loads .env into process.env if the file exists (Node's built-in loader; no dotenv needed). */
export function loadDotEnv(file = ".env"): boolean {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new ConfigError(`Could not read ${file}: ${(error as Error).message}`);
  }
}
