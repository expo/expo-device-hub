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
  const legacy = await import("../../launch-manager");
  const legacyState = await import("../../launch-state");
  const state = await import("../../capabilities/runtime/state");
  const legacyLock = await import("../../launch-state-lock");
  const lock = await import("../../capabilities/runtime/lock");
  const legacyResources = await import("../../capability-resources");
  const resources = await import("../../capabilities/runtime/resources");
  const legacyConfig = await import("../../capability-config");
  const config = await import("../../capabilities/runtime/config");

  assert.equal(runtime.configureCapability, legacy.configureCapability);
  assert.equal(runtime.devicesArmedHere, legacy.devicesArmedHere);
  assert.equal(runtime.CapabilityRollbackError, legacy.CapabilityRollbackError);
  assert.equal(runtime.readLaunchState, legacyState.readLaunchState);
  assert.equal(legacyState.writeLaunchState, state.writeLaunchState);
  assert.equal(legacyLock.withLaunchStateLock, lock.withLaunchStateLock);
  assert.equal(legacyLock.waitForLaunchUpdates, runtime.waitForLaunchUpdates);
  assert.equal(legacyLock.LaunchStateLockedError, lock.LaunchStateLockedError);
  assert.equal(legacyResources.prepareCapability, resources.prepareCapability);
  assert.equal(legacyResources.rollbackPreparations, resources.rollbackPreparations);
  assert.equal(legacyConfig.capabilityLoaderDir, config.capabilityLoaderDir);
  assert.equal(legacyConfig.commitCapabilityConfig, config.commitCapabilityConfig);
  assert.deepEqual(runtime.registeredCapabilities(), []);
  assert.deepEqual(runtime.devicesArmedHere(), []);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(
    events.map((event) => process.rawListeners(event)),
    before,
  );

  legacyState.writeLaunchState("module-test", { launchArgs: [], capabilities: {} });
  assert.deepEqual(runtime.readLaunchState("module-test"), state.readLaunchState("module-test"));
  assert.deepEqual(readdirSync(directory), ["launch-module-test.json"]);
  console.log("Capability module compatibility and import purity passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
