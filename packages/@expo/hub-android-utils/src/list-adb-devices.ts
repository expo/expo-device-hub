import { homedir } from "node:os";
import { runAdbDevices, runAdbEmuAvdName } from "./adb";
import { isEmulatorSerial } from "./emulator";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { isOnline, parseAdbDevices } from "./parse-adb-devices";
import { parseEmuAvdName } from "./parse-emu-avd-name";
import { resolveAdbPath } from "./sdk-paths";

/** Per adb call, matching `simctl`'s default limit in `@expo/hub-apple-utils`. */
export const LIST_ADB_DEVICES_TIMEOUT_MS = 30_000;

/** A device as `adb devices -l` reports it, in any connection state. */
export interface AdbDeviceState {
  /** adb serial, e.g. `"emulator-5554"` or `"27151JEGR11854"`. */
  serial: string;
  /** adb connection state: `"device"`, `"offline"`, `"unauthorized"`, … */
  state: string;
  /** AVD name of an online emulator from `adb emu avd name`; otherwise `null`. */
  avdName: string | null;
}

/**
 * List every device adb sees, in any state, with the AVD name of each online
 * emulator.
 *
 * Unlike {@link listDevices} this needs neither `avdmanager` nor `getprop`,
 * and keeps offline and unauthorized devices. A failed `adb emu avd name`
 * leaves `avdName` `null`, since the serial still identifies the emulator.
 * The `adb devices` failure is returned in `error`; a missing `adb` binary
 * fails with the `ENOENT` error from the spawn. Each adb call is killed after
 * `timeoutMs`, so a stalled adb server becomes an error instead of a hang.
 * Never throws.
 */
export async function listAdbDevices(
  adbPath: string = resolveAdbPath(process.env, homedir()),
  { timeoutMs = LIST_ADB_DEVICES_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<AndroidUtilsResult<AdbDeviceState[]>> {
  try {
    const listed = await runAdbDevices(adbPath, { timeoutMs });
    if (listed.error) return result([], listed.error);

    // In parallel: each lookup can take up to its time limit.
    const devices = await Promise.all(
      parseAdbDevices(listed.value ?? "").map(async (device): Promise<AdbDeviceState> => {
        const named =
          isEmulatorSerial(device.serial) && isOnline(device)
            ? await runAdbEmuAvdName(adbPath, device.serial, { timeoutMs })
            : null;
        return {
          serial: device.serial,
          state: device.state,
          avdName: parseEmuAvdName(named?.value ?? null),
        };
      }),
    );
    return result(devices);
  } catch (error) {
    return result([], reportError("[android-utils] Failed to list adb devices:", error));
  }
}
