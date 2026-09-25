import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { isAbsolute, join } from "path";
import type { CapabilityScope } from "./capabilities";
import type { LaunchState, RecordedCapability } from "./launch-state";
import { stateDir } from "./state";

// Same value as MAX_CONFIG_BYTES in Sources/ServeSimCapabilityLoader/serve-sim-capability-loader.c.
export const MAX_CONFIG_BYTES = 64 * 1024;
/** The scope tokens the capability loader matches on. */
const SCOPE_TOKEN: Record<CapabilityScope, string> = { userApps: "user", allApps: "all" };

function assertNoSeparators(what: string, value: string): void {
  const found = [...value].find((character) => character === "\t" || character === "\n" || character === ";");
  if (found !== undefined) {
    throw new Error(
      `${what} contains ${JSON.stringify(found)}, which separates fields in the capability ` +
        `config the capability loader reads. Remove it, or pass the value through a file instead.`,
    );
  }
}

export function formatCapabilityConfig(
  capabilities: Record<string, RecordedCapability>,
): string {
  const lines = Object.values(capabilities).map((capability) => {
    assertNoSeparators(`Dylib path for ${capability.name}`, capability.dylib);
    const env = Object.entries(capability.env ?? {})
      .map(([key, value]) => {
        assertNoSeparators(`Environment name ${key} for ${capability.name}`, key);
        assertNoSeparators(`Environment value for ${key} in ${capability.name}`, value);
        if (key.includes("=")) {
          throw new Error(
            `Environment name ${JSON.stringify(key)} for ${capability.name} contains "=", which ` +
              `separates the name from the value. Rename it.`,
          );
        }
        return `${key}=${value}`;
      })
      .join(";");
    const phase = capability.loadPhase ?? "deferred";
    if (phase !== "startup" && phase !== "deferred" && phase !== "startupAndDeferred") {
      throw new Error(`Unknown load phase for ${capability.name}: ${phase}. Use startup, deferred, or startupAndDeferred.`);
    }
    if (phase !== "deferred" && (!isAbsolute(capability.dylib) || capability.dylib.includes(":") || (capability.loadDelayMs ?? 0) !== 0)) {
      throw new Error(`Startup capability ${capability.name} requires an absolute path without colons and no load delay.`);
    }
    const fields = [SCOPE_TOKEN[capability.scope], capability.dylib, env, capability.loadDelayMs ?? 0];
    const deferred = fields.join("\t");
    if (phase === "deferred") return deferred;
    const startup = `startup\t${deferred}`;
    return phase === "startup" ? startup : `${startup}\n${deferred}`;
  });
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function renderCapabilityConfig(state: LaunchState): string {
  const contents = formatCapabilityConfig(state.capabilities);
  const size = Buffer.byteLength(contents, "utf8");
  if (size >= MAX_CONFIG_BYTES - 1) {
    throw new Error(
      `Capability config is ${size} bytes, over the ${MAX_CONFIG_BYTES} byte limit the capability loader ` +
        `can read. The capability loader would load nothing. Disable capabilities you are not using, or ` +
        `shorten the environment values passed to them.`,
    );
  }
  return contents;
}

export function capabilityConfigPath(udid: string): string {
  return join(stateDir(), `capabilities-${udid}.conf`);
}

export function commitCapabilityConfig(udid: string, contents: string): void {
  mkdirSync(stateDir(), { recursive: true });
  const target = capabilityConfigPath(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, contents);
  renameSync(temp, target);
}


function startupInsertStatePath(udid: string): string {
  return join(stateDir(), `capability-inserts-${udid}.json`);
}

export function managedStartupDylibs(udid: string): string[] {
  let contents: string;
  try {
    contents = readFileSync(startupInsertStatePath(udid), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const paths: unknown = JSON.parse(contents);
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && isAbsolute(path) && !path.includes(":"))) {
    throw new Error(`Invalid startup capability ownership for ${udid}. Reboot the simulator before repairing its state.`);
  }
  return paths;
}

export function writeManagedStartupDylibs(udid: string, paths: string[]): void {
  mkdirSync(stateDir(), { recursive: true });
  const target = startupInsertStatePath(udid);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify([...new Set(paths)]));
  renameSync(temp, target);
}
