import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import { simctl } from "./simctl";

const execFileAsync = promisify(execFile);
type Display = { displayType?: unknown; screenID?: unknown };

/** A sole declared screen is safe, including tvOS's tvOut; otherwise use integrated panels only. */
export async function getScreenshotDisplayIdsAsync(udid: string): Promise<number[] | null> {
  try {
    const { devices, devicetypes } = JSON.parse(await simctl(["list", "-j"])) as {
      devices?: Record<string, Array<{ udid: string; deviceTypeIdentifier?: string }>>;
      devicetypes?: Array<{ identifier: string; bundlePath?: string }>;
    };
    const device = Object.values(devices ?? {})
      .flat()
      .find((device) => device.udid.toUpperCase() === udid.toUpperCase());
    const type = devicetypes?.find((type) => type.identifier === device?.deviceTypeIdentifier);
    if (!type?.bundlePath) return null;
    // Resolve only this device's bundle and read it asynchronously. Scanning every
    // installed Info.plist synchronously stalls video and HID on the server thread.
    const { stdout } = await execFileAsync(
      "plutil",
      [
        "-convert",
        "json",
        "-o",
        "-",
        join(type.bundlePath, "Contents", "Resources", "capabilities.plist"),
      ],
      { encoding: "utf8", timeout: 2_000 },
    );
    const displays: Display[] | undefined = JSON.parse(stdout)?.capabilities?.displays;
    if (
      !Array.isArray(displays) ||
      !displays.length ||
      !displays.every(
        (display) =>
          display && typeof display.displayType === "string" && display.displayType.length > 0,
      )
    )
      return null;
    const ids = (
      displays.length === 1
        ? displays
        : displays.filter((display) => display.displayType === "integrated")
    ).map((display) => display.screenID);
    if (
      !ids.length ||
      !ids.every(
        (id): id is number =>
          typeof id === "number" && Number.isInteger(id) && id > 0 && id <= 0xffffffff,
      ) ||
      new Set(ids).size !== ids.length
    )
      return null;
    return ids;
  } catch (error) {
    console.error("Could not read screenshot display profile:", error);
    return null;
  }
}
