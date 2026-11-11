import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { capabilityAssetBaseDir } from "../runtime/assets";

/**
 * Resolve the path to the SimCameraInjector dylib. The dev/source layout
 * places it under packages/serve-sim/dist/simcam/; the published npm tarball
 * ships the same file at <package>/dist/simcam/.
 */
export function locateCameraDylib(): string | null {
  const candidates = [
    join(capabilityAssetBaseDir(), "..", "dist", "simcam", "libSimCameraInjector.dylib"),
    join(capabilityAssetBaseDir(), "simcam", "libSimCameraInjector.dylib"),
    join(
      capabilityAssetBaseDir(),
      "..",
      "Sources",
      "SimCameraInjector",
      "build",
      "libSimCameraInjector.dylib",
    ),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return resolve(p);
  }
  return null;
}

export function buildCameraDylib(): string {
  const buildScript = join(
    capabilityAssetBaseDir(),
    "..",
    "Sources",
    "SimCameraInjector",
    "build.sh",
  );
  if (!existsSync(buildScript)) {
    throw new Error(
      "SimCameraInjector source not found — this build of serve-sim does not " +
        "include camera support sources. Reinstall from a recent release.",
    );
  }
  console.error("[serve-sim] building libSimCameraInjector.dylib (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const out = locateCameraDylib();
  if (!out) throw new Error("Build succeeded but dylib not found.");
  return out;
}

export function locateCameraHelper(): string | null {
  const candidates = [
    join(capabilityAssetBaseDir(), "..", "dist", "simcam", "serve-sim-camera-helper"),
    join(capabilityAssetBaseDir(), "simcam", "serve-sim-camera-helper"),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

export function buildCameraHelper(): string {
  const buildScript = join(
    capabilityAssetBaseDir(),
    "..",
    "Sources",
    "SimCameraHelper",
    "build.sh",
  );
  if (!existsSync(buildScript)) {
    throw new Error(
      "SimCameraHelper source not found — webcam support requires building " +
        "from a checkout that includes Sources/SimCameraHelper.",
    );
  }
  console.error("[serve-sim] building serve-sim-camera-helper (one-time)…");
  execSync(`bash "${buildScript}"`, { stdio: "inherit" });
  const out = locateCameraHelper();
  if (!out) throw new Error("Build succeeded but helper binary not found.");
  return out;
}
