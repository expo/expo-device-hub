import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilityAssetBaseDir } from "../runtime/assets";

declare const __SERVE_SIM_VERSION__: string | undefined;

export function serveSimVersion(): string {
  if (typeof __SERVE_SIM_VERSION__ === "string") return __SERVE_SIM_VERSION__;
  try {
    const pkg = JSON.parse(
      readFileSync(join(capabilityAssetBaseDir(), "..", "package.json"), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
