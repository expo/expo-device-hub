import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useTempStateDir, withShimsAsync } from "./helpers";

const bundleDir = mkdtempSync(join(tmpdir(), "serve-sim-caller-cli-node-"));
const diagnostic = "SERVE_SIM_ADDITIONAL_DYLIBS needs absolute paths to existing dylibs";
const UDID = "11111111-2222-3333-4444-555555555555";
let entrypoint: string;
beforeAll(async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../index.ts")],
    outdir: bundleDir,
    naming: "[name].mjs",
    target: "node",
  });
  if (!build.success) throw new AggregateError(build.logs, "CLI fixture build failed");
  entrypoint = build.outputs[0]!.path;
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

async function runCLI(args: string[], env: Record<string, string | undefined>, preload?: string) {
  const child = Bun.spawn(["node", "--unhandled-rejections=strict", ...(preload ? ["--require", preload] : []), entrypoint, ...args], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(deadline);
    child.kill("SIGKILL");
    await child.exited;
  }
}

test.each([
  ["relative", false], ["relative", "before"], ["relative", "after"],
  ["missing", false], ["missing", "before"], ["missing", "after"],
] as const)("camera injection rejects a %s caller dylib before resolving a device (quiet=%s)", async (kind, quiet) => {
  const state = useTempStateDir();
  const log = join(state.dir, "calls.jsonl");
  const guard = kind === "relative" ? "guard.dylib" : join(state.dir, "missing.dylib");
  try {
    await withShimsAsync({ xcrun: `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(1);
` }, async () => {
      // A device name forces resolution; the refusing shim prevents helper startup on old code.
      const result = await runCLI([
        ...(quiet === "before" ? ["--quiet"] : []),
        "camera", "dev.example.app", "-d", "Caller validation test",
        ...(quiet === "after" ? ["--quiet"] : []),
      ], {
        SERVE_SIM_ADDITIONAL_DYLIBS: guard,
      });
      expect(result.exitCode).toBe(1);
      if (quiet) {
        expect(JSON.parse(result.stdout)).toEqual({ error: `${diagnostic}: ${guard}` });
        expect(result.stderr).toBe("");
      } else {
        expect(result.stderr).toContain(diagnostic);
      }
      expect(existsSync(log)).toBe(false);
    });
  } finally {
    state.restore();
  }
}, 15_000);

test.each(["status", "--stop-webcam"])("camera %s stays available when a caller dylib disappears", async (command) => {
  const state = useTempStateDir();
  try {
    const result = await runCLI(["camera", command, "-d", UDID, "--quiet"], {
      SERVE_SIM_ADDITIONAL_DYLIBS: join(state.dir, "missing.dylib"),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject(command === "status" ? { udid: UDID, alive: false } : { udid: UDID, stopped: true });
    expect(result.stderr).toBe("");
  } finally {
    state.restore();
  }
}, 15_000);

test("quiet preview reports a caller dylib removed after boot as one startup JSON error", async () => {
  const state = useTempStateDir();
  const guard = join(state.dir, "guard.dylib");
  const log = join(state.dir, "calls.jsonl");
  const count = join(state.dir, "bootstatus-count");
  const preload = join(state.dir, "preload.cjs");
  writeFileSync(guard, "");
  // The CLI uses absolute GUI commands; keep them away from the host's Xcode and Simulator.
  writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, ...args) {
  if (file === '/usr/bin/xcode-select') return ${JSON.stringify(join(state.dir, "fake-xcode"))};
  if (file === '/usr/bin/open') throw new Error('GUI opening forbidden in this test');
  return original.call(this, file, ...args);
};
require('node:module').syncBuiltinESMExports();
`);
  try {
    await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'list') console.log(JSON.stringify({devices: {iOS: [{udid: '${UDID}', state: 'Booted'}]}}));
if (args[1] === 'bootstatus') {
  const file = ${JSON.stringify(count)};
  const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1;
  fs.writeFileSync(file, String(n));
  if (n === 2) fs.unlinkSync(${JSON.stringify(guard)});
}
if (args[3] === 'launchctl') {
  const file = ${JSON.stringify(state.dir)} + '/' + args[5];
  if (args[4] === 'getenv' && fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
  if (args[4] === 'setenv') fs.writeFileSync(file, args[6]);
  if (args[4] === 'unsetenv') fs.rmSync(file, {force: true});
}
` }, async () => {
      // This bundle has no clipboard reader next to it, and its warning would reach stderr.
      const result = await runCLI([UDID, "--quiet", "--port", "0", "--disable", "clipboard"], {
        SERVE_SIM_ADDITIONAL_DYLIBS: guard,
        SERVE_SIM_CAPTURE_CA_DIR: join(state.dir, "ca"),
      }, preload);
      expect(result.exitCode).toBe(1);
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: `${diagnostic}: ${guard}` });
      expect(result.stderr).toBe("");
      const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(calls.filter(args => args[1] === "bootstatus")).toHaveLength(2);
    });
  } finally {
    state.restore();
  }
}, 15_000);
