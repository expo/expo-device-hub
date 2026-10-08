import { existsSync, statSync } from "fs";
import { isAbsolute, join } from "path";
import { capabilityConfigPath, capabilityLoaderDir, capabilityLoaderPath } from "./capability-config";

export function additionalDylibs(): string[] {
  return [...new Set((process.env.SERVE_SIM_ADDITIONAL_DYLIBS ?? "")
    .split(":").filter(Boolean))];
}

// Cleanup still needs additionalDylibs() after a caller-owned file has disappeared.
export function validatedAdditionalDylibs(): string[] {
  const paths = additionalDylibs();
  for (const path of paths) {
    if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`SERVE_SIM_ADDITIONAL_DYLIBS needs absolute paths to existing dylibs: ${path}`);
    }
  }
  return paths;
}

// @ref LLP 0011#additional-boot-dylibs — simctl passes child variables into the simulator at boot.
export function simulatorBootEnv(udid: string): NodeJS.ProcessEnv {
  const additional = validatedAdditionalDylibs();
  if (!additional.length) return { ...process.env };
  const capture = join(capabilityLoaderDir(), "..", "simnet", "libSimNetProxy.dylib");
  return {
    ...process.env,
    SIMCTL_CHILD_DYLD_INSERT_LIBRARIES: [...new Set([
      ...(process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES ?? "").split(":").filter(Boolean),
      capabilityLoaderPath(),
      ...(existsSync(capture) ? [capture] : []),
      ...additional,
    ])].join(":"),
    SIMCTL_CHILD_SERVE_SIM_CAPABILITIES_CONFIG: capabilityConfigPath(udid),
  };
}
