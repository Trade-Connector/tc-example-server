// A tiny logger that can never print a secret.
//
// Every line passes through redact(), which masks anything shaped like a TC API key or a webhook
// secret, and also every exact secret value registered with registerSecret(). Show a key's
// prefix (keyPrefix()) when you need to say which key is in use.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function isLogLevel(value: unknown): value is LogLevel {
  return (LOG_LEVELS as readonly unknown[]).includes(value);
}
export type LogSink = (level: LogLevel, line: string) => void;

// Five or more characters after the prefix, so an already-shortened "tc_test_ab12…" is left alone.
const API_KEY_PATTERN = /\btc_(live|test)_[A-Za-z0-9]{5,}/g;
const WEBHOOK_SECRET_PATTERN = /\bwhsec_[A-Za-z0-9+/=]{5,}/g;

const registeredSecrets = new Set<string>();

/** Registers an exact value (an API key or webhook secret) that must never appear in output. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) registeredSecrets.add(value);
}

/** For tests: forget registered secrets. */
export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** "tc_test_ab12…" — enough to tell keys apart, useless to an attacker. */
export function keyPrefix(key: string | undefined | null): string | null {
  if (!key) return null;
  const match = /^(tc_(?:live|test)_)(.{0,4})/.exec(key);
  if (match) return `${match[1]}${match[2]}…`;
  return `${key.slice(0, 4)}…`;
}

/** Masks secrets in a string. */
export function redact(text: string): string {
  let out = text;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(API_KEY_PATTERN, (m) => keyPrefix(m) ?? "[redacted]");
  out = out.replace(WEBHOOK_SECRET_PATTERN, "whsec_[redacted]");
  return out;
}

let sink: LogSink = (level, line) => {
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};
// Set from LOG_LEVEL by main.ts once .env is loaded (see config.ts); "info" until then.
let minLevel: LogLevel = "info";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Replace where log lines go (tests capture them this way). Returns the previous sink. */
export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

export function setLogLevel(level: LogLevel): void {
  if (!isLogLevel(level)) throw new Error(`Unknown log level "${String(level)}" (use ${LOG_LEVELS.join(", ")})`);
  minLevel = level;
}

function format(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${format(fields)}`;
  sink(level, redact(line));
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
