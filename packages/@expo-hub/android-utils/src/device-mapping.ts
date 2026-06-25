import { pickPhysicalProps } from "./parse-getprop";
import type { AndroidDevice } from "./types";

/** A connected device inspected via `adb` (getprop + AVD name for emulators). */
export interface ConnectedDevice {
  /** adb serial (e.g. `"emulator-5554"`). */
  serial: string;
  /** Whether `getprop` identified this device as an emulator. */
  isEmulator: boolean;
  /** AVD name for booted emulators; `null` for physical devices. */
  avdName: string | null;
  /** Parsed `getprop` values for the device. */
  properties: Record<string, string>;
}

/** Index booted emulators by their AVD name → serial (first wins). */
export function indexBootedEmulators(connected: ConnectedDevice[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const device of connected) {
    if (device.isEmulator && device.avdName && !index.has(device.avdName)) {
      index.set(device.avdName, device.serial);
    }
  }

  return index;
}

/**
 * Build the {@link AndroidDevice} entry for an AVD from its `avdmanager` block.
 * A non-null `serial` marks the AVD as currently booted.
 */
export function toEmulatorDevice(
  properties: Record<string, string>,
  config: Record<string, string>,
  serial: string | null,
): AndroidDevice {
  return {
    name: properties.Name ?? "",
    type: "emulator",
    booted: serial !== null,
    serial,
    path: properties.Path ?? null,
    properties,
    config,
  };
}

/**
 * Build the {@link AndroidDevice} entry for a booted emulator that has no
 * matching `avdmanager` block (e.g. an AVD that failed to load).
 */
export function toBootedEmulatorDevice(device: ConnectedDevice): AndroidDevice {
  return {
    name: device.avdName ?? device.serial,
    type: "emulator",
    booted: true,
    serial: device.serial,
    path: null,
    properties: {},
    config: {},
  };
}

/** Build the {@link AndroidDevice} entry for a connected physical device. */
export function toPhysicalDevice(device: ConnectedDevice): AndroidDevice {
  const properties = pickPhysicalProps(device.properties);

  return {
    name: physicalDeviceName(properties, device.serial),
    type: "device",
    booted: true,
    serial: device.serial,
    path: null,
    properties,
    config: {},
  };
}

/** Build a display name like `"Google Pixel 6a"`, falling back to the serial. */
function physicalDeviceName(properties: Record<string, string>, serial: string): string {
  const manufacturer = properties["ro.product.manufacturer"];
  const model = properties["ro.product.model"];
  if (!model) return serial;

  return manufacturer ? `${manufacturer} ${model}` : model;
}
