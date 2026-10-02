import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import type { Socket } from "node:net";

import { describe, expect, test } from "bun:test";

import { locateMitmdump, startMitmProxy } from "../mitm-engine";
import { parseCaptureProxy } from "../upstream";
import { toHarEntry } from "../har";
import { CaptureStore } from "../store";

const describeOrSkip = locateMitmdump() ? describe : describe.skip;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function curl(address: string, url: string): Promise<string> {
  return new Promise((resolve) => execFile("curl", ["-s", "-k", "--noproxy", "", "--max-time", "10", "-x", `http://${address}`, url], (_error, out) => resolve(out)));
}

async function waitFor(read: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!read() && Date.now() < deadline) await Bun.sleep(25);
  expect(read()).toBe(true);
}

describeOrSkip("capture through a configured HTTP proxy", () => {
  test("uses absolute HTTP requests and authenticated CONNECT, keeping credentials out of capture and argv", async () => {
    const secret = "p@ss:upstream-secret";
    const auth = "Basic " + Buffer.from(`user:${secret}`).toString("base64");
    const seen: { method: string; url: string; auth?: string }[] = [];
    const upstream = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers["proxy-authorization"] });
      res.end("via-upstream");
    });
    upstream.on("connect", (req, socket) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers["proxy-authorization"] });
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const port = await listen(upstream);
    const store = new CaptureStore();
    const proxy = await startMitmProxy(store, {
      fields: ["header"],
      upstream: parseCaptureProxy(`http://user:${encodeURIComponent(secret)}@127.0.0.1:${port}`),
    });
    const config = join(dirname(proxy.portFile), "config.yaml");
    try {
      expect(statSync(config).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(config)).mode & 0o777).toBe(0o700);
      expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ upstream_auth: `user:${secret}` });
      const argv = execFileSync("ps", ["-axo", "args"], { encoding: "utf8" }).split("\n").filter((line) => line.includes(dirname(config))).join("\n");
      expect(argv).toContain("upstream:http://127.0.0.1:");
      expect(argv).not.toContain(secret);
      expect(argv).not.toContain(auth);
      expect(await curl(proxy.address, "http://unresolvable.serve-sim.invalid/items?id=1")).toBe("via-upstream");
      expect(seen[0]).toEqual({ method: "GET", url: "http://unresolvable.serve-sim.invalid/items?id=1", auth });
      await curl(proxy.address, "https://secure.serve-sim.invalid/login");
      expect(seen).toContainEqual({ method: "CONNECT", url: "secure.serve-sim.invalid:443", auth });
      await waitFor(() => store.list().some((row) => row.status === 200));
      const rows = store.list();
      const har = rows.map((row) => toHarEntry(row, store.body(row.id)));
      for (const records of [JSON.stringify(rows), JSON.stringify(har)]) {
        expect(records).not.toContain(secret);
        expect(records).not.toContain(auth);
      }
      const request = rows.find((row) => row.status === 200)!;
      expect(store.body(request.id)?.requestHeaders["Proxy-Authorization"] ?? store.body(request.id)?.requestHeaders["proxy-authorization"]).toBe("[REDACTED]");
    } finally {
      await proxy.close();
      await close(upstream);
    }
    expect(existsSync(config)).toBe(false);
  }, 30_000);

  test("fails a refused proxy request without falling back to the reachable origin", async () => {
    let directRequests = 0;
    const origin = createServer((_req, res) => { directRequests++; res.end("direct"); });
    const originPort = await listen(origin);
    const upstream = createServer((_req, res) => { res.writeHead(407); res.end("auth-required"); });
    const upstreamPort = await listen(upstream);
    const store = new CaptureStore();
    const proxy = await startMitmProxy(store, { upstream: parseCaptureProxy(`http://127.0.0.1:${upstreamPort}`) });
    try {
      expect(await curl(proxy.address, `http://127.0.0.1:${originPort}/refused`)).toBe("auth-required");
      expect(directRequests).toBe(0);
      await waitFor(() => store.list().some((row) => row.status === 407));
    } finally {
      await proxy.close(); await close(upstream); await close(origin);
    }
  }, 30_000);

  test("goes direct when no upstream is configured", async () => {
    const origin = createServer((_req, res) => res.end("direct"));
    const port = await listen(origin);
    const proxy = await startMitmProxy(new CaptureStore(), { upstream: null });
    try { expect(await curl(proxy.address, `http://127.0.0.1:${port}/direct`)).toBe("direct"); }
    finally { await proxy.close(); await close(origin); }
  }, 30_000);

  test("closes promptly while an upstream has not answered", async () => {
    let asked!: () => void;
    const entered = new Promise<void>((resolve) => { asked = resolve; });
    const sockets = new Set<Socket>();
    const upstream = createServer(() => asked());
    upstream.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    const port = await listen(upstream);
    const proxy = await startMitmProxy(new CaptureStore(), { upstream: parseCaptureProxy(`http://127.0.0.1:${port}`) });
    const request = curl(proxy.address, "http://pending.serve-sim.invalid/");
    try {
      await entered;
      const started = Date.now();
      await proxy.close();
      expect(Date.now() - started).toBeLessThan(2_500);
      await request;
    } finally {
      await proxy.close(); for (const socket of sockets) socket.destroy(); await close(upstream);
    }
  }, 30_000);
});
