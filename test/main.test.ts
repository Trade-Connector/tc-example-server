// npm start and npm run demo as real processes, on loopback only: start-up reads .env before
// anything is logged, prints a console URL that works, and the demo refuses to run unsafely.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { log, setLogLevel, setLogSink } from "../src/log.ts";
import { allowedHosts } from "../src/server/console-server.ts";
import { urlHostFor } from "../src/server/http-util.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "tc-main-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a script in `cwd` with ONLY the given environment (plus PATH), so nothing from the
 * developer's shell or .env leaks in. `until` stops it (SIGTERM) once stdout matches.
 */
function run(script: string, cwd: string, env: Record<string, string>, options: { until?: RegExp; onMatch?: (stdout: string) => Promise<void> } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(root, "src", script)], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let matched = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${script} did not finish in time.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (options.until && !matched && options.until.test(stdout)) {
        matched = true;
        (options.onMatch ?? (async () => {}))(stdout)
          .catch((error: unknown) => { stderr += `\n[test] ${String(error)}`; })
          .finally(() => child.kill("SIGTERM"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function ipv6LoopbackWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createTcpServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

describe("log level", () => {
  it("filters below the chosen level, and refuses an unknown level", () => {
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      setLogLevel("error");
      log.info("hidden info");
      log.warn("hidden warning");
      log.error("shown error");
      assert.deepEqual(lines.map((l) => l.replace(/^\S+ /, "")), ["ERROR shown error"]);
      assert.throws(() => setLogLevel("loud" as never));
    } finally {
      setLogLevel("info");
      setLogSink(restore);
    }
  });
});

describe("console URL", () => {
  it("is one the console answers, for every kind of CONSOLE_HOST", () => {
    for (const [bind, shown] of [
      ["127.0.0.1", "127.0.0.1"],
      ["localhost", "localhost"],
      ["::1", "[::1]"],
      ["0.0.0.0", "127.0.0.1"],
      ["::", "[::1]"],
      ["192.168.1.10", "192.168.1.10"],
      ["fd00::5", "[fd00::5]"],
    ] as const) {
      assert.equal(urlHostFor(bind), shown, bind);
      assert.ok(allowedHosts(bind, 3000).has(`${shown}:3000`), `${bind}: the Host check accepts ${shown}`);
    }
  });
});

describe("npm start", () => {
  it("applies LOG_LEVEL from .env, prints a console URL that answers, and binds the webhook listener to loopback", async (t) => {
    if (!(await ipv6LoopbackWorks())) {
      t.skip("no IPv6 loopback on this machine");
      return;
    }
    const cwd = path.join(dir, "start");
    await import("node:fs/promises").then((fs) => fs.mkdir(cwd, { recursive: true }));
    // No keys at all: start-up logs several warnings, which LOG_LEVEL=error must hide.
    await writeFile(path.join(cwd, ".env"), ["LOG_LEVEL=error", "CONSOLE_HOST=::1", "CONSOLE_PORT=0", "WEBHOOK_PORT=0", `DATA_DIR=${path.join(cwd, "data")}`].join("\n"));

    let pageStatus = 0;
    const result = await run("main.ts", cwd, {}, {
      until: /#token=\S+/,
      onMatch: async (stdout) => {
        const url = /(http:\/\/\S+)\/#token=/.exec(stdout)![1]!;
        pageStatus = (await fetch(`${url}/`)).status;
      },
    });

    assert.match(result.stdout, /http:\/\/\[::1\]:\d+\/#token=/, "the URL names the address the console is bound to");
    assert.equal(pageStatus, 200, `the printed console URL answers\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Webhook listener on 127\.0\.0\.1:\d+/);
    assert.match(result.stdout, /cloudflared tunnel --url http:\/\/127\.0\.0\.1:\d+/);
    assert.doesNotMatch(result.stdout + result.stderr, / (WARN|INFO) /, "LOG_LEVEL=error from .env hides warnings and info");
  });
});

describe("npm run demo", () => {
  const LIVE_KEY = `tc_live_${"2b".repeat(24)}`;
  const TEST_KEY = `tc_test_${"1a".repeat(24)}`;

  it("refuses to run without a test key, before any call to TC", async () => {
    const result = await run("demo.ts", dir, { TC_BASE_URL: "https://127.0.0.1:9/functions/v1/partner-api" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /sandbox-only and needs a tc_test_ key/);
    assert.doesNotMatch(result.stdout, /Health check/);
  });

  it("refuses a live key in the test slot, before any call to TC", async () => {
    const result = await run("demo.ts", dir, { TC_TEST_API_KEY: LIVE_KEY, TC_BASE_URL: "https://127.0.0.1:9/functions/v1/partner-api" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /TC_TEST_API_KEY holds a tc_live_ key/);
    assert.doesNotMatch(result.stdout, /Health check/);
    assert.ok(!result.stdout.includes(LIVE_KEY));
  });

  it("masks key-shaped values in everything it prints", async () => {
    // A local port that drops every connection, so the demo's first call fails at once, on loopback.
    const sink = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const port = (sink.address() as AddressInfo).port;
    try {
      // The base URL carries a key-shaped string; the demo prints the base URL in its banner.
      const leaky = `tc_test_${"9f".repeat(24)}`;
      const result = await run("demo.ts", dir, { TC_TEST_API_KEY: TEST_KEY, TC_BASE_URL: `https://127.0.0.1:${port}/${leaky}/partner-api` });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /Health check/);
      assert.match(result.stdout, /tc_test_1a1a…/, "the key's prefix is shown");
      assert.ok(!result.stdout.includes(TEST_KEY));
      assert.ok(!result.stdout.includes(leaky), "a key-shaped value in any printed line is masked");
    } finally {
      sink.close();
    }
  });
});

describe("npm run check:sandbox", () => {
  const LIVE_KEY = `tc_live_${"2b".repeat(24)}`;
  const TEST_KEY = `tc_test_${"1a".repeat(24)}`;

  it("refuses to run without a test key, before any call to TC", async () => {
    const result = await run("check-sandbox.ts", dir, { TC_BASE_URL: "https://127.0.0.1:9/functions/v1/partner-api" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /needs a tc_test_ key in TC_TEST_API_KEY/);
    assert.doesNotMatch(result.stdout, /API health/);
  });

  it("refuses a live key in the test slot, before any call to TC", async () => {
    const result = await run("check-sandbox.ts", dir, { TC_TEST_API_KEY: LIVE_KEY, TC_BASE_URL: "https://127.0.0.1:9/functions/v1/partner-api" });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /TC_TEST_API_KEY holds a tc_live_ key/);
    assert.ok(!result.stdout.includes(LIVE_KEY));
  });

  async function unreachableTc(): Promise<{ url: string; close: () => void }> {
    // A local port that drops every connection, so the first call fails at once, on loopback.
    const sink = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    return { url: `https://127.0.0.1:${(sink.address() as AddressInfo).port}/partner-api`, close: () => sink.close() };
  }

  it("runs on its own listener when npm start is not running, prints a plain report, keeps the run, exits 1 on failure", async () => {
    const tc = await unreachableTc();
    const cwd = path.join(dir, "check-own");
    await mkdir(cwd, { recursive: true });
    try {
      const result = await run("check-sandbox.ts", cwd, { TC_TEST_API_KEY: TEST_KEY, TC_BASE_URL: tc.url, WEBHOOK_PORT: "0", DATA_DIR: path.join(cwd, "data") });
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /Listening for webhooks on 127\.0\.0\.1:0/);
      assert.match(result.stdout, /✕ API health/);
      assert.match(result.stdout, /Result: 1 passed · 0 need you · 1 failed · \d+ skipped/);
      assert.match(result.stdout, /tc_test_1a1a…/);
      assert.ok(!result.stdout.includes(TEST_KEY));
      const saved = JSON.parse(await readFile(path.join(cwd, "data", "sandbox-check-runs.json"), "utf8"));
      assert.equal(saved.runs.length, 1);
      assert.equal(saved.runs[0].source, "cli");
    } finally {
      tc.close();
    }
  });

  it("reads the server's stored deliveries instead when npm start owns the webhook port", async () => {
    const tc = await unreachableTc();
    const busy = createTcpServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const cwd = path.join(dir, "check-shared");
    await mkdir(cwd, { recursive: true });
    try {
      const result = await run("check-sandbox.ts", cwd, {
        TC_TEST_API_KEY: TEST_KEY,
        TC_BASE_URL: tc.url,
        WEBHOOK_PORT: String((busy.address() as AddressInfo).port),
        DATA_DIR: path.join(cwd, "data"),
      });
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /npm start is running, so its webhook listener receives deliveries/);
    } finally {
      busy.close();
      tc.close();
    }
  });
});
