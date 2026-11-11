import { dirname, join } from "path";
import { fileURLToPath } from "url";

export function capabilityLoaderDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "capability-loader");
}

export function capabilityLoaderPath(): string {
  return join(capabilityLoaderDir(), "libServeSimCapabilityLoader.dylib");
}
