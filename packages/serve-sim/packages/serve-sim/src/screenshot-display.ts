import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import { simctl } from "./simctl";

const execFileAsync = promisify(execFile);
type Display = { displayType?: unknown; screenID?: unknown };
type Capabilities = Record<string, unknown>;

async function readCapabilitiesAsync(udid: string): Promise<Capabilities | null> {
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
    const capabilities = JSON.parse(stdout)?.capabilities;
    return capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
      ? capabilities
      : null;
  } catch (error) {
    console.error("Could not read screenshot display profile:", error);
    return null;
  }
}

/** A sole declared screen is safe, including tvOS's tvOut; otherwise use integrated panels only. */
function displayIds(capabilities: Capabilities | null): number[] | null {
  const displays = capabilities?.displays as Display[] | undefined;
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
}

export async function getScreenshotDisplayIdsAsync(udid: string): Promise<number[] | null> {
  const capabilities = await readCapabilitiesAsync(udid);
  if (!capabilities) return null;
  if ("displays" in capabilities) {
    return displayIds(capabilities);
  }
  // @ref LLP 0003#action-catalog — legacy profiles need a matching, unambiguous IO port
  // Xcode 26 profiles declare one main screen instead of an ID array. Do not
  // invent an ID: match the sole integrated port and connected screen in simctl.
  const dimensions = capabilities.ScreenDimensionsCapability as Record<string, unknown> | undefined;
  const width = dimensions?.["main-screen-width"],
    height = dimensions?.["main-screen-height"];
  if (
    !["phone", "pad"].includes(String(capabilities.idiom)) ||
    typeof width !== "number" ||
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isSafeInteger(height) ||
    height <= 0
  )
    return null;
  try {
    const output = await simctl(["io", udid, "enumerate"]);
    const allPorts = output.split(/^Port:\s*$/m);
    const ports = allPorts.filter((port) =>
      /^\s*Port Identifier: com\.apple\.framebuffer\.display\s*$/m.test(port),
    );
    // Every framebuffer must declare its class; an unknown port could be the
    // second integrated panel. Inactive integrated ports count too.
    if (!ports.length || ports.some((port) => !/^\s*Display class: [01]\s*$/m.test(port)))
      return null;
    const integrated = ports.filter((port) => /^\s*Display class: 0\s*$/m.test(port));
    if (integrated.length !== 1) return null;
    const port = integrated[0]!;
    const portWidth = /^\s*Default width: (\d+)\s*$/m.exec(port)?.[1];
    const portHeight = /^\s*Default height: (\d+)\s*$/m.exec(port)?.[1];
    const matchesSize = (w: number, h: number) =>
      (w === width && h === height) || (w === height && h === width);
    if (!matchesSize(Number(portWidth), Number(portHeight))) return null;
    const adapters = allPorts.filter((port) =>
      /^\s*Port Identifier: com\.apple\.framebuffer\.server\s*$/m.test(port),
    );
    if (adapters.length !== 1) return null;
    const connected = adapters[0]!.split(/^    Connected Screens:\s*$/m)[1];
    if (!connected) return null;
    const screens = connected.split(/^    \([^)\r\n]+\)[^\r\n]*$/m).slice(1);
    if (
      !screens.length ||
      screens.some((screen) => !/^\s*Screen Type: (?:Integrated|TVOut|CarPlay)\s*$/m.test(screen))
    )
      return null;
    const integratedScreens = screens.filter((screen) =>
      /^\s*Screen Type: Integrated\s*$/m.test(screen),
    );
    if (integratedScreens.length !== 1) return null;
    const screen = integratedScreens[0]!;
    const id = Number(/^\s*Screen ID: (\d+)\s*$/m.exec(screen)?.[1]);
    const size = /^\s*Pixel Size: \{(\d+),\s*(\d+)\}\s*$/m.exec(screen);
    return Number.isInteger(id) &&
      id > 0 &&
      id <= 0xffffffff &&
      size &&
      matchesSize(Number(size[1]), Number(size[2]))
      ? [id]
      : null;
  } catch (error) {
    console.error("Could not enumerate legacy screenshot displays:", error);
    return null;
  }
}
