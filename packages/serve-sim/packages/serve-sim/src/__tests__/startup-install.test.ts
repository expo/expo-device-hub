import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { freePortAsync } from "./helpers";

const UDID = "11111111-2222-3333-4444-555555555555";
const CLI = join(import.meta.dir, "../index.ts");

describe.each([false, true])("startup installation failures (quiet=%s)", (quiet) => {
  test.each([
    ["dev.example.app", "install", ["bootstatus", "install"]],
    ["dev.example.other", "install", ["bootstatus", "install"]],
    [undefined, "install", ["bootstatus", "install"]],
    ["dev.example.other", "launch", ["bootstatus", "install", "launch"]],
  ] as const)("stops before readiness when launch=%s and %s fails", async (bundleId, failedOperation, expectedSteps) => {
    const diagnostic = `${failedOperation} denied`;
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
} else if (args[0] === 'simctl' && args[1] === '${failedOperation}') {
  console.error('${diagnostic}');
  process.exit(1);
}
`,
      { mode: 0o755 },
    );
    await mkdir(join(directory, "Example.app"));
    await writeFile(join(directory, "Example.app/Info.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.example.app</string></dict></plist>`);
    const port = await freePortAsync();
    const child = Bun.spawn(
      [
        "bun",
        CLI,
        UDID,
        "--port", String(port),
        "--install-app-path", join(directory, "Example.app"),
        ...(bundleId ? ["--launch-app-identifier", bundleId, "--open-url", "example://startup"] : []),
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
        .filter((step) => ["bootstatus", "install", "launch", "openurl"].includes(step!));
      expect(steps).toEqual([...expectedSteps]);
      expect(commands.find((args) => args[1] === "install")).toEqual([
        "simctl", "install", UDID, join(directory, "Example.app"),
      ]);
      if (failedOperation === "launch") {
        expect(commands.find((args) => args[1] === "launch")).toContain(bundleId!);
      }
    } finally {
      clearTimeout(deadline);
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

test.each([
  ["missing", "", "Could not read CFBundleIdentifier"],
  ["non-string", "<integer>123</integer>", "Could not read CFBundleIdentifier"],
  ["empty", "<string></string>", "Could not read CFBundleIdentifier"],
])("rejects %s installation bundle identifiers before touching a device", async (_kind, value, diagnostic) => {
  const directory = await mkdtemp(join(tmpdir(), "serve-sim-bundle-test-"));
  const app = join(directory, "Example.app");
  const trace = join(directory, "simctl-called");
  await mkdir(app);
  await writeFile(join(app, "Info.plist"), `<?xml version="1.0"?>
<plist version="1.0"><dict>${value ? `<key>CFBundleIdentifier</key>${value}` : ""}</dict></plist>`);
  await writeFile(join(directory, "xcrun"), `#!/bin/sh
touch "$STARTUP_TRACE"
exit 1
`, { mode: 0o755 });
  const child = Bun.spawn([
    "bun", CLI, UDID, "--quiet", "--install-app-path", app,
    "--launch-app-identifier", "dev.example.app",
  ], {
    env: {
      ...Bun.env,
      DEVELOPER_DIR: directory,
      PATH: `${directory}:${Bun.env.PATH}`,
      SERVE_SIM_STATE_DIR: join(directory, "state"),
      SERVE_SIM_CAPTURE_CA_DIR: join(directory, "capture-ca"),
      STARTUP_TRACE: trace,
    },
    stdout: "pipe",
    stderr: "ignore",
  });
  const deadline = setTimeout(() => child.kill(), 5_000);
  try {
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: expect.stringContaining(diagnostic) });
    expect(existsSync(trace)).toBe(false);
  } finally {
    clearTimeout(deadline);
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
