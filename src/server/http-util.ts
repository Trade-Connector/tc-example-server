// Shared helpers for the two node:http servers.

import type { IncomingMessage, ServerResponse } from "node:http";
import { redact } from "../log.ts";

export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body is larger than ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Reads the whole request body as raw bytes, refusing anything over `maxBytes`. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume(); // drain and discard
      reject(new BodyTooLargeError(maxBytes));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      total += chunk.length;
      if (total > maxBytes) {
        failed = true;
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!failed) {
        failed = true;
        reject(error);
      }
    });
  });
}

/**
 * Sends JSON. The serialised text goes through redact() as a last line of defence, so a
 * configured key or secret can never leave the server even if a bug put one in a response.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = redact(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

/** The path part of req.url, without the query string. */
export function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  const raw = req.url ?? "/";
  const q = raw.indexOf("?");
  return new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
}

/**
 * The host to put in a URL for a server bound to `bindHost`, so that the URL both connects and
 * passes the console's Host check: a wildcard bind is reached on loopback, and an IPv6 address goes
 * in brackets. (127.0.0.1 is NOT right for every bind: a server on ::1 alone refuses it.)
 */
export function urlHostFor(bindHost: string): string {
  if (bindHost === "0.0.0.0") return "127.0.0.1";
  if (bindHost === "::") return "[::1]";
  return bindHost.includes(":") ? `[${bindHost}]` : bindHost;
}
