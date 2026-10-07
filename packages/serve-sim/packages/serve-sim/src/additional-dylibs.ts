import { existsSync } from "fs";
import { join } from "path";
import { capabilityConfigPath, capabilityLoaderDir, capabilityLoaderPath } from "./capability-config";

export function additionalDylibs(): string[] {
  return [...new Set((process.env.SERVE_SIM_ADDITIONAL_DYLIBS ?? "")
    .split(":").filter(Boolean))];
}

// @ref LLP 0011#additional-boot-dylibs — simctl passes child variables into the simulator at boot.
export function simulatorBootEnv(udid: string): NodeJS.ProcessEnv {
  const additional = additionalDylibs();
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
