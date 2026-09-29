import { execSync } from "child_process";

import { simctl } from "./simctl";

const SHUTDOWN_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 120_000;

/**
 * UDID of a booted simulator, or null if none is booted. Prefers an iOS device
 * — a machine may also have a booted watchOS/tvOS sim, which `serve-sim`'s
 * tooling doesn't target.
 */
export function findBootedDevice(): string | null {
  try {
    const output = execSync("xcrun simctl list devices booted -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    let fallback: string | null = null;
    for (const [runtime, devices] of Object.entries(data.devices)) {
      for (const device of devices) {
        if (device.state !== "Booted") continue;
        if (/iOS/i.test(runtime)) return device.udid;
        fallback ??= device.udid;
      }
    }
    return fallback;
  } catch {}
  return null;
}

/**
 * Resolve a device name or UDID to a UDID. A UDID is returned as-is; a name is
 * matched case-insensitively against `simctl list devices`. Exits the process
 * with a clear error when the name cannot be resolved.
 */
export function resolveDevice(nameOrUDID: string): string {
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(nameOrUDID)) {
    return nameOrUDID;
  }
  try {
    const output = execSync("xcrun simctl list devices -j", { encoding: "utf-8" });
    const data = JSON.parse(output) as {
      devices: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.name.toLowerCase() === nameOrUDID.toLowerCase()) return device.udid;
      }
    }
  } catch {}
  console.error(`Could not resolve device: ${nameOrUDID}`);
  process.exit(1);
}

// Match simctl output, not the command echoed in every execution error.
export function isAlreadyShutDown(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Unable to shutdown device in current state: Shutdown/i.test(text);
}

export async function shutdownDevice(udid: string): Promise<void> {
  await simctl(["shutdown", udid], SHUTDOWN_TIMEOUT_MS).catch(
    (error: unknown) => {
      if (!isAlreadyShutDown(error)) throw error;
    },
  );
}

export async function bootDevice(udid: string): Promise<void> {
  await simctl(["boot", udid], BOOT_TIMEOUT_MS);
  await simctl(["bootstatus", udid, "-b"], BOOT_TIMEOUT_MS);
}
