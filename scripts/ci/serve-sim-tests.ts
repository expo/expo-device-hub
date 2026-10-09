#!/usr/bin/env bun
// serve-sim CI tests, run from packages/serve-sim.
//
//   bun ../../scripts/ci/serve-sim-tests.ts unit       two parallel shards, no simulator
//   bun ../../scripts/ci/serve-sim-tests.ts simulator  simulator files, one at a time
//
// Unit shards get the same isolation as `bun run test` (scripts/test/unit.sh):
// a private state directory and an xcrun shim that refuses simctl, so
// simulator tests skip. The simulator pass then runs every file that needs a
// device: `.e2e.` files and files that call requireE2E() or e2eDevice().

import { Glob } from "bun";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { testWithRetry } from "./bun-test-retry";

const PATHS = ["packages/serve-sim/src/", "packages/serve-sim/scripts/tart/__tests__/"];
const TEST_SCRIPTS = resolve("packages/serve-sim/scripts/test");

async function unitShard(shard: number): Promise<number> {
  // A short path leaves room for Unix socket names.
  const state = mkdtempSync("/tmp/ss-test.");
  mkdirSync(`${state}/tmp`);
  const env = {
    ...process.env,
    SERVE_SIM_STATE_DIR: state,
    SERVE_SIM_CAPTURE_CA_DIR: `${state}/capture-ca`,
    TMPDIR: `${state}/tmp`,
    PATH: `${TEST_SCRIPTS}/shims:${process.env.PATH}`,
    SERVE_SIM_E2E_REQUIRED: undefined,
    SERVE_SIM_TEST_UDID: undefined,
    SERVE_SIM_DUO_E2E_DEVICE: undefined,
    SERVE_SIM_DUO_REBOOT_E2E: undefined,
  };
  try {
    return await testWithRetry([`--shard=${shard}/2`, "--max-concurrency=1", ...PATHS], { env });
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
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

const phase = process.argv[2];
if (phase === "unit") {
  const codes = await Promise.all([unitShard(1), unitShard(2)]);
  process.exit(codes.some((code) => code !== 0) ? 1 : 0);
} else if (phase === "simulator") {
  const files = await simulatorFiles();
  console.log(`Running ${files.length} simulator test files`);
  process.exit(
    await testWithRetry(["--max-concurrency=1", ...files], {
      beforeRetry: `${TEST_SCRIPTS}/reboot-ci.sh`,
    }),
  );
} else {
  console.error("Usage: serve-sim-tests.ts unit|simulator");
  process.exit(2);
}
