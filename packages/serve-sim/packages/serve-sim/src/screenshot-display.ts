import { integratedDisplayIds } from "./devicekit-chrome";
import { simctl } from "./simctl";

/** Unknown profiles cannot prove that falling back is safe. */
export async function integratedDisplaysForDevice(udid: string): Promise<number[] | null> {
  try {
    const { devices } = JSON.parse(await simctl(["list", "devices", "-j"])) as {
      devices: Record<string, Array<{ udid: string; deviceTypeIdentifier?: string }>>;
    };
    const device = Object.values(devices)
      .flat()
      .find((device) => device.udid.toUpperCase() === udid);
    return integratedDisplayIds(device?.deviceTypeIdentifier);
  } catch (error) {
    console.error("Could not read screenshot display profile:", error);
    return null;
  }
}
