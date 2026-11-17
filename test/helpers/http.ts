// A tiny HTTP client for tests, built on node:http so tests can set any Host header
// (fetch does not allow overriding Host). Talks to 127.0.0.1 only: no network.

import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}

export function listenLocal(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

export function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: { host: `127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Waits until check() is truthy (for work done after a response was sent). */
export async function eventually<T>(check: () => T, timeoutMs = 2000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
