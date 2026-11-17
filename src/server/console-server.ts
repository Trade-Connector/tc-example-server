// The test console: a local web page plus its JSON API, on 127.0.0.1:3000 by default.
//
// This server can act with your API keys, so it defends itself:
// - It binds to loopback only (unless CONSOLE_HOST says otherwise). Never tunnel this port.
// - Host check: requests whose Host header is not this console's own host:port are refused.
//   That stops DNS rebinding, where a malicious web page points its own domain at 127.0.0.1.
// - Token: every /api call must carry the per-run random token (printed at start-up) in the
//   X-Console-Token header. Other websites cannot read it, and cannot send custom headers to
//   this origin without a CORS preflight, which this server never approves. No cookies are used.
// - Static files are served from a fixed list, with a strict Content-Security-Policy.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { log } from "../log.ts";
import { ConsoleError, findRoute, runRoute, type ConsoleContext } from "./console-api.ts";
import { BodyTooLargeError, pathnameOf, queryOf, readBody, sendJson, sendText } from "./http-util.ts";

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

const MAX_JSON_BODY = 1024 * 1024; // 1 MB
const MAX_LARGE_BODY = 40 * 1024 * 1024; // a 25 MB attachment as base64, plus room

export interface ConsoleServerOptions extends ConsoleContext {
  /** The per-run token the page must send. */
  token: string;
  publicDir: string;
}

/** Host header values this console answers to. */
export function allowedHosts(consoleHost: string, port: number): Set<string> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"].includes(consoleHost)) {
    hosts.add(consoleHost.includes(":") ? `[${consoleHost}]:${port}` : `${consoleHost}:${port}`);
  }
  return hosts;
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createConsoleServer(options: ConsoleServerOptions): Server {
  // Worked out from the port actually bound (so CONSOLE_PORT=0 works), on the first request.
  let hosts: Set<string> | null = null;
  let origins: Set<string> = new Set();

  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      log.error("Console request failed", { error: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: { source: "console", code: "INTERNAL", message: "Unexpected error" } });
    });
  });
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts) {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.config.consolePort;
      hosts = allowedHosts(options.config.consoleHost, port);
      origins = new Set([...hosts].map((h) => `http://${h}`));
    }

    // 1. DNS-rebinding defence: only our own Host.
    const host = req.headers.host ?? "";
    if (!hosts.has(host)) {
      req.resume();
      sendText(res, 403, "Host not allowed. Open the console at the URL printed when the server started.");
      return;
    }
    // 2. A browser always sends Origin on cross-site requests; refuse any other site.
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      req.resume();
      sendText(res, 403, "Cross-origin requests are not allowed.");
      return;
    }

    const pathname = pathnameOf(req);

    // 3. Static files (they contain no secrets; the token arrives in the URL fragment).
    if (req.method === "GET" && STATIC_FILES[pathname]) {
      const { file, type } = STATIC_FILES[pathname]!;
      const content = await readFile(path.join(options.publicDir, file));
      res.writeHead(200, { "Content-Type": type, ...SECURITY_HEADERS });
      res.end(content);
      return;
    }
    if (!pathname.startsWith("/api/")) {
      req.resume();
      sendText(res, 404, "Not found");
      return;
    }

    // 4. Every API call needs the per-run token.
    const tokenHeader = req.headers["x-console-token"];
    if (!tokenMatches(typeof tokenHeader === "string" ? tokenHeader : undefined, options.token)) {
      req.resume();
      sendJson(res, 401, {
        error: { source: "console", code: "CONSOLE_TOKEN_REQUIRED", message: "Missing or wrong console token. Open the URL printed at start-up." },
      });
      return;
    }

    let found: ReturnType<typeof findRoute>;
    try {
      found = findRoute(req.method ?? "GET", pathname);
    } catch (error) {
      req.resume();
      const e = error as ConsoleError;
      sendJson(res, e.status ?? 400, { error: { source: "console", code: e.code ?? "BAD_REQUEST", message: e.message } });
      return;
    }
    if (!found) {
      req.resume();
      sendJson(res, 404, { error: { source: "console", code: "NOT_FOUND", message: `No console route ${req.method} ${pathname}` } });
      return;
    }

    // 5. The page says which environment it thinks is active; refuse if the server has moved on
    //    (for example another tab switched to live), so nobody acts on a stale screen.
    if (found.route.envBound) {
      const claimed = req.headers["x-console-environment"];
      if (claimed !== options.guard.environment) {
        req.resume();
        sendJson(res, 409, {
          error: {
            source: "console",
            code: "ENVIRONMENT_CHANGED",
            message: `The console is in ${options.guard.environment} mode, but this page thinks it is in ${String(claimed ?? "an unknown")} mode. Reload the page.`,
          },
          environment: options.guard.environment,
        });
        return;
      }
    }

    // 6. JSON body.
    let body: Record<string, unknown> = {};
    if (req.method === "POST" || req.method === "PATCH") {
      let raw: Buffer;
      try {
        raw = await readBody(req, found.route.largeBody ? MAX_LARGE_BODY : MAX_JSON_BODY);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: { source: "console", code: "PAYLOAD_TOO_LARGE", message: error.message } });
          return;
        }
        throw error;
      }
      if (raw.length > 0) {
        try {
          const parsed: unknown = JSON.parse(raw.toString("utf8"));
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          body = parsed as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { error: { source: "console", code: "BAD_REQUEST", message: "Body must be a JSON object" } });
          return;
        }
      }
    }

    const liveToken = req.headers["x-live-confirmation"];
    const result = await runRoute(options, found, {
      method: req.method ?? "GET",
      query: queryOf(req),
      body,
      liveToken: typeof liveToken === "string" ? liveToken : null,
    });
    sendJson(res, result.status, result.body);
  }
}
