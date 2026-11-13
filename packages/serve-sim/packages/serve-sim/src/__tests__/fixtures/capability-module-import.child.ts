import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "capability-module-"));
process.env.SERVE_SIM_STATE_DIR = directory;
const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
const before = events.map((event) => process.rawListeners(event));

try {
  const runtime = await import("../../capabilities/index");
  const manager = await import("../../capabilities/runtime/manager");
  const state = await import("../../capabilities/runtime/state");
  const lock = await import("../../capabilities/runtime/lock");
  const config = await import("../../capabilities/runtime/config");

  assert.equal(runtime.configureCapability, manager.configureCapability);
  assert.equal(runtime.devicesArmedHere, manager.devicesArmedHere);
  assert.equal(runtime.CapabilityRollbackError, manager.CapabilityRollbackError);
  assert.equal(runtime.readLaunchState, state.readLaunchState);
  assert.equal(runtime.waitForLaunchUpdates, lock.waitForLaunchUpdates);
  assert.equal(runtime.capabilityLoaderDir, config.capabilityLoaderDir);
  assert.deepEqual(runtime.registeredCapabilities(), []);
  assert.deepEqual(runtime.devicesArmedHere(), []);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(
    events.map((event) => process.rawListeners(event)),
    before,
  );

  state.writeLaunchState("module-test", { launchArgs: [], capabilities: {} });
  assert.deepEqual(runtime.readLaunchState("module-test"), state.readLaunchState("module-test"));
  assert.deepEqual(readdirSync(directory), ["launch-module-test.json"]);
  console.log("Capability module compatibility and import purity passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
