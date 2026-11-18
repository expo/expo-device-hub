/**
 * The exact hardware model of each device, which picks its screen shape in
 * `@expo/hub-client/shapes`: the simulator device type name on iOS, and the
 * AVD hardware profile id on Android.
 */

import { type AndroidDevice } from "@expo/hub-android-utils";
import { type AppleSimulatorRuntime, listRuntimes } from "@expo/hub-apple-utils";

/** How long an unknown device type waits before `simctl list runtimes` runs again. */
export const DEVICE_TYPE_REFRESH_MS = 60_000;

type ListRuntimes = () => Promise<{ value: AppleSimulatorRuntime[] }>;

/**
 * Simulator device type names by identifier. The device list is polled often,
 * so `simctl list runtimes` runs once, and again only when a simulator has an
 * unknown device type, at most once per {@link DEVICE_TYPE_REFRESH_MS}.
 */
export function createAppleDeviceTypeNames(
  list: ListRuntimes = listRuntimes,
  now: () => number = Date.now,
) {
  const names = new Map<string, string>();
  let loading: Promise<void> | null = null;
  let loadedAt = Number.NEGATIVE_INFINITY;

  return async function deviceTypeNames(
    identifiers: Iterable<string | null>,
  ): Promise<ReadonlyMap<string, string>> {
    const missing = [...identifiers].some((identifier) => identifier && !names.has(identifier));
    if (missing && !loading && now() - loadedAt >= DEVICE_TYPE_REFRESH_MS) {
      loading = list()
        .then(({ value }) => {
          for (const runtime of value) {
            for (const deviceType of runtime.supportedDeviceTypes) {
              names.set(deviceType.identifier, deviceType.name);
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          loadedAt = now();
          loading = null;
        });
    }
    if (loading) await loading;
    return names;
  };
}

/** The AVD hardware profile id of an emulator; a physical device has none. */
export function androidDeviceModel(device: AndroidDevice): string | null {
  return device.type === "device" ? null : (device.config["hw.device.name"] ?? null);
}
