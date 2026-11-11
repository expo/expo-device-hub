import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "capture-module-"));
process.env.SERVE_SIM_STATE_DIR = directory;
process.env.SERVE_SIM_CAPTURE_CA_DIR = join(directory, "ca");
const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
const before = events.map((event) => process.rawListeners(event));

try {
  const capture = await import("../../capabilities/network-capture");
  const implementation = await import("../../capabilities/network-capture/runtime");
  const store = await import("../../capabilities/network-capture/store");
  const runtime = await import("../../capabilities/index");

  assert.equal(capture.captureRuntime, implementation.captureRuntime);
  assert.equal(capture.captureRuntime.capability, implementation.captureRuntime.capability);
  assert.equal(capture.createCaptureRuntime, implementation.createCaptureRuntime);
  assert.equal(capture.CaptureEnableError, implementation.CaptureEnableError);
  assert.equal(
    capture.discardCaptureArtifactsForExit,
    implementation.discardCaptureArtifactsForExit,
  );
  assert.equal(capture.CaptureStore, store.CaptureStore);
  assert.equal(capture.MAX_REQUESTS, store.MAX_REQUESTS);
  const unused = capture.createCaptureRuntime();
  await unused.disableAll();

  assert.equal(capture.captureRuntime.capability.name, "networkCapture");
  assert.deepEqual(runtime.registeredCapabilities(), []);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(
    events.map((event) => process.rawListeners(event)),
    before,
  );
  console.log("Network Capture module identities and import purity passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
