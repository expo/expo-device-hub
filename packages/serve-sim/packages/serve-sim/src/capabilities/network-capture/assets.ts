import { existsSync } from "node:fs";
import { join } from "node:path";
import { capabilityAssetBaseDir } from "../runtime/assets";

const DYLIB_NAME = "libSimNetProxy.dylib";

export function proxyDylibCandidates(): string[] {
  const base = capabilityAssetBaseDir();
  return [
    join(base, "simnet", DYLIB_NAME),
    join(base, "..", "dist", "simnet", DYLIB_NAME),
    join(base, "..", "..", "dist", "simnet", DYLIB_NAME),
  ];
}

export function locateProxyDylib(): string | null {
  return proxyDylibCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

export function locateAddon(): string {
  const base = capabilityAssetBaseDir();
  const filename = "servesim_capture.py";
  const candidates = [
    join(base, "capabilities", "network-capture", "mitm-addon", filename),
    join(base, "mitm-addon", filename),
    join(base, "..", "dist", "capture", "mitm-addon", filename),
    join(base, "..", "src", "capabilities", "network-capture", "mitm-addon", filename),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find servesim_capture.py, the addon that reports captured traffic. This build of serve-sim " +
      "is missing dist/capture/mitm-addon; reinstall from a recent release.",
  );
}
