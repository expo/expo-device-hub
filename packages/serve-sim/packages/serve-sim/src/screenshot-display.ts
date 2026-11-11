import { execFile } from "child_process";
import { join } from "path";
import { promisify } from "util";
import { simctl } from "./simctl";

const execFileAsync = promisify(execFile);
type Display = { displayType?: unknown; screenID?: unknown };
type Capabilities = Record<string, unknown>;

async function readCapabilitiesAsync(udid: string, timeout?: number): Promise<Capabilities | null> {
  try {
    const { devices, devicetypes } = JSON.parse(await simctl(["list", "-j"], timeout)) as {
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

function singleField(output: string, name: string, separator = ":"): string | undefined {
  const pattern = new RegExp(`^\\s*${name}\\s*${separator}\\s*([^\\r\\n]*)$`, "gm");
  const matches = [...output.matchAll(pattern)];
  return matches.length === 1 ? matches[0]![1]!.trim() : undefined;
}

function numericField(output: string, name: string, separator = ":"): number {
  const value = singleField(output, name, separator);
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : NaN;
}

function soleRuntimeDisplayId(
  output: string,
  expectedType: "Integrated" | "TVOut" | "CarPlay",
): number | null {
  const allPorts = output.split(/^Port:\s*$/m);
  const displays = allPorts.filter((port) =>
    /^\s*Port Identifier: com\.apple\.framebuffer\.display\s*$/m.test(port),
  );
  if (
    displays.length !== 1 ||
    singleField(displays[0]!, "Port Identifier") !== "com.apple.framebuffer.display" ||
    singleField(displays[0]!, "Display class") !== (expectedType === "Integrated" ? "0" : "1")
  )
    return null;
  const adapters = allPorts.filter((port) =>
    /^\s*Port Identifier: com\.apple\.framebuffer\.server\s*$/m.test(port),
  );
  if (
    adapters.length !== 1 ||
    singleField(adapters[0]!, "Port Identifier") !== "com.apple.framebuffer.server"
  )
    return null;
  const sections = adapters[0]!.split(/^    Connected Screens:\s*$/m);
  if (sections.length !== 2) return null;
  const connected = sections[1];
  if (!connected) return null;
  const screens = connected.split(/^    \([^)\r\n]+\)[^\r\n]*$/m).slice(1);
  if (screens.length !== 1 || singleField(screens[0]!, "Screen Type") !== expectedType) return null;
  const id = numericField(screens[0]!, "Screen ID");
  return Number.isInteger(id) && id > 0 && id <= 0xffffffff ? id : null;
}

function verifiedIntegratedRuntimeId(output: string, declarations: unknown): number | null {
  if (!Array.isArray(declarations)) return null;
  const displays: unknown[] = declarations;
  const declaredTypes = new Map<number, string>();
  let panel: { id: number; width: number; height: number } | undefined;
  for (const display of displays) {
    if (
      !display ||
      typeof display !== "object" ||
      !("displayType" in display) ||
      !("screenID" in display)
    )
      return null;
    const type = display.displayType,
      id = display.screenID;
    if (
      typeof type !== "string" ||
      !["integrated", "tvOut", "carPlay", "scene"].includes(type) ||
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id <= 0 ||
      id > 0xffffffff ||
      declaredTypes.has(id)
    )
      return null;
    declaredTypes.set(id, type);
    if (type !== "integrated") continue;
    if (panel || !("width" in display) || !("height" in display)) return null;
    const width = display.width,
      height = display.height;
    if (
      typeof width !== "number" ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      typeof height !== "number" ||
      !Number.isSafeInteger(height) ||
      height <= 0
    )
      return null;
    panel = { id, width, height };
  }
  if (!panel) return null;
  const { id, width, height } = panel;
  const matchesSize = (w: number, h: number) =>
    (w === width && h === height) || (w === height && h === width);
  const allPorts = output.split(/^Port:\s*$/m);
  const ports = allPorts.filter((port) =>
    /^\s*Port Identifier: com\.apple\.framebuffer\.display\s*$/m.test(port),
  );
  if (
    !ports.length ||
    ports.some(
      (port) =>
        singleField(port, "Port Identifier") !== "com.apple.framebuffer.display" ||
        !["0", "1"].includes(singleField(port, "Display class") ?? ""),
    )
  )
    return null;
  const integrated = ports.filter((port) => singleField(port, "Display class") === "0");
  if (integrated.length !== 1) return null;
  const port = integrated[0]!;
  const surfaces = port.split(/^\s*IOSurface port:\s*$/m);
  if (surfaces.length !== 2) return null;
  const surface = surfaces[1];
  if (
    !surface ||
    !matchesSize(numericField(port, "Default width"), numericField(port, "Default height")) ||
    !matchesSize(numericField(surface, "width", "="), numericField(surface, "height", "="))
  )
    return null;
  const adapters = allPorts.filter((entry) =>
    /^\s*Port Identifier: com\.apple\.framebuffer\.server\s*$/m.test(entry),
  );
  if (
    adapters.length !== 1 ||
    singleField(adapters[0]!, "Port Identifier") !== "com.apple.framebuffer.server"
  )
    return null;
  const sections = adapters[0]!.split(/^    Connected Screens:\s*$/m);
  if (sections.length !== 2) return null;
  const connected = sections[1];
  if (!connected) return null;
  const screens = connected.split(/^    \([^)\r\n]+\)[^\r\n]*$/m).slice(1);
  const screenTypes = new Map([
    ["Integrated", "integrated"],
    ["TVOut", "tvOut"],
    ["CarPlay", "carPlay"],
    ["Scene", "scene"],
  ]);
  const seen = new Set<number>();
  let integratedScreens = 0;
  for (const screen of screens) {
    const screenId = numericField(screen, "Screen ID");
    const type = screenTypes.get(singleField(screen, "Screen Type") ?? "");
    if (
      !type ||
      !Number.isInteger(screenId) ||
      screenId <= 0 ||
      screenId > 0xffffffff ||
      seen.has(screenId) ||
      declaredTypes.get(screenId) !== type
    )
      return null;
    seen.add(screenId);
    if (type !== "integrated") continue;
    integratedScreens++;
    const size = /^\{(\d+),\s*(\d+)\}$/.exec(singleField(screen, "Pixel Size") ?? "");
    if (screenId !== id || !size || !matchesSize(Number(size[1]), Number(size[2]))) return null;
  }
  return integratedScreens === 1 ? id : null;
}

async function getDisplayIdsAsync(
  udid: string,
  soleDisplayOnly: boolean,
): Promise<number[] | null> {
  const timeout = soleDisplayOnly ? 2_000 : undefined;
  const capabilities = await readCapabilitiesAsync(udid, timeout);
  if (!capabilities) return null;
  if ("displays" in capabilities) {
    const ids = displayIds(capabilities);
    if (!soleDisplayOnly) return ids;
    if (!Array.isArray(capabilities.displays) || ids?.length !== 1) return null;
    try {
      const output = await simctl(["io", udid, "enumerate"], timeout);
      const soleVirtual =
        capabilities.displays.length === 1 &&
        ["tvOut", "carPlay"].includes(capabilities.displays[0].displayType);
      // @ref LLP 0003#action-catalog -- direct capture requires matching profile and runtime display evidence
      const runtimeId = soleVirtual
        ? soleRuntimeDisplayId(
            output,
            capabilities.displays[0].displayType === "tvOut" ? "TVOut" : "CarPlay",
          )
        : verifiedIntegratedRuntimeId(output, capabilities.displays);
      return runtimeId === ids[0] ? ids : null;
    } catch (error) {
      console.error("Could not verify sole screenshot display:", error);
      return null;
    }
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
    const output = await simctl(["io", udid, "enumerate"], timeout);
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
    if (soleDisplayOnly) {
      const screenTypes = new Map([
        ["Integrated", "integrated"],
        ["TVOut", "tvOut"],
        ["CarPlay", "carPlay"],
      ]);
      const declarations = screens.map((screen) => ({
        displayType: screenTypes.get(singleField(screen, "Screen Type") ?? ""),
        screenID: numericField(screen, "Screen ID"),
        width,
        height,
      }));
      return verifiedIntegratedRuntimeId(output, declarations) === id ? [id] : null;
    }
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

export async function getScreenshotDisplayIdsAsync(udid: string): Promise<number[] | null> {
  return await getDisplayIdsAsync(udid, false);
}

export async function getSoleScreenshotDisplayIdAsync(udid: string): Promise<number | null> {
  const ids = await getDisplayIdsAsync(udid, true);
  return ids?.length === 1 ? ids[0]! : null;
}
