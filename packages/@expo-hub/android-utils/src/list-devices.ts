import { homedir } from "node:os";
import { runAdbDevices, runAdbEmuAvdName, runAdbGetprop } from "./adb";
import { readAvdConfig, runAvdmanagerListAvd } from "./avdmanager";
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
 * described from `getprop`. Returns an empty array on any failure. Never throws.
 */
export async function listDevices(): Promise<AndroidDevice[]> {
  try {
    const env = process.env;
    const home = homedir();
    const avdmanager = resolveAvdmanagerPath(env, home);
    const adb = resolveAdbPath(env, home);

    const [avdStdout, adbStdout] = await Promise.all([
      runAvdmanagerListAvd(avdmanager),
      runAdbDevices(adb),
    ]);

    const avdBlocks = avdStdout ? parseAvdList(avdStdout) : [];
    const connected = await inspectConnectedDevices(adb, adbStdout);

    return await buildDevices(avdBlocks, connected);
  } catch (error) {
    console.error("[android-utils] Failed to list devices:", error);
    return [];
  }
}

/** Inspect every online device from `adb devices -l` via getprop. */
async function inspectConnectedDevices(
  adb: string,
  adbStdout: string | null,
): Promise<ConnectedDevice[]> {
  if (!adbStdout) return [];

  const online = parseAdbDevices(adbStdout).filter(isOnline);
  return Promise.all(online.map((device) => inspectDevice(adb, device.serial)));
}

async function inspectDevice(adb: string, serial: string): Promise<ConnectedDevice> {
  const getprop = await runAdbGetprop(adb, serial);
  const properties = getprop ? parseGetprop(getprop) : {};
  const isEmulator = isEmulatorProps(properties);
  const avdName = isEmulator ? parseEmuAvdName(await runAdbEmuAvdName(adb, serial)) : null;

  return { serial, isEmulator, avdName, properties };
}

/** Merge AVD blocks with connected devices into the final device list. */
async function buildDevices(
  avdBlocks: Record<string, string>[],
  connected: ConnectedDevice[],
): Promise<AndroidDevice[]> {
  const bootedByName = indexBootedEmulators(connected);

  const emulators = await Promise.all(
    avdBlocks.map(async (properties) => {
      const config = await readAvdConfig(properties.Path ?? null);
      const serial = properties.Name ? (bootedByName.get(properties.Name) ?? null) : null;
      return toEmulatorDevice(properties, config, serial);
    }),
  );

  const knownNames = new Set(emulators.map((device) => device.name).filter(Boolean));
  const extras = connected
    .filter((device) => !isKnownAvd(device, knownNames))
    .map((device) =>
      device.isEmulator ? toBootedEmulatorDevice(device) : toPhysicalDevice(device),
    );

  return [...emulators, ...extras];
}

function isKnownAvd(device: ConnectedDevice, knownNames: Set<string>): boolean {
  return device.isEmulator && device.avdName !== null && knownNames.has(device.avdName);
}
