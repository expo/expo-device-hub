import { execFile } from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { deviceKindOf } from "./device-features";
import { physicalDeviceSupport } from "./native";

const execFileAsync = promisify(execFile);

/** A paired iPhone or iPad that serve-sim lists beside the simulators. */
export type PhysicalDevice = {
  /** Hardware UDID, the public id that routes, the grid and the Hub use. */
  udid: string;
  /** The owner's name for the device, such as "iPhone". */
  name: string;
  /** Model name, such as "iPhone 12". */
  marketingName: string | null;
  /** `"iOS"` or `"iPadOS"`. */
  platform: string;
  /** Such as "27.2.1". */
  osVersion: string | null;
  /** Why the device cannot stream yet, or null. */
  unsupportedReason: string | null;
};

const STREAMABLE_PLATFORMS = new Set(["iOS", "iPadOS"]);
const MINIMUM_OS_MAJOR = 27;
const MINIMUM_CORE_DEVICE_MAJOR = 642;
const CORE_DEVICE_INFO_PLIST =
  "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/Info.plist";
const LIST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5_000;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function majorVersion(version: string | null): number {
  const major = Number.parseInt(version ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * Keep real iOS and iPadOS hardware from `devicectl list devices --json-output` that is paired and
 * has Developer Mode on, also when its tunnel is disconnected: opening the device connects it.
 * Reads `properties` first, then the deprecated `*Properties` fields. The Hub's
 * `@expo/hub-apple-utils` applies the same rules; serve-sim is published on its own and cannot
 * depend on that private package.
 */
export function parsePhysicalDevices(
  json: string,
  coreDeviceVersion: string | null,
): PhysicalDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const devices = record(record(parsed).result).devices;
  if (!Array.isArray(devices)) return [];
  return devices.flatMap((entry) => {
    const device = record(entry);
    const properties = record(device.properties);
    const hardware = { ...record(device.hardwareProperties), ...record(properties.hardware) };
    const legacyState = record(device.deviceProperties);
    const state = { ...legacyState, ...record(properties.state) };
    const connection = {
      ...record(device.connectionProperties),
      ...record(properties.connection),
    };
    const udid = text(hardware.udid);
    const platform = text(hardware.platform);
    const developerMode =
      state.developerModeStatus === "enabled" || "enabled" in record(state.developerModeStatus);
    if (
      !udid ||
      hardware.reality !== "physical" ||
      !platform ||
      !STREAMABLE_PLATFORMS.has(platform) ||
      connection.pairingState !== "paired" ||
      !developerMode
    )
      return [];
    const osVersion =
      text(record(record(properties.software).osVersionNumber).stringValue) ??
      text(legacyState.osVersionNumber);
    return [
      {
        udid,
        name: text(state.name) ?? text(hardware.marketingName) ?? "iPhone",
        marketingName: text(hardware.marketingName),
        platform,
        osVersion,
        unsupportedReason: physicalDeviceUnsupportedReason(osVersion, coreDeviceVersion),
      },
    ];
  });
}

/** Streaming needs iOS 27 on the device and CoreDevice 642 (Xcode 27) on this Mac. */
export function physicalDeviceUnsupportedReason(
  osVersion: string | null,
  coreDeviceVersion: string | null,
): string | null {
  if (majorVersion(coreDeviceVersion) < MINIMUM_CORE_DEVICE_MAJOR) return "needs Xcode 27";
  if (majorVersion(osVersion) < MINIMUM_OS_MAJOR) return "needs iOS 27";
  return null;
}

type HostSupport = { coreDeviceVersion: string | null; unsupportedReason: string | null };

async function readHostSupport(): Promise<HostSupport> {
  try {
    const support = await physicalDeviceSupport();
    return {
      coreDeviceVersion: support.coreDeviceVersion ?? null,
      unsupportedReason: support.supported ? null : (support.message ?? "needs Xcode 27"),
    };
  } catch {
    return { coreDeviceVersion: await readCoreDeviceVersion(), unsupportedReason: null };
  }
}

export function coreDeviceInfoPlist(
  environment: Record<string, string | undefined> = process.env,
): string {
  return environment.SERVE_SIM_COREDEVICE_INFO_PLIST || CORE_DEVICE_INFO_PLIST;
}

async function readCoreDeviceVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", coreDeviceInfoPlist()],
      { timeout: LIST_TIMEOUT_MS },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runDevicectlList(): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), "serve-sim-devicectl-"));
  const output = join(directory, "devices.json");
  try {
    await execFileAsync("xcrun", ["devicectl", "list", "devices", "--json-output", output], {
      timeout: LIST_TIMEOUT_MS,
    });
    return await readFile(output, "utf8");
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A phone's `/grid/api` row, beside the simulators' rows. */
export type PhysicalGridRow = {
  udid: string;
  name: string;
  state: "Booted";
  kind: "physical";
  /** The model whose DeviceKit chrome frames the phone. */
  chromeName: string;
  /** In the simulators' runtime form, such as "iOS-27-2-1". */
  runtime: string;
  unsupportedReason?: string;
};

/**
 * A paired phone is listed as always booted: serve-sim does not boot or shut it down, and it
 * connects when it is opened, as serve-emu lists a physical Android device.
 */
export function gridRowForPhysical(device: PhysicalDevice): PhysicalGridRow {
  return {
    udid: device.udid,
    name: device.name,
    state: "Booted",
    kind: "physical",
    chromeName: device.marketingName ?? device.name,
    runtime: [device.platform, ...(device.osVersion?.split(".") ?? [])].join("-"),
    ...(device.unsupportedReason ? { unsupportedReason: device.unsupportedReason } : {}),
  };
}

export function physicalStartRefusal(
  udid: string,
  devices: readonly PhysicalDevice[],
): string | null {
  const upper = udid.toUpperCase();
  return devices.find((device) => device.udid.toUpperCase() === upper)?.unsupportedReason ?? null;
}

export async function physicalDeviceStartRefusal(udid: string): Promise<string | null> {
  if (deviceKindOf(udid) !== "physical") return null;
  return physicalStartRefusal(udid, await listPhysicalDevices());
}

let cached: { at: number; devices: Promise<PhysicalDevice[]> } | null = null;

/**
 * The paired iPhones and iPads, cached briefly because the grid's status feed asks every few
 * seconds. An empty list when devicectl is missing or fails.
 */
export function listPhysicalDevices(): Promise<PhysicalDevice[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.devices;
  const devices = Promise.all([runDevicectlList(), readHostSupport()]).then(([json, host]) =>
    json
      ? parsePhysicalDevices(json, host.coreDeviceVersion).map((device) =>
          host.unsupportedReason
            ? { ...device, unsupportedReason: host.unsupportedReason }
            : device,
        )
      : [],
  );
  cached = { at: now, devices };
  return devices;
}
