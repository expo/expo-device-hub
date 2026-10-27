#!/usr/bin/env bun
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const mode = process.env.SERVE_SIM_BROWSER_FIXTURE_MODE;
const state = process.env.SERVE_SIM_BROWSER_FIXTURE_STATE!;
const profile = process.argv
  .find((arg) => arg.startsWith("--user-data-dir="))!
  .slice("--user-data-dir=".length);
appendFileSync(`${state}.profiles`, `${profile}\n`);
const stall = mode === "launch-failure" || (mode === "launch-timeout" && !existsSync(state));
writeFileSync(state, "started");

let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/json/list") {
      if (++requests === 1) {
        if (mode === "timeout") return new Promise<Response>(() => {});
        return Response.json([]);
      }
      return Response.json([
        { type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/page` },
      ]);
    }
    if (server.upgrade(request)) return;
    return new Response("not found", { status: 404 });
  },
  websocket: {
    message(ws, text) {
      ws.send(JSON.stringify({ id: JSON.parse(String(text)).id, result: {} }));
    },
  },
});
console.error(
  stall
    ? "fixture launch blocked"
    : `DevTools listening on ws://127.0.0.1:${server.port}/devtools/browser/fixture`,
);
