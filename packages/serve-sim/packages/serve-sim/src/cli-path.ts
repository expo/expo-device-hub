import { fileURLToPath } from "url";

declare const __SERVE_SIM_COMPILED__: boolean | undefined;

// @ref LLP 0003#cli-entry-selection — the build selects its CLI entry, independent of the hosting process
export function serveSimCliPath(): string {
  if (typeof __SERVE_SIM_COMPILED__ === "undefined")
    return fileURLToPath(new URL("./index.ts", import.meta.url));
  return __SERVE_SIM_COMPILED__
    ? process.execPath
    : fileURLToPath(new URL("./serve-sim.js", import.meta.url));
}
