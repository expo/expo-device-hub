import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { mock } from "bun:test";
import { stateDir } from "../../state";

mock.module("../../runtime", () => {
  throw new Error("Camera must not import the HTTP/WebSocket runtime");
});

const events = ["exit", "SIGINT", "SIGTERM", "SIGHUP"] as const;
const listeners = events.map((event) => process.rawListeners(event));
const entries = readdirSync(stateDir());
const camera = await import("../../capabilities/camera");
const helper = await import("../../capabilities/camera/helper");
const assets = await import("../../capabilities/camera/assets");
const source = await import("../../capabilities/camera/source");
const service = await import("../../capabilities/camera/service");
const capabilities = await import("../../capabilities");

assert.equal(camera.readCameraStatus, helper.readCameraStatus);
assert.equal(camera.stopCameraHelper, helper.stopCameraHelper);
assert.equal(camera.sendCameraHelperCommand, helper.sendCameraHelperCommand);
assert.equal(camera.locateCameraDylib, assets.locateCameraDylib);
assert.equal(camera.buildCameraHelper, assets.buildCameraHelper);
assert.equal(camera.detectMediaKind, source.detectMediaKind);
assert.equal(camera.resolveSourceArg, source.resolveSourceArg);
assert.equal(camera.ensureHelperWithSource, service.ensureHelperWithSource);
assert.equal(camera.recordInjectedBundle, service.recordInjectedBundle);
assert.deepEqual(capabilities.registeredCapabilities(), []);
assert.deepEqual(
  events.map((event) => process.rawListeners(event)),
  listeners,
);
assert.deepEqual(readdirSync(stateDir()), entries);
console.log("Camera imports share one implementation without setup or host runtime imports.");
