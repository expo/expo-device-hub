import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "bun:test";

import { forwardAddonDiagnostics } from "../mitm-engine";

const ADDON = join(import.meta.dir, "..", "mitm-addon", "servesim_capture.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("forwardAddonDiagnostics", () => {
  test("passes on the addon's own lines only, including split ones", () => {
    const stream = new PassThrough();
    const seen: string[] = [];
    forwardAddonDiagnostics(stream, (message) => seen.push(message));
    stream.write("mitmdump chatter\n[servesim-capture] stopped with 3 cap");
    stream.write("ture record(s) not delivered\n");
    expect(seen).toEqual(["[servesim-capture] stopped with 3 capture record(s) not delivered"]);
  });
});

(hasPython ? describe : describe.skip)("addon shutdown", () => {
  async function shutDownWithStalledControl(records: number): Promise<void> {
    // Accepts connections and never answers, so every send runs until its timeout.
    const stalled: Server = createServer(() => {});
    await new Promise<void>((done) => stalled.listen(0, "127.0.0.1", done));
    const port = (stalled.address() as { port: number }).port;
    try {
      const script = [
        "import importlib.util, sys, time",
        `spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(ADDON)})`,
        "addon = importlib.util.module_from_spec(spec); spec.loader.exec_module(addon)",
        `for i in range(${records}): addon._post('/response', {'id': str(i)})`,
        "started = time.monotonic(); addon.done()",
        "print(f'elapsed={time.monotonic() - started:.2f}')",
      ].join("\n");
      const child = spawn("python3", ["-c", script], {
        env: { ...process.env, SERVE_SIM_CAPTURE_CONTROL_URL: `http://127.0.0.1:${port}`, SERVE_SIM_CAPTURE_CONTROL_TOKEN: "t" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const code = await new Promise<number | null>((done) => child.on("exit", done));
      expect(code).toBe(0);
      const elapsed = Number(/elapsed=([\d.]+)/.exec(stdout)?.[1]);
      expect(elapsed).toBeLessThan(3);
      // Every record was lost, whether its send timed out, was still running, or never started.
      expect(stderr).toContain(`[servesim-capture] stopped with ${records} capture record(s) not delivered`);
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((done) => stalled.close(() => done()));
    }
  }

  test("stops inside the kill window and reports queued records a stalled control server never took", async () => {
    await shutDownWithStalledControl(5);
  }, 20_000);

  test("reports a record whose send timed out even when the reporter finished in time", async () => {
    // One send times out after 2 s, inside the 2.5 s window, so the reporter exits before done() returns.
    await shutDownWithStalledControl(1);
  }, 20_000);

  async function runWithControl(reply: (res: import("node:http").ServerResponse) => void, records: number) {
    const server: Server = createServer((_req, res) => reply(res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    try {
      const script = [
        "import importlib.util, time",
        `spec = importlib.util.spec_from_file_location("addon", ${JSON.stringify(ADDON)})`,
        "addon = importlib.util.module_from_spec(spec); spec.loader.exec_module(addon)",
        `for i in range(${records}): addon._post('/response', {'id': str(i)})`,
        "time.sleep(1)",
        "addon.done()",
      ].join("\n");
      const child = spawn("python3", ["-c", script], {
        env: { ...process.env, SERVE_SIM_CAPTURE_CONTROL_URL: `http://127.0.0.1:${port}`, SERVE_SIM_CAPTURE_CONTROL_TOKEN: "t" },
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      expect(await new Promise<number | null>((done) => child.on("exit", done))).toBe(0);
      return stderr;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  test("warns once when posts fail during capture and counts them at shutdown", async () => {
    const stderr = await runWithControl((res) => res.writeHead(500).end(), 2);
    expect(stderr.match(/could not deliver a capture record/g)).toHaveLength(1);
    expect(stderr).toContain("[servesim-capture] stopped with 2 capture record(s) not delivered");
  }, 20_000);

  test("counts a record the control server refuses with ok: false", async () => {
    const stderr = await runWithControl((res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":false}'), 1);
    expect(stderr).toContain("[servesim-capture] stopped with 1 capture record(s) not delivered");
  }, 20_000);

  test("stays quiet when every record is delivered", async () => {
    const stderr = await runWithControl((res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'), 2);
    expect(stderr).not.toContain("[servesim-capture]");
  }, 20_000);
});
