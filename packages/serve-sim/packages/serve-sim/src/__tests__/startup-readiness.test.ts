import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { freePortAsync } from "./helpers";

const UDID = "11111111-2222-3333-4444-555555555555";
const CLI = join(import.meta.dir, "../index.ts");

describe.each([false, true])("startup failures (quiet=%s)", (quiet) => {
  test.each([
    ["bootstatus", false, "bootstatus failed before services were ready", ["bootstatus"]],
    ["bootstatus", true, "bootstatus failed before services were ready", ["bootstatus"]],
    ["launch", true, "launch denied", ["bootstatus", "launch"]],
    ["openurl", true, "openurl denied", ["bootstatus", "launch", "openurl"]],
  ])(
    "a failed startup %s prevents readiness (launch=%s)",
    async (failedCommand, withLaunch, diagnostic, expectedSteps) => {
      const directory = await mkdtemp(join(tmpdir(), "serve-sim-startup-test-"));
      const trace = join(directory, "trace.jsonl");
      await writeFile(
        join(directory, "xcrun"),
        `#!/usr/bin/env node
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  fs.appendFileSync(process.env.STARTUP_TRACE, JSON.stringify(args) + '\\n');
  if (args[0] === 'simctl' && args[1] === 'list') {
    console.log(JSON.stringify({ devices: { iOS: [{ udid: '${UDID}', name: 'Startup test', state: 'Booted' }] } }));
  } else if (args[0] === 'simctl' && args[1] === '${failedCommand}') {
    console.error('${diagnostic}');
    process.exit(1);
  }
  `,
        { mode: 0o755 },
      );
      const port = await freePortAsync();
      const child = Bun.spawn(
        [
          "bun",
          CLI,
          UDID,
          "--port", String(port),
          ...(withLaunch ? [
            "--launch-app-identifier", "dev.example.app",
            "--open-url", "example://startup",
          ] : []),
          ...(quiet ? ["--quiet"] : []),
        ],
        {
          env: {
            ...Bun.env,
            DEVELOPER_DIR: directory,
            PATH: `${directory}:${Bun.env.PATH}`,
            SERVE_SIM_STATE_DIR: join(directory, "state"),
            SERVE_SIM_CAPTURE_CA_DIR: join(directory, "capture-ca"),
            STARTUP_TRACE: trace,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const deadline = setTimeout(() => child.kill(), 5_000);
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(await child.exited).toBe(1);
        if (quiet) {
          expect(stdout.trim().split("\n")).toHaveLength(1);
          expect(JSON.parse(stdout)).toEqual({ error: expect.stringContaining(diagnostic) });
        } else {
          expect(stderr).toContain(diagnostic);
        }
        const commands = (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        const steps = commands.map((args) => args[1])
          .filter((step) => ["bootstatus", "launch", "openurl"].includes(step!));
        expect(steps).toEqual(expectedSteps);
        if (failedCommand === "bootstatus") {
          expect(commands.some((args) => args[1] === "spawn")).toBe(false);
        }
      } finally {
        clearTimeout(deadline);
        child.kill();
        await child.exited;
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
