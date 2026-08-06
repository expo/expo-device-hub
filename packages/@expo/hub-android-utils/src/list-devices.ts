import { homedir } from "node:os";
import { runAdbDevices, runAdbEmuAvdName, runAdbGetprop } from "./adb";
import { readAvdConfig, runAvdmanagerListAvd } from "./avdmanager";
import { type AndroidUtilsResult, reportError, result } from "./errors";
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

/**
 * List the Android devices known to the SDK.
 *
 * Combines the AVDs from `avdmanager list avd` with the devices currently
 * connected to `adb`, marking each as `booted` and attaching its serial. AVDs
 * are matched to running emulators via `adb emu avd name`; physical devices are
 * described from `getprop`. The result's `value` is empty on failure, with
 * the first invocation-specific failure in `error`.
 */
export async function listDevices(): Promise<AndroidUtilsResult<AndroidDevice[]>> {
  try {
    const env = process.env;
    const home = homedir();
    const avdmanager = resolveAvdmanagerPath(env, home);
    const adb = resolveAdbPath(env, home);

    const avdList = await runAvdmanagerListAvd(avdmanager);
    if (avdList.error) return result([], avdList.error);

    const adbList = await runAdbDevices(adb);
    if (adbList.error) return result([], adbList.error);

    const avdBlocks = avdList.value ? parseAvdList(avdList.value) : [];
    const connected = await inspectConnectedDevices(adb, adbList.value);
    if (connected.error) return result([], connected.error);

    return await buildDevices(avdBlocks, connected.value);
  } catch (error) {
    return result([], reportError("[android-utils] Failed to list devices:", error));
  }
}

/** Inspect every online device from `adb devices -l` via getprop. */
async function inspectConnectedDevices(
  adb: string,
  adbStdout: string | null,
): Promise<AndroidUtilsResult<ConnectedDevice[]>> {
  if (!adbStdout) return result([]);

  const online = parseAdbDevices(adbStdout).filter(isOnline);
  const connected: ConnectedDevice[] = [];
  for (const device of online) {
    const inspected = await inspectDevice(adb, device.serial);
    if (inspected.error) return result([], inspected.error);
    connected.push(inspected.value);
  }
  return result(connected);
}

async function inspectDevice(
  adb: string,
  serial: string,
): Promise<AndroidUtilsResult<ConnectedDevice>> {
  const getprop = await runAdbGetprop(adb, serial);
  if (getprop.error) {
    return result({ serial, isEmulator: false, avdName: null, properties: {} }, getprop.error);
  }

  const properties = getprop.value ? parseGetprop(getprop.value) : {};
  const isEmulator = isEmulatorProps(properties);
  let avdName: string | null = null;
  if (isEmulator) {
    const named = await runAdbEmuAvdName(adb, serial);
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
  for (const properties of avdBlocks) {
    const config = await readAvdConfig(properties.Path ?? null);
    if (config.error) return result([], config.error);
    const serial = properties.Name ? (bootedByName.get(properties.Name) ?? null) : null;
    emulators.push(toEmulatorDevice(properties, config.value, serial));
  }

  const knownNames = new Set(emulators.map((device) => device.name).filter(Boolean));
  const extras = connected
    .filter((device) => !isKnownAvd(device, knownNames))
    .map((device) =>
      device.isEmulator ? toBootedEmulatorDevice(device) : toPhysicalDevice(device),
    );

  return result([...emulators, ...extras]);
}

function isKnownAvd(device: ConnectedDevice, knownNames: Set<string>): boolean {
  return device.isEmulator && device.avdName !== null && knownNames.has(device.avdName);
}
