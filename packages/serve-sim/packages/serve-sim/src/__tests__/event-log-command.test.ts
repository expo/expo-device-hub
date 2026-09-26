import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { inProcessServeSimState } from "../state";
import { EXIT_0_SHIM, UDID, freePortAsync, installShims, useTempStateDir } from "./helpers";

const CLI_PATH = resolve(import.meta.dir, "../index.ts");

describe("serve-sim event-log", () => {
  let server: Server;
  let owner: ChildProcess | undefined;
  let run: ChildProcess | undefined;
  let shims: ReturnType<typeof installShims>;
  let stateDir: ReturnType<typeof useTempStateDir>;
  const requested: string[] = [];

  beforeAll(async () => {
    // An xcrun that lists nothing, so the CLI skips its booted-device check for this fake device.
    shims = installShims({ xcrun: EXIT_0_SHIM });
    stateDir = useTempStateDir();
    const port = await freePortAsync();
    server = createServer((req, res) => {
      requested.push(req.url ?? "");
      if (req.url?.startsWith("/.sim/api/event-log")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events: [] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
    // A throwaway owner, so a stale-state check can never signal the test runner.
    owner = spawn("sleep", ["60"]);
    const state = { ...inProcessServeSimState(UDID, port, "/.sim"), pid: owner.pid! };
    writeFileSync(join(stateDir.dir, `server-${UDID}.json`), JSON.stringify(state));
  });

  afterAll(async () => {
    run?.kill();
    owner?.kill();
    await new Promise<void>((done) => server.close(() => done()));
    stateDir.restore();
    shims.restore();
  });

  test("reads the event log below an embedded server's mount", async () => {
    // The fake server lives in this process, so the CLI must run without blocking its event loop.
    run = spawn(process.execPath, [CLI_PATH, "event-log", "--json", "-d", UDID], { env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    run.stdout!.on("data", (chunk) => (stdout += chunk));
    run.stderr!.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise<number | null>((done) => run!.on("close", done));
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ events: [] });
    expect(requested).toEqual([`/.sim/api/event-log?device=${UDID}`]);
  }, 60_000);
});
