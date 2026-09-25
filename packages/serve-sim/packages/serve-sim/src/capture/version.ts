import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

declare const __SERVE_SIM_VERSION__: string | undefined;

export function serveSimVersion(): string {
  if (typeof __SERVE_SIM_VERSION__ === "string") return __SERVE_SIM_VERSION__;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
