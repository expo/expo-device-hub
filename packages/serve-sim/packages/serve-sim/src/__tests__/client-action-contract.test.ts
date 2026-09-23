import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { mkdirSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runHostActionAsync } from "../host-actions";
import { EXIT_0_SHIM, UDID, installShims } from "./helpers";

const BIN = "true";
const BUNDLE = "com.example.app";
const DETACH_PORT = "3100";

const UPLOADS = join(tmpdir(), "serve-sim-uploads");
const STAGED = join(realpathSync(tmpdir()), "serve-sim-uploads", "contract-fixture.bin");
// The path the server hands back from a capture: the toast drags it onto the simulator and "Open
// in Finder" falls back to it when the Desktop has no copy.
const SHOT = "serve-sim-screenshot-contract.png";
const STAGED_SHOT = join(realpathSync(tmpdir()), "serve-sim-screenshots", SHOT);

const SHIMMED = ["open", "xcrun", "cp", "sips", "base64", "plutil"];

let shims: ReturnType<typeof installShims>;

beforeAll(() => {
  shims = installShims(Object.fromEntries(SHIMMED.map((name) => [name, EXIT_0_SHIM])));
  mkdirSync(UPLOADS, { recursive: true });
});

afterAll(() => {
  shims.restore();
  // The xcrun shim never writes, so the reservation the capture staged is what is left behind.
  rmSync(STAGED_SHOT, { force: true });
});

// The literal params each client call site builds. The tools themselves are barely covered, so a
// schema tightened past one of these shapes fails here instead of in the preview.
const CALLS: Array<[string, string, Record<string, unknown> | undefined]> = [
  // camera-tool.tsx
  ["camera-tool", "camera.listWebcams", undefined],
  ["camera-tool", "camera.switch", { source: "placeholder", udid: UDID }],
  ["camera-tool", "camera.switch", { source: "webcam", target: "MacBook Pro Camera", udid: UDID }],
  ["camera-tool", "camera.switch", { source: "file", target: STAGED, udid: UDID }],
  ["camera-tool", "camera.inject", { bundleId: BUNDLE, udid: UDID, source: "placeholder", mirror: "on" }],
  ["camera-tool", "camera.inject", { bundleId: BUNDLE, udid: UDID, source: "file", target: STAGED, mirror: "off" }],
  ["camera-tool", "camera.mirror", { udid: UDID, value: "on" }],
  ["camera-tool", "camera.stopWebcam", { udid: UDID }],

  // location-emulation-tool.tsx — negative coordinates are the one value that starts with "-"
  ["location-tool", "location.set", { udid: UDID, lat: 37.3349, lng: -122.009 }],
  ["location-tool", "location.set", { udid: UDID, lat: -33.8688, lng: 151.2093 }],
  ["location-tool", "location.clear", { udid: UDID }],

  // app-permissions-tool.tsx — every service key the sidebar offers
  ...(["camera", "photos", "notifications", "location", "microphone", "contacts"] as const).map(
    (service) =>
      ["permissions-tool", "permissions.set", { action: "grant", service, bundleId: BUNDLE, udid: UDID }] as [
        string,
        string,
        Record<string, unknown>,
      ],
  ),
  ["permissions-tool", "permissions.resetAll", { bundleId: BUNDLE, udid: UDID }],

  // useSimStream.ts
  ["useSimStream", "server.detach", { udid: UDID }],
  ["useSimStream", "server.detach", { udid: UDID, port: DETACH_PORT }],
  ["useSimStream", "server.kill", {}],
  ["useSimStream", "button", { value: "home", udid: UDID }],
  ["useSimStream", "rotate", { udid: UDID, value: "landscape" }],

  // SimulatorToolbar.tsx
  ["toolbar", "screenshot.capture", { udid: UDID, fileName: SHOT }],
  ["toolbar", "appearance.get", { udid: UDID }],
  ["toolbar", "appearance.set", { udid: UDID, value: "dark" }],

  // app-icon.ts + use-screenshot-toast.tsx
  ["app-icon", "app.iconPath", { appPath: STAGED, candidates: ["Icon@2x.png", "Icon.png"] }],
  ["app-icon", "file.readBase64", { path: STAGED }],
  ["screenshot-toast", "screenshot.thumbnail", { fileName: SHOT }],
  ["screenshot-toast", "reveal", { screenshot: SHOT }],
  ["screenshot-toast", "reveal", { path: STAGED_SHOT }],

  // app-detection-tool.tsx reveals a path inside the simulator container, not a named screenshot,
  // so both arms of the reveal union are call sites.
  ["app-detection", "reveal", { path: STAGED }],

  // drop.ts
  ["drop", "upload.append", { uploadId: "drop.ipa", data: btoa("x"), first: true }],
  ["drop", "upload.remove", { uploadId: "drop.ipa" }],
  ["drop", "app.install", { udid: UDID, uploadId: "drop.ipa" }],
  ["drop", "media.add", { udid: UDID, uploadId: "drop.mov" }],
  // use-media-drop.ts: the toast dropped onto the simulator adds the staged capture in place.
  ["drop", "media.add", { udid: UDID, path: STAGED_SHOT }],
];

describe("params the preview client sends are accepted by the server", () => {
  it.each(CALLS)("%s: %s", async (_tool, action, params) => {
    const call = runHostActionAsync(params === undefined ? { action } : { action, params }, BIN);
    await expect(call).resolves.toHaveProperty("exitCode");
  });
});
