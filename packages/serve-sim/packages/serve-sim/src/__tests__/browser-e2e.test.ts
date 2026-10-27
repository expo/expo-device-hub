import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.each(["timeout", "empty", "launch-timeout", "launch-failure"])(
  "browser discovery tolerates a transient %s response",
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), "serve-sim-browser-startup-"));
    try {
      const chrome = join(root, "chrome");
      writeFileSync(
        chrome,
        `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const mode = process.env.SERVE_SIM_BROWSER_FIXTURE_MODE;
const state = process.env.SERVE_SIM_BROWSER_FIXTURE_STATE;
const profile = process.argv.find(arg => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
appendFileSync(state + ".profiles", profile + "\\n");
const stall = mode === "launch-failure" || (mode === "launch-timeout" && !existsSync(state));
writeFileSync(state, "started");
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    if (new URL(request.url).pathname === "/json/list") {
      if (++requests === 1) {
        if (process.env.SERVE_SIM_BROWSER_FIXTURE_MODE === "timeout") return new Promise(() => {});
        return Response.json([]);
      }
      return Response.json([{ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:" + server.port + "/page" }]);
    }
    if (server.upgrade(request)) return;
    return new Response("not found", { status: 404 });
  },
  websocket: { message(ws, text) { ws.send(JSON.stringify({ id: JSON.parse(String(text)).id, result: {} })); } },
});
console.error(stall ? "fixture launch blocked" : "DevTools listening on ws://127.0.0.1:" + server.port + "/devtools/browser/fixture");
`,
      );
      chmodSync(chrome, 0o700);
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "fixtures/browser-startup.child.ts")],
        {
          env: {
            ...process.env,
            SERVE_SIM_CHROME: chrome,
            SERVE_SIM_BROWSER_FIXTURE_MODE: mode,
            SERVE_SIM_BROWSER_FIXTURE_STATE: join(root, "attempt"),
            SERVE_SIM_BROWSER_STARTUP_TEST_MS: mode.startsWith("launch-") ? "1000" : "15000",
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      if (mode === "launch-failure") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("fixture launch blocked");
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("BROWSER_READY");
      }
      const profiles = readFileSync(join(root, "attempt.profiles"), "utf8").trim().split("\n");
      expect(profiles).toHaveLength(mode.startsWith("launch-") ? 2 : 1);
      for (const profile of profiles) expect(existsSync(profile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);
