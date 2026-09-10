import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verifyReleaseArtifact } from "./release-artifact.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function artifact({ version = "1.2.3", name = "expo-device-hub", omit = "", privatePackage = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-release-test-"));
  dirs.push(dir);
  const files = [
    "dist/client/index.html", "dist/server/index.mjs", "dist/server/cli.mjs",
    "vendor/serve-emu/dist/middleware.js",
    ...["middleware.js", "serve-sim.js", "native/serve-sim-native.node",
      "bin/LiveKitWebRTC.framework/LiveKitWebRTC",
      "bin/LiveKitWebRTC.framework/Resources/LICENSE.webrtc",
      "bin/LiveKitWebRTC.framework/Resources/PrivacyInfo.xcprivacy",
      "simcam/libSimCameraInjector.dylib", "simcam/serve-sim-camera-helper",
      "simax/serve-sim-ax-settings"].map((file) => `vendor/serve-sim/dist/${file}`),
    "vendor/serve-sim/LICENSE", "vendor/serve-sim/NOTICE",
  ];
  for (const file of files.filter((file) => file !== omit)) {
    const path = join(dir, "package", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
  }
  writeFileSync(join(dir, "package/package.json"), JSON.stringify({ name, version, private: privatePackage }));
  const tarball = join(dir, "release.tgz");
  execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
  return tarball;
}

describe("release artifact verification", () => {
  test.each(["1.2.3", "1.3.0-canary-20260910-abcdef0"])("accepts a complete %s package", (version) => {
    expect(() => verifyReleaseArtifact(artifact({ version }), version)).not.toThrow();
  });
  test("rejects the wrong version", () => {
    expect(() => verifyReleaseArtifact(artifact(), "1.2.4")).toThrow("Expected public");
  });
  test("rejects the wrong package", () => {
    expect(() => verifyReleaseArtifact(artifact({ name: "@expo/serve-sim" }), "1.2.3")).toThrow("Expected public");
  });
  test("rejects private packages", () => {
    expect(() => verifyReleaseArtifact(artifact({ privatePackage: true }), "1.2.3")).toThrow("Expected public");
  });
  test.each([
    "vendor/serve-sim/dist/native/serve-sim-native.node",
    "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC",
    "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/Resources/LICENSE.webrtc",
    "dist/client/index.html",
  ])("rejects a package missing %s", (omit) => {
    expect(() => verifyReleaseArtifact(artifact({ omit }), "1.2.3")).toThrow("missing");
  });
});
