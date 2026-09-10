import { execFileSync } from "node:child_process";

const requiredFiles = [
  "dist/server/index.mjs",
  "dist/server/cli.mjs",
  "vendor/serve-sim/dist/middleware.js",
  "vendor/serve-sim/dist/serve-sim.js",
  "vendor/serve-sim/dist/native/serve-sim-native.node",
  "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/LiveKitWebRTC",
  "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/Resources/LICENSE.webrtc",
  "vendor/serve-sim/dist/bin/LiveKitWebRTC.framework/Resources/PrivacyInfo.xcprivacy",
  "vendor/serve-sim/dist/simcam/libSimCameraInjector.dylib",
  "vendor/serve-sim/dist/simcam/serve-sim-camera-helper",
  "vendor/serve-sim/dist/simax/serve-sim-ax-settings",
  "vendor/serve-sim/LICENSE",
  "vendor/serve-sim/NOTICE",
  "vendor/serve-emu/dist/middleware.js",
];

export function verifyReleaseArtifact(tarball: string, version: string): void {
  const pkg = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (pkg.name !== "expo-device-hub" || pkg.version !== version || pkg.private === true) {
    throw new Error(`Expected public expo-device-hub@${version}, got ${pkg.name}@${pkg.version}`);
  }
  const files = new Set(execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n"));
  for (const file of requiredFiles) {
    if (!files.has(`package/${file}`)) throw new Error(`Release artifact is missing ${file}`);
  }
  if (![...files].some((file) => file.startsWith("package/dist/client/") && !file.endsWith("/"))) {
    throw new Error("Release artifact is missing the web client");
  }
}
