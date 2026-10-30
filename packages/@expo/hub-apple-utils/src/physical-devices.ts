import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";

export interface PhysicalAppleDevice {
  udid: string;
  name: string;
  model: string;
  kind: "iPhone" | "iPad";
  osVersion: string;
  connected: boolean;
  transport: string | null;
}

/** xcdevice reports USB availability even before CoreDevice establishes its tunnel. */
export function parsePhysicalDevices(stdout: string): PhysicalAppleDevice[] {
  const data = JSON.parse(stdout);
  if (!Array.isArray(data)) throw new Error("Invalid Xcode device list.");
  return data.flatMap((entry: any) => {
    if (
      entry?.simulator !== false ||
      entry.platform !== "com.apple.platform.iphoneos" ||
      !/^(iPhone|iPad)/.test(entry.modelCode ?? "") ||
      typeof entry.identifier !== "string" ||
      typeof entry.name !== "string"
    )
      return [];
    return [
      {
        udid: entry.identifier,
        name: entry.name,
        model: typeof entry.modelName === "string" ? entry.modelName : entry.modelCode,
        kind: entry.modelCode.startsWith("iPad") ? "iPad" : "iPhone",
        osVersion: (entry.operatingSystemVersion ?? "").split(" ")[0],
        connected: entry.available === true && entry.ignored !== true,
        transport:
          entry.interface === "usb" ? "usb" : entry.interface === "network" ? "wifi" : null,
      },
    ];
  });
}

let lastDiscovery: { devices: PhysicalAppleDevice[]; at: number } | undefined;

export async function listPhysicalDevices(): Promise<AppleUtilsResult<PhysicalAppleDevice[]>> {
  if (process.platform !== "darwin") return result([]);
  try {
    const { stdout } = await promisify(execFile)("xcrun", ["xcdevice", "list", "--timeout", "1"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const devices = parsePhysicalDevices(stdout);
    lastDiscovery = { devices, at: Date.now() };
    return result(devices);
  } catch (error) {
    // A transient Xcode timeout should not tear down a working preview. Successful
    // discovery still removes disconnected devices immediately.
    const devices =
      lastDiscovery && Date.now() - lastDiscovery.at < 60_000 ? lastDiscovery.devices : [];
    return result(devices, reportError("[apple-utils] Physical iOS discovery failed:", error));
  }
}
