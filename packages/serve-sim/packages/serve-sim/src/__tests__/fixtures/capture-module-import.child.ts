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
  const capture = await import("../../capabilities/capture");
  const legacy = await import("../../capture/runtime");
  const publicCapture = await import("../../capture");
  const runtime = await import("../../capabilities/index");

  assert.equal(capture.captureRuntime, legacy.captureRuntime);
  assert.equal(capture.captureRuntime, publicCapture.captureRuntime);
  assert.equal(capture.captureRuntime.capability, legacy.captureRuntime.capability);
  assert.equal(capture.createCaptureRuntime, legacy.createCaptureRuntime);
  assert.equal(capture.createCaptureRuntime, publicCapture.createCaptureRuntime);
  assert.equal(capture.CaptureEnableError, legacy.CaptureEnableError);
  assert.equal(capture.CaptureEnableError, publicCapture.CaptureEnableError);
  assert.equal(capture.discardCaptureArtifactsForExit, legacy.discardCaptureArtifactsForExit);
  const unused = capture.createCaptureRuntime();
  await unused.disableAll();

  assert.equal(capture.captureRuntime.capability.name, "networkCapture");
  assert.deepEqual(runtime.registeredCapabilities(), []);
  assert.deepEqual(readdirSync(directory), []);
  assert.deepEqual(
    events.map((event) => process.rawListeners(event)),
    before,
  );
  console.log("Capture module compatibility and import purity passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
