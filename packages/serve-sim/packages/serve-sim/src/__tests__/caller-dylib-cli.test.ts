import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { freePortAsync, useTempStateDir, withShimsAsync } from "./helpers";

function expectStartupDiagnostics(stderr: string) {
  const lines = stderr.trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(line).toStartWith("[startup] ");
    expect(JSON.parse(line.slice("[startup] ".length))).toMatchObject({
      phase: expect.any(String),
    });
  }
}

const bundleDir = mkdtempSync(join(tmpdir(), "serve-sim-caller-cli-node-"));
const diagnostic = "SERVE_SIM_ADDITIONAL_DYLIBS needs absolute paths to existing dylibs";
const UDID = "11111111-2222-3333-4444-555555555555";
let entrypoint: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../index.ts")],
    outdir: join(bundleDir, "dist"),
    naming: "[name].mjs",
    target: "node",
  });
  if (!build.success) throw new AggregateError(build.logs, "CLI fixture build failed");
  entrypoint = build.outputs[0]!.path;
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

test.each(["none", "publish", "stop", "missing-loader", "lock-timeout"] as const)(
  "plain default initialization handles %s",
  async (failureMode) => {
    const failFirst = failureMode === "publish" || failureMode === "stop";
    const state = useTempStateDir();
    const artifacts = join(bundleDir, "dist", "capability-loader");
    const loader = join(artifacts, "libServeSimCapabilityLoader.dylib");
    const clipboard = join(state.dir, "libSimPasteboardReader.dylib");
    const environment = join(state.dir, "env.json");
    const calls = join(state.dir, "calls.jsonl");
    const failure = join(state.dir, "fail-once");
    const preload = join(state.dir, "no-gui.cjs");
    writeFileSync(
      preload,
      `const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, ...args) {
  if (file === '/usr/bin/xcode-select') return ${JSON.stringify(join(state.dir, "fake-xcode"))};
  if (file === '/usr/bin/open') throw new Error('GUI opening forbidden in this test');
  return original.call(this, file, ...args);
};
require('node:module').syncBuiltinESMExports();
${
  failureMode === "lock-timeout"
    ? `
const now = Date.now;
let lockTime = 0;
Date.now = () => new Error().stack.includes('withStateLock') ? (lockTime += 90001) : now();
`
    : ""
}
`,
    );
    mkdirSync(artifacts, { recursive: true });
    if (failureMode !== "missing-loader") writeFileSync(loader, "");
    writeFileSync(clipboard, "");
    writeFileSync(environment, JSON.stringify({ DYLD_INSERT_LIBRARIES: "/foreign.dylib" }));
    if (failFirst) writeFileSync(failure, "");
    try {
      await withShimsAsync(
        {
          xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[1] === 'list') console.log(JSON.stringify({ devices: { iOS: [{ udid: '${UDID}', state: 'Booted' }] } }));
else if (args[1] === 'bootstatus') {}
else if (args[1] === 'spawn' && args[3] === 'launchctl') {
  const file = ${JSON.stringify(environment)};
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [,,, , command, name, value] = args;
  if (command === 'setenv' && name === 'DYLD_INSERT_LIBRARIES' && fs.existsSync(${JSON.stringify(failure)})) {
    fs.unlinkSync(${JSON.stringify(failure)});
    ${failureMode === "stop" ? "process.kill(process.ppid, 'SIGTERM'); setTimeout(() => process.exit(1), 100); return;" : "process.exit(1);"}
  }
  if (command === 'getenv') process.stdout.write(env[name] || '');
  if (command === 'setenv') env[name] = value;
  if (command === 'unsetenv') delete env[name];
  fs.writeFileSync(file, JSON.stringify(env));
} else process.exit(1);
`,
        },
        async () => {
          const port = await freePortAsync();
          const child = Bun.spawn(
            ["node", "--require", preload, entrypoint, UDID, "--quiet", "--port", String(port)],
            {
              env: {
                ...process.env,
                SERVE_SIM_STATE_DIR: state.dir,
                SERVE_SIM_SIMPB_DIR: state.dir,
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
          const stderr = new Response(child.stderr).text();
          const reader = child.stdout.getReader();
          let output = "";
          try {
            while (!output.includes("\n")) {
              const { done, value } = await reader.read();
              if (done) {
                if (["stop", "missing-loader", "lock-timeout"].includes(failureMode)) break;
                throw new Error(`No readiness: ${output} ${await stderr}`);
              }
              output += new TextDecoder().decode(value);
            }
            if (["stop", "missing-loader", "lock-timeout"].includes(failureMode)) {
              expect(await child.exited).toBe(failureMode === "stop" ? 0 : 1);
              const diagnostic = await stderr;
              expect(diagnostic).not.toContain("retrying separately");
              if (failureMode === "stop") expect(output).toBe("");
              else
                expect(JSON.parse(output)).toEqual({
                  error: expect.stringContaining(
                    failureMode === "missing-loader"
                      ? "Capability loader not built"
                      : "Timed out after 90s",
                  ),
                });
              const trace: string[][] = readFileSync(calls, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
              expect(
                trace.filter(
                  (a) =>
                    a[4] === "setenv" &&
                    a[5] === "DYLD_INSERT_LIBRARIES" &&
                    a[6]?.includes("libServeSimCapabilityLoader"),
                ),
              ).toHaveLength(failureMode === "stop" ? 1 : 0);
              expect(JSON.parse(readFileSync(environment, "utf8")).DYLD_INSERT_LIBRARIES).toBe(
                "/foreign.dylib",
              );
              return;
            }
            expect(JSON.parse(output.trim())).toMatchObject({ device: UDID, port });
            const launch = JSON.parse(readFileSync(join(state.dir, `launch-${UDID}.json`), "utf8"));
            expect(launch.sessionPids).toEqual([child.pid]);
            expect(launch.capabilities.clipboard.ownerPid).toBe(child.pid);
            const trace: string[][] = readFileSync(calls, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            expect(trace.filter((a) => a[1] === "bootstatus")).toHaveLength(1);
            expect(
              trace.filter((a) => a[4] === "setenv" && a[5] === "DYLD_INSERT_LIBRARIES"),
            ).toHaveLength(failFirst ? 4 : 1);
            expect(trace.some((a) => ["install", "launch", "openurl"].includes(a[1]!))).toBe(false);
            child.kill("SIGTERM");
            while (!(await reader.read()).done) {}
            expect(await child.exited).toBe(0);
            if (failFirst) expect(await stderr).toContain("retrying separately");
            else expectStartupDiagnostics(await stderr);
            expect(JSON.parse(readFileSync(environment, "utf8")).DYLD_INSERT_LIBRARIES).toBe(
              "/foreign.dylib",
            );
          } finally {
            clearTimeout(timeout);
            child.kill("SIGKILL");
            await child.exited;
            reader.releaseLock();
          }
        },
      );
    } finally {
      rmSync(loader, { force: true });
      state.restore();
    }
  },
  15_000,
);

async function runCLI(args: string[], env: Record<string, string | undefined>, preload?: string) {
  const child = Bun.spawn(
    [
      "node",
      "--unhandled-rejections=strict",
      ...(preload ? ["--require", preload] : []),
      entrypoint,
      ...args,
    ],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
  }
}

test.each([
  ["relative", false],
  ["relative", "before"],
  ["relative", "after"],
  ["missing", false],
  ["missing", "before"],
  ["missing", "after"],
] as const)(
  "camera injection rejects a %s caller dylib before resolving a device (quiet=%s)",
  async (kind, quiet) => {
    const state = useTempStateDir();
    const log = join(state.dir, "calls.jsonl");
    const guard = kind === "relative" ? "guard.dylib" : join(state.dir, "missing.dylib");
    try {
      await withShimsAsync(
        {
          xcrun: `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
`,
        },
        async () => {
          // A device name forces resolution; the refusing shim prevents helper startup on old code.
          const result = await runCLI(
            [
              ...(quiet === "before" ? ["--quiet"] : []),
              "camera",
              "dev.example.app",
              "-d",
              "Caller validation test",
              ...(quiet === "after" ? ["--quiet"] : []),
            ],
            {
              SERVE_SIM_ADDITIONAL_DYLIBS: guard,
            },
          );
          expect(result.exitCode).toBe(1);
          if (quiet) {
            expect(JSON.parse(result.stdout)).toEqual({ error: `${diagnostic}: ${guard}` });
            expect(result.stderr).toBe("");
          } else {
            expect(result.stderr).toContain(diagnostic);
          }
          expect(existsSync(log)).toBe(false);
        },
      );
    } finally {
      state.restore();
    }
  },
  15_000,
);

test.each(["status", "--stop-webcam"])(
  "camera %s stays available when a caller dylib disappears",
  async (command) => {
    const state = useTempStateDir();
    try {
      const result = await runCLI(["camera", command, "-d", UDID, "--quiet"], {
        SERVE_SIM_ADDITIONAL_DYLIBS: join(state.dir, "missing.dylib"),
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(
        command === "status" ? { udid: UDID, alive: false } : { udid: UDID, stopped: true },
      );
      expect(result.stderr).toBe("");
    } finally {
      state.restore();
    }
  },
  15_000,
);

test("quiet preview reports a caller dylib removed after boot as one startup JSON error", async () => {
  const state = useTempStateDir();
  const guard = join(state.dir, "guard.dylib");
  const log = join(state.dir, "calls.jsonl");
  const count = join(state.dir, "bootstatus-count");
  const preload = join(state.dir, "preload.cjs");
  writeFileSync(guard, "");
  // The CLI uses absolute GUI commands; keep them away from the host's Xcode and Simulator.
  writeFileSync(
    preload,
    `const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, ...args) {
  if (file === '/usr/bin/xcode-select') return ${JSON.stringify(join(state.dir, "fake-xcode"))};
  if (file === '/usr/bin/open') throw new Error('GUI opening forbidden in this test');
  return original.call(this, file, ...args);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  try {
    await withShimsAsync(
      {
        xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'list') console.log(JSON.stringify({devices: {iOS: [{udid: '${UDID}', state: 'Booted'}]}}));
if (args[1] === 'bootstatus') {
  const file = ${JSON.stringify(count)};
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
  fs.writeFileSync(file, String(n));
  if (n === 1) fs.unlinkSync(${JSON.stringify(guard)});
}
if (args[3] === 'launchctl') {
  const file = ${JSON.stringify(state.dir)} + '/' + args[5];
  if (args[4] === 'getenv' && fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
  if (args[4] === 'setenv') fs.writeFileSync(file, args[6]);
  if (args[4] === 'unsetenv') fs.rmSync(file, {force: true});
}
`,
      },
      async () => {
        // This bundle has no clipboard reader next to it, and its warning would reach stderr.
        const result = await runCLI(
          [UDID, "--quiet", "--port", "0", "--disable", "clipboard"],
          {
            SERVE_SIM_ADDITIONAL_DYLIBS: guard,
            SERVE_SIM_CAPTURE_CA_DIR: join(state.dir, "ca"),
          },
          preload,
        );
        expect(result.exitCode).toBe(1);
        expect(result.stdout.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(result.stdout)).toEqual({ error: `${diagnostic}: ${guard}` });
        expectStartupDiagnostics(result.stderr);
        const calls: string[][] = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls.filter((args) => args[1] === "bootstatus")).toHaveLength(1);
      },
    );
  } finally {
    state.restore();
  }
}, 15_000);

test("plain preview initializes its exact target once and clears only stale inserts before ready", async () => {
  const state = useTempStateDir();
  const guard = join(state.dir, "guard.dylib");
  const staleLoader = join(state.dir, "libServeSimCapabilityLoader.dylib");
  const environment = join(state.dir, "launchctl.json");
  const log = join(state.dir, "calls.jsonl");
  const bootFinished = join(state.dir, "boot-finished");
  const preload = join(state.dir, "preload.cjs");
  const retained = `/caller-owned.dylib:${guard}`;
  writeFileSync(guard, "");
  writeFileSync(staleLoader, "");
  writeFileSync(
    environment,
    JSON.stringify({ DYLD_INSERT_LIBRARIES: `${retained}:${staleLoader}` }),
  );
  writeFileSync(
    preload,
    `const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, ...args) {
  if (file === '/usr/bin/xcode-select') return ${JSON.stringify(join(state.dir, "fake-xcode"))};
  if (file === '/usr/bin/open') throw new Error('GUI opening forbidden in this test');
  return original.call(this, file, ...args);
};
require('node:module').syncBuiltinESMExports();
`,
  );
  try {
    await withShimsAsync(
      {
        xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'simctl') process.exit(1);
if (args[1] === 'list') {
  console.log(JSON.stringify({ devices: { iOS: [{ udid: '${UDID}', state: 'Booted' }] } }));
} else if (args[1] === 'bootstatus' && args[2] === '${UDID}' && args[3] === '-b') {
  if (!process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES?.split(':').includes(${JSON.stringify(guard)})) process.exit(1);
  fs.writeFileSync(${JSON.stringify(bootFinished)}, 'ready');
} else if (args[1] === 'spawn' && args[2] === '${UDID}' && args[3] === 'launchctl') {
  if (!fs.existsSync(${JSON.stringify(bootFinished)})) process.exit(1);
  const file = ${JSON.stringify(environment)};
  const values = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (args[4] === 'getenv') console.log(values[args[5]] ?? '');
  else if (args[4] === 'setenv') values[args[5]] = args[6];
  else if (args[4] === 'unsetenv') delete values[args[5]];
  else process.exit(1);
  fs.writeFileSync(file, JSON.stringify(values));
} else process.exit(1);
`,
      },
      async () => {
        const port = await freePortAsync();
        // This bundle has no clipboard reader next to it, and its warning would reach stderr.
        const child = Bun.spawn(
          [
            "node",
            "--unhandled-rejections=strict",
            "--require",
            preload,
            entrypoint,
            UDID,
            "--quiet",
            "--port",
            String(port),
            "--host",
            "127.0.0.1",
            "--disable",
            "clipboard",
          ],
          {
            env: {
              ...process.env,
              SERVE_SIM_STATE_DIR: state.dir,
              SERVE_SIM_ADDITIONAL_DYLIBS: guard,
              SERVE_SIM_CAPTURE_CA_DIR: join(state.dir, "ca"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
        const stderr = new Response(child.stderr).text();
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let stdout = "";
        try {
          while (!stdout.includes("\n")) {
            const { done, value } = await reader.read();
            if (done) throw new Error(`Preview exited before ready: ${stdout}\n${await stderr}`);
            stdout += decoder.decode(value, { stream: true });
          }
          const ready = JSON.parse(stdout.trim());
          expect(ready).toMatchObject({ device: UDID, port, url: `http://127.0.0.1:${port}` });
          const health = await fetch(`${ready.url}/healthz`, {
            signal: AbortSignal.timeout(2_000),
          });
          expect(health.status).toBe(200);
          expect(await health.json()).toEqual({ status: "ok" });
          const calls: string[][] = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(calls.filter((args) => args[1] === "bootstatus")).toEqual([
            ["simctl", "bootstatus", UDID, "-b"],
          ]);
          expect(calls.some((args) => args[1] === "spawn" && args[4] === "getenv")).toBe(true);
          expect(
            calls.filter((args) => ["install", "launch", "openurl"].includes(args[1]!)),
          ).toEqual([]);
          expect(
            calls.filter((args) => args[1] === "spawn").every((args) => args[2] === UDID),
          ).toBe(true);
          expect(JSON.parse(readFileSync(environment, "utf8")).DYLD_INSERT_LIBRARIES).toBe(
            retained,
          );
          expect(
            JSON.parse(readFileSync(join(state.dir, `server-${UDID}.json`), "utf8")),
          ).toMatchObject({ device: UDID, pid: child.pid, port });
          child.kill("SIGTERM");
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            stdout += decoder.decode(value, { stream: true });
          }
          expect(await child.exited).toBe(0);
          expect(stdout.trim().split("\n")).toHaveLength(1);
          expectStartupDiagnostics(await stderr);
          expect(existsSync(join(state.dir, `server-${UDID}.json`))).toBe(false);
        } finally {
          child.kill("SIGKILL");
          await child.exited;
          clearTimeout(deadline);
          reader.releaseLock();
        }
      },
    );
  } finally {
    state.restore();
  }
}, 15_000);
