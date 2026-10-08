import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useTempStateDir, withShimsAsync } from "./helpers";

const bundleDir = mkdtempSync(join(tmpdir(), "serve-sim-grid-start-node-"));
let entrypoint: string;
beforeAll(async () => {
  // Exercise the current source under Node's production unhandled-rejection semantics.
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/grid-start-dylibs.child.ts")],
    outdir: bundleDir,
    naming: "[name].mjs",
    target: "node",
  });
  if (!build.success) throw new AggregateError(build.logs, "Grid fixture build failed");
  entrypoint = build.outputs[0]!.path;
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

test.each(["before boot", "before bootstatus"])("grid start reports a caller dylib removed %s without crashing Node", async (timing) => {
  const state = useTempStateDir();
  const guard = join(state.dir, "guard.dylib");
  const log = join(state.dir, "calls.jsonl");
  writeFileSync(guard, "");
  try {
    await withShimsAsync({ xcrun: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[1] === 'boot') fs.unlinkSync(${JSON.stringify(guard)});
` }, async () => {
      const child = Bun.spawn(["node", "--unhandled-rejections=strict", entrypoint, timing], {
        env: { ...process.env, SERVE_SIM_ADDITIONAL_DYLIBS: guard },
        stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        const [result, health] = stdout.trim().split("\n").map(line => JSON.parse(line));
        expect(result).toEqual({ status: 500, body: {
          ok: false,
          error: `SERVE_SIM_ADDITIONAL_DYLIBS needs absolute paths to existing dylibs: ${guard}`,
        } });
        expect(health).toEqual({ health: 200 });
        const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
        expect(calls).toEqual(timing === "before boot" ? [] : [["simctl", "boot", "11111111-2222-3333-4444-555555555555"]]);
      } finally {
        clearTimeout(timeout);
        child.kill("SIGKILL");
        await child.exited;
      }
    });
  } finally {
    state.restore();
  }
}, 15_000);
