import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The former source-root anchor, or the directory containing a bundle/executable. */
// @ref LLP 0007#native-paths-and-validation — source, flattened bundles and compiled executables use different anchors.
export function capabilityAssetBaseDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled Bun modules live in its embedded filesystem; native files stay beside the executable.
  if (here.startsWith("/$bunfs/")) return dirname(process.execPath);
  if (
    basename(here) === "runtime" &&
    basename(dirname(here)) === "capabilities" &&
    basename(dirname(dirname(here))) === "src"
  ) {
    return resolve(here, "..", "..");
  }
  return here;
}

export function capabilityLoaderDir(): string {
  return join(capabilityAssetBaseDir(), "..", "dist", "capability-loader");
}

export function capabilityLoaderPath(): string {
  return join(capabilityLoaderDir(), "libServeSimCapabilityLoader.dylib");
}
