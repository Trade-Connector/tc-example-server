import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ConfigError, DEFAULT_BASE_URL, loadConfig } from "../src/config.ts";
import { makeSecret } from "./helpers/tc-signer.ts";

const TEST_KEY = `tc_test_${"1a".repeat(24)}`;
const LIVE_KEY = `tc_live_${"2b".repeat(24)}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The Partner API's address (TC's decision, 17 Nov 2026). The api.tradeconnector.com.au host
// in TC's OpenAPI `servers` entry does not resolve.
const TC_PARTNER_API = "https://teclldqbxvjjjcuyhawv.supabase.co/functions/v1/partner-api";

describe("base URL", () => {
  it("defaults to the Partner API's real address", () => {
    assert.equal(DEFAULT_BASE_URL, TC_PARTNER_API);
    assert.equal(loadConfig({}).baseUrl, TC_PARTNER_API);
  });

  it("is the same in .env.example, the guide and the README", async () => {
    const example = await readFile(path.join(root, ".env.example"), "utf8");
    assert.match(example, /^TC_BASE_URL=(.*)$/m);
    assert.equal(/^TC_BASE_URL=(.*)$/m.exec(example)![1], TC_PARTNER_API);
    for (const file of ["docs/guide.md", "README.md"]) {
      const text = await readFile(path.join(root, file), "utf8");
      assert.ok(text.includes(TC_PARTNER_API), `${file} names the base URL`);
      assert.ok(!text.includes("api.tradeconnector.com.au"), `${file} does not name the unresolvable host`);
    }
  });
});

describe("loadConfig", () => {
  it("has safe defaults: sandbox base URL config, loopback console, live off", () => {
    const config = loadConfig({});
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.consoleHost, "127.0.0.1");
    assert.equal(config.consolePort, 3000);
    assert.equal(config.webhookPort, 3001);
    assert.equal(config.webhookHost, "127.0.0.1", "the tunnel reaches loopback; nothing else on the network should");
    assert.equal(config.consoleExposed, false);
    assert.equal(config.liveAvailable, false);
    assert.equal(config.logLevel, "info");
  });

  it("reads LOG_LEVEL, and warns (rather than silently logging everything) on an unknown value", () => {
    assert.equal(loadConfig({ LOG_LEVEL: "error" }).logLevel, "error");
    assert.equal(loadConfig({ LOG_LEVEL: " WARN " }).logLevel, "warn");
    const odd = loadConfig({ LOG_LEVEL: "loud" });
    assert.equal(odd.logLevel, "info");
    assert.ok(odd.warnings.some((w) => w.includes("LOG_LEVEL")));
  });

  it("refuses to boot with a live key in the test slot", () => {
    assert.throws(() => loadConfig({ TC_TEST_API_KEY: LIVE_KEY }), (e: unknown) => e instanceof ConfigError && /TC_TEST_API_KEY holds a tc_live_ key/.test(e.message));
  });

  it("refuses to boot with a test key in the live slot", () => {
    assert.throws(() => loadConfig({ TC_LIVE_API_KEY: TEST_KEY }), (e: unknown) => e instanceof ConfigError && /TC_LIVE_API_KEY holds a tc_test_ key/.test(e.message));
  });

  it("refuses keys with no recognisable prefix, and warns on a truncated key", () => {
    assert.throws(() => loadConfig({ TC_TEST_API_KEY: "sk_test_123" }), ConfigError);
    const config = loadConfig({ TC_TEST_API_KEY: "tc_test_abc" });
    assert.ok(config.warnings.some((w) => w.includes("does not look like a complete key")));
  });

  it("keeps live mode off unless BOTH a live key and TC_ALLOW_LIVE=true are set", () => {
    assert.equal(loadConfig({ TC_LIVE_API_KEY: LIVE_KEY }).liveAvailable, false);
    assert.equal(loadConfig({ TC_ALLOW_LIVE: "true" }).liveAvailable, false);
    assert.equal(loadConfig({ TC_LIVE_API_KEY: LIVE_KEY, TC_ALLOW_LIVE: "yes" }).liveAvailable, false);
    assert.equal(loadConfig({ TC_LIVE_API_KEY: LIVE_KEY, TC_ALLOW_LIVE: "1" }).liveAvailable, false);
    const on = loadConfig({ TC_LIVE_API_KEY: LIVE_KEY, TC_ALLOW_LIVE: "true" });
    assert.equal(on.liveAvailable, true);
    assert.equal(on.liveUnavailableReason, null);
    assert.match(loadConfig({ TC_LIVE_API_KEY: LIVE_KEY }).liveUnavailableReason ?? "", /TC_ALLOW_LIVE/);
  });

  it("validates webhook secrets at start-up", () => {
    assert.throws(() => loadConfig({ TC_TEST_WEBHOOK_SECRET: "whsec_not!!base64" }), ConfigError);
    assert.throws(() => loadConfig({ TC_LIVE_WEBHOOK_SECRET: "secret" }), ConfigError);
    const same = makeSecret();
    assert.throws(() => loadConfig({ TC_TEST_WEBHOOK_SECRET: same, TC_LIVE_WEBHOOK_SECRET: same }), ConfigError);
    assert.doesNotThrow(() => loadConfig({ TC_TEST_WEBHOOK_SECRET: makeSecret(), TC_LIVE_WEBHOOK_SECRET: makeSecret() }));
  });

  it("requires an https base URL", () => {
    assert.throws(() => loadConfig({ TC_BASE_URL: "http://api.example.test/partner-api" }), ConfigError);
    assert.equal(loadConfig({ TC_BASE_URL: "https://api.example.test/partner-api/" }).baseUrl, "https://api.example.test/partner-api");
  });

  it("warns loudly when CONSOLE_HOST is not loopback", () => {
    const config = loadConfig({ CONSOLE_HOST: "0.0.0.0" });
    assert.equal(config.consoleExposed, true);
    assert.ok(config.warnings.some((w) => w.includes("not a loopback address")));
    assert.equal(loadConfig({ CONSOLE_HOST: "localhost" }).consoleExposed, false);
  });

  it("rejects bad port numbers", () => {
    assert.throws(() => loadConfig({ CONSOLE_PORT: "eighty" }), ConfigError);
    assert.throws(() => loadConfig({ WEBHOOK_PORT: "70000" }), ConfigError);
  });
});
