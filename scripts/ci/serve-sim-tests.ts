#!/usr/bin/env bun
// serve-sim CI tests, run from packages/serve-sim.
//
//   bun ../../scripts/ci/serve-sim-tests.ts unit       two parallel shards, no simulator
//   bun ../../scripts/ci/serve-sim-tests.ts simulator  simulator files, one at a time
//
// Both phases run the local commands with Bun's --retry=1, so CI gets the same
// isolation as a local run: the unit shards through `bun run test`
// (scripts/test/unit.sh), and the simulator files through `bun run test:e2e`
// (scripts/test/e2e.sh) on the worker's booted simulator. The simulator pass
// runs every file that needs a device: `.e2e.` files and files that call
// requireE2E() or e2eDevice().

import { $, Glob } from "bun";
import { resolve } from "node:path";

const PATHS = ["packages/serve-sim/src/", "packages/serve-sim/scripts/tart/__tests__/"];
const TEST_SCRIPTS = resolve("packages/serve-sim/scripts/test");
const TIMEOUT_MS = 20 * 60_000;

// Test scripts run in their own process groups, so pass cancellation on.
const groups = new Set<number>();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    for (const pid of groups) stop(pid, signal);
    process.exit(1);
  });
}

const stop = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {}
};

// Runs a test script in its own process group. A hang gets a macOS sample of
// every process in the group, then the group is stopped.
async function run(cmd: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const child = Bun.spawn(cmd, { env, detached: true, stdio: ["ignore", "inherit", "inherit"] });
  groups.add(child.pid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error(`::error::${cmd.join(" ")} ran for 20 minutes; sampling and stopping it`);
    for (const pid of Bun.spawnSync(["pgrep", "-g", String(child.pid)]).stdout.toString().split("\n").filter(Boolean)) {
      const report = Bun.spawnSync(["sample", pid, "3", "-mayDie"]).stdout.toString();
      console.error(report.split("\nBinary Images:")[0]!.split("\n").slice(0, 80).join("\n"));
    }
    // SIGTERM first, so the scripts' cleanup runs; SIGKILL if the group ignores it.
    stop(child.pid, "SIGTERM");
    kill = setTimeout(() => stop(child.pid, "SIGKILL"), 10_000);
  }, TIMEOUT_MS);
  let kill: Timer | undefined;
  const code = await child.exited;
  clearTimeout(timer);
  clearTimeout(kill);
  stop(child.pid, "SIGKILL");
  groups.delete(child.pid);
  // A timed-out run fails even if the script exits 0 while it is stopped.
  return timedOut ? 124 : code;
}

async function simulatorFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of PATHS) {
    for await (const file of new Glob(`${dir}**/*.test.{ts,tsx}`).scan()) {
      if (file.includes(".e2e.") || /\b(?:requireE2E|e2eDevice)\s*\(/.test(await Bun.file(file).text())) {
        files.push(`./${file}`);
      }
    }
  }
  return files.sort();
}

// e2e.sh needs a UDID. Only a CI worker, which boots exactly one simulator and
// sets SERVE_SIM_CI_SIMULATOR=1, may take the booted one: on a shared machine
// it can belong to another session.
async function ciSimulator(): Promise<string> {
  if (process.env.SERVE_SIM_CI_SIMULATOR !== "1") {
    throw new Error("Set SERVE_SIM_TEST_UDID to a simulator you booted for this run.");
  }
  const { devices } = (await $`xcrun simctl list devices booted -j`.json()) as {
    devices: Record<string, { udid: string }[]>;
  };
  const booted = Object.values(devices).flat();
  if (booted.length !== 1) {
    throw new Error(`Expected one booted CI simulator, found ${booted.length}. Set SERVE_SIM_TEST_UDID.`);
  }
  return booted[0]!.udid;
}

const phase = process.argv[2];
if (phase === "unit") {
  const unit = (shard: number) => run(["bash", `${TEST_SCRIPTS}/unit.sh`, `--shard=${shard}/2`, "--retry=1"]);
  const codes = await Promise.all([unit(1), unit(2)]);
  process.exit(codes.some((code) => code !== 0) ? 1 : 0);
} else if (phase === "simulator") {
  const files = await simulatorFiles();
  const udid = process.env.SERVE_SIM_TEST_UDID || (await ciSimulator());
  console.log(`Running ${files.length} simulator test files on ${udid}`);
  const env = { ...process.env, SERVE_SIM_TEST_UDID: udid };
  process.exit(await run(["bash", `${TEST_SCRIPTS}/e2e.sh`, "--retry=1", ...files], env));
} else {
  console.error("Usage: serve-sim-tests.ts unit|simulator");
  process.exit(2);
}
