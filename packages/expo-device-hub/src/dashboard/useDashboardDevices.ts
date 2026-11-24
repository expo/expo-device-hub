import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
  type Platform,
} from "@expo/hub-components";
import { useMemo } from "react";

import { useDashboardStore } from "./dashboardStore";
import { bootDevice, createDevice, removeDevice, shutdownDevice } from "./deviceActions";
import {
  useHideUnsupportedDevices,
  visibleDevices,
  visibleNewDeviceOptions,
} from "./deviceVisibility";
import { type DeviceListConnectionStatus, useDeviceLists } from "./useDevices";
import { useNewDeviceOptions } from "./useNewDeviceOptions";

/** Append `extra` devices not already present in `base` (deduped by id). */
export function mergeById(base: Device[], extra: Device[]): Device[] {
  const ids = new Set(base.map((device) => device.id));
  return [...base, ...extra.filter((device) => !ids.has(device.id))];
}

/** The device that the sidebar shows once the host has created or booted `target` as `id`. */
function addedDevice(target: AddDeviceTarget, id: string): Device {
  if (target.kind === "recent") {
    return { ...target.device, id, booted: true, lastUsedAt: Date.now() };
  }
  return {
    id,
    name: target.device.name,
    version: target.device.version,
    platform: target.device.platform,
    physical: false,
    booted: true,
    supported: target.device.supported,
    model: target.device.model ?? null,
    lastUsedAt: Date.now(),
  };
}

export type DashboardDevices = {
  /** Running simulators: the server's list, plus those the viewer started that it does not list yet. */
  simulators: Device[];
  /** Running emulators and connected devices, merged the same way. */
  emulators: Device[];
  /** Shut-down simulators offered in the add-simulator picker. */
  recentSimulators: Device[];
  /** Shut-down emulators offered in the add-emulator picker. */
  recentEmulators: Device[];
  /** Installed iOS runtimes and their models, for a new simulator. */
  simulatorOptions: NewDeviceOptions;
  /** Installed Android system images and their profiles, for a new emulator. */
  emulatorOptions: NewDeviceOptions;
  /** The connection to the Hub server's device list. */
  connectionStatus: DeviceListConnectionStatus;
  /** Create or boot the picker's target on the host, then keep it in the sidebar. */
  addDevice: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
  /** Shut a device down on the host and drop it from the sidebar. */
  shutdown: (device: Device) => Promise<void>;
  /** Delete a device on the host and drop it from the sidebar. */
  remove: (device: Device) => Promise<void>;
};

/**
 * The device data of the dashboard and the host actions on a device.
 *
 * The lists merge the server's running devices with the devices that the
 * viewer started through a picker, which the store keeps until host discovery
 * lists them. `platform` limits the dashboard to one platform: the other
 * platform's running list is then empty.
 */
export function useDashboardDevices(platform?: Platform): DashboardDevices {
  const { booted, recent, connectionStatus } = useDeviceLists();
  const newDeviceOptions = useNewDeviceOptions();
  const hideUnsupportedDevices = useHideUnsupportedDevices();
  const added = useDashboardStore((state) => state.addedDevices);
  const trackAddedDevice = useDashboardStore((state) => state.trackAddedDevice);
  const dismissDevice = useDashboardStore((state) => state.dismissDevice);

  const simulators = useMemo(
    () =>
      platform === "android"
        ? []
        : mergeById(
            booted.simulators,
            added.filter((device) => device.platform === "ios"),
          ),
    [booted.simulators, added, platform],
  );
  const emulators = useMemo(
    () =>
      platform === "ios"
        ? []
        : mergeById(
            booted.emulators,
            added.filter((device) => device.platform === "android"),
          ),
    [booted.emulators, added, platform],
  );
  // The browser flag affects only shut-down recents and creation choices. Every
  // running device remains visible in the sidebar, including untested models.
  const recentSimulators = useMemo(
    () => visibleDevices(recent.simulators, hideUnsupportedDevices),
    [recent.simulators, hideUnsupportedDevices],
  );
  const recentEmulators = useMemo(
    () => visibleDevices(recent.emulators, hideUnsupportedDevices),
    [recent.emulators, hideUnsupportedDevices],
  );
  const simulatorOptions = useMemo(
    () => visibleNewDeviceOptions(newDeviceOptions.ios, hideUnsupportedDevices),
    [newDeviceOptions.ios, hideUnsupportedDevices],
  );
  const emulatorOptions = useMemo(
    () => visibleNewDeviceOptions(newDeviceOptions.android, hideUnsupportedDevices),
    [newDeviceOptions.android, hideUnsupportedDevices],
  );

  // The picker awaits this result, so it stays open during a slow Android boot
  // and can show a failure in context.
  async function addDevice(target: AddDeviceTarget): Promise<AddDeviceOutcome> {
    const result =
      target.kind === "new"
        ? await createDevice(target.device)
        : target.device.booted
          ? { id: target.device.id, error: null }
          : await bootDevice(target.device);

    if (!result.id) {
      return { ok: false, error: result.error ?? "The device did not come online." };
    }

    // The new entry replaces the entries that named the same device before the host gave it an id.
    const replacedIds =
      target.kind === "new"
        ? [target.device.name, result.id]
        : [target.device.name, target.device.id, result.id];
    trackAddedDevice(addedDevice(target, result.id), replacedIds);
    return { ok: true };
  }

  // The device leaves the server's running list within a tick, and the
  // dashboard then selects the next device or shows the empty state.
  async function shutdown(device: Device) {
    await shutdownDevice(device);
    dismissDevice(device.id);
  }

  async function remove(device: Device) {
    await removeDevice(device);
    dismissDevice(device.id);
  }

  return {
    simulators,
    emulators,
    recentSimulators,
    recentEmulators,
    simulatorOptions,
    emulatorOptions,
    connectionStatus,
    addDevice,
    shutdown,
    remove,
  };
}
