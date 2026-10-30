import { homedir } from "node:os";
import { runAdbDevices, runAdbEmuAvdName, runAdbGetprop } from "./adb";
import { readAvdLastBootedAt } from "./avd-usage";
import { readAvdConfig, runAvdmanagerListAvd } from "./avdmanager";
import { type AndroidUtilsError, type AndroidUtilsResult, reportError, result } from "./errors";
import {
  type ConnectedDevice,
  indexBootedEmulators,
  toBootedEmulatorDevice,
  toEmulatorDevice,
  toPhysicalDevice,
} from "./device-mapping";
import { isOnline, parseAdbDevices } from "./parse-adb-devices";
import { parseAvdList } from "./parse-avd-list";
import { parseEmuAvdName } from "./parse-emu-avd-name";
import { isEmulatorProps, parseGetprop } from "./parse-getprop";
import { resolveAdbPath, resolveAvdmanagerPath } from "./sdk-paths";
import type { AndroidDevice } from "./types";

const discoveryTools = { runAvdmanagerListAvd, runAdbDevices, runAdbGetprop, runAdbEmuAvdName };

/**
 * List the Android devices known to the SDK.
 *
 * Combines the AVDs from `avdmanager list avd` with the devices currently
 * connected to `adb`, marking each as `booted` and attaching its serial. AVDs
 * are matched to running emulators via `adb emu avd name`; physical devices are
 * described from `getprop`. The result's `value` contains every device it could
 * read, with the first invocation-specific failure in `error`.
 */
export async function listDevices(
  overrides: Partial<typeof discoveryTools> = {},
): Promise<AndroidUtilsResult<AndroidDevice[]>> {
  try {
    const env = process.env;
    const home = homedir();
    const avdmanager = resolveAvdmanagerPath(env, home);
    const adb = resolveAdbPath(env, home);

    const tools = { ...discoveryTools, ...overrides };
    // A physical phone only needs platform-tools. Missing Java/cmdline-tools
    // must not hide it, and a failed adb must not hide known AVDs.
    const [avdList, adbList] = await Promise.all([
      tools.runAvdmanagerListAvd(avdmanager),
      tools.runAdbDevices(adb),
    ]);

    const avdBlocks = avdList.value ? parseAvdList(avdList.value) : [];
    const connected = await inspectConnectedDevices(adb, adbList.value, tools);

    const built = await buildDevices(avdBlocks, connected.value);
    return result(built.value, avdList.error ?? adbList.error ?? connected.error ?? built.error);
  } catch (error) {
    return result([], reportError("[android-utils] Failed to list devices:", error));
  }
}

/** Inspect every online device from `adb devices -l` via getprop. */
async function inspectConnectedDevices(
  adb: string,
  adbStdout: string | null,
  tools: typeof discoveryTools,
): Promise<AndroidUtilsResult<ConnectedDevice[]>> {
  if (!adbStdout) return result([]);

  const online = parseAdbDevices(adbStdout).filter(isOnline);
  const connected: ConnectedDevice[] = [];
  let error: AndroidUtilsError | null = null;
  for (const device of online) {
    const inspected = await inspectDevice(adb, device.serial, tools);
    error ??= inspected.error;
    if (inspected.error) continue;
    if (!inspected.value.isEmulator) {
      inspected.value.transport = device.fields.usb
        ? "usb"
        : /:\d+$|\._adb-tls-connect\._tcp\.?$/.test(device.serial)
          ? "wifi"
          : undefined;
    }
    connected.push(inspected.value);
  }
  return result(connected, error);
}

async function inspectDevice(
  adb: string,
  serial: string,
  tools: typeof discoveryTools,
): Promise<AndroidUtilsResult<ConnectedDevice>> {
  const getprop = await tools.runAdbGetprop(adb, serial);
  if (getprop.error) {
    return result({ serial, isEmulator: false, avdName: null, properties: {} }, getprop.error);
  }

  const properties = getprop.value ? parseGetprop(getprop.value) : {};
  const isEmulator = isEmulatorProps(properties);
  let avdName: string | null = null;
  if (isEmulator) {
    const named = await tools.runAdbEmuAvdName(adb, serial);
    if (named.error) {
      return result({ serial, isEmulator, avdName, properties }, named.error);
    }
    avdName = parseEmuAvdName(named.value);
  }

  return result({ serial, isEmulator, avdName, properties });
}

/** Merge AVD blocks with connected devices into the final device list. */
async function buildDevices(
  avdBlocks: Record<string, string>[],
  connected: ConnectedDevice[],
): Promise<AndroidUtilsResult<AndroidDevice[]>> {
  const bootedByName = indexBootedEmulators(connected);

  const emulators: AndroidDevice[] = [];
  let usageError: AndroidUtilsError | null = null;
  for (const properties of avdBlocks) {
    const path = properties.Path ?? null;
    const [config, lastBootedAt] = await Promise.all([
      readAvdConfig(path),
      readAvdLastBootedAt(path),
    ]);
    usageError ??= config.error;
    usageError ??= lastBootedAt.error;
    const serial = properties.Name ? (bootedByName.get(properties.Name) ?? null) : null;
    emulators.push(toEmulatorDevice(properties, config.value, serial, lastBootedAt.value));
  }

  const knownNames = new Set(emulators.map((device) => device.name).filter(Boolean));
  const extras = connected
    .filter((device) => !isKnownAvd(device, knownNames))
    .map((device) =>
      device.isEmulator ? toBootedEmulatorDevice(device) : toPhysicalDevice(device),
    );

  return result([...emulators, ...extras], usageError);
}

function isKnownAvd(device: ConnectedDevice, knownNames: Set<string>): boolean {
  return device.isEmulator && device.avdName !== null && knownNames.has(device.avdName);
}
