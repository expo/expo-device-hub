import { listDevices } from "./list-devices";
import type { AndroidDevice } from "./types";

/** Lowest emulator console port; emulator console ports are even. */
export const EMULATOR_PORT_MIN = 5554;
/** Highest emulator console port — adb's emulator serial range tops out at `emulator-5682`. */
export const EMULATOR_PORT_MAX = 5682;

/**
 * Lowest free even emulator console port not held by a running emulator.
 *
 * Scans the serials of the currently known devices for `emulator-<port>`
 * entries and returns the lowest even port in
 * [{@link EMULATOR_PORT_MIN}, {@link EMULATOR_PORT_MAX}] not already in use.
 * `listDevicesFn` is injectable for testing; it defaults to {@link listDevices}.
 *
 * @throws when every port in the range is taken.
 */
export async function freeEmulatorPort(
  listDevicesFn: () => Promise<AndroidDevice[]> = listDevices,
): Promise<number> {
  const devices = await listDevicesFn();
  const used = new Set<number>();
  for (const device of devices) {
    const port = Number(/^emulator-(\d+)$/.exec(device.serial ?? "")?.[1]);
    if (Number.isFinite(port)) used.add(port);
  }
  for (let port = EMULATOR_PORT_MIN; port <= EMULATOR_PORT_MAX; port += 2) {
    if (!used.has(port)) return port;
  }
  throw new Error("No free emulator console port available");
}
