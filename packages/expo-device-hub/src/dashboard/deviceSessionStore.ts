import { type Device, type Platform } from '@expo/hub-components';
import { create } from 'zustand';

import { type DeviceList, type DeviceListConnectionStatus } from './useDevices';

type DeviceSession = {
  simulators: Device[];
  emulators: Device[];
  recent: DeviceList;
  selectedDevice?: Device;
  selectedAvailable: boolean;
  connectionStatus: DeviceListConnectionStatus;
};

type SessionUpdate = {
  booted: DeviceList;
  recent: DeviceList;
  selectedId: string;
  platform?: Platform;
};

const EMPTY_DEVICES: Device[] = [];

function sameDevices(previous: Device[], next: Device[]): Device[] {
  return previous.length === next.length &&
    previous.every((device, index) => device === next[index])
    ? previous
    : next;
}

/** A direct link may arrive before discovery has ever seen this device. */
function unknownDevice(id: string, platform?: Platform): Device {
  return {
    id,
    name: 'Device',
    version: id,
    platform:
      platform ?? (/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id) ? 'ios' : 'android'),
    booted: false,
    physical: false,
    supported: false,
    deviceFrame: null,
  };
}

/** Retain only the opened missing device; a list refresh must never navigate. */
export function reconcileDeviceSession(
  previous: DeviceSession,
  update: SessionUpdate
): DeviceSession {
  const { booted, recent, selectedId, platform } = update;
  const running = [...booted.simulators, ...booted.emulators];
  const online = running.find((device) => device.id === selectedId);
  const known =
    online ??
    [...recent.simulators, ...recent.emulators].find((device) => device.id === selectedId);
  const selectedDevice = selectedId
    ? (known ??
      (previous.selectedDevice?.id === selectedId
        ? previous.selectedDevice
        : unknownDevice(selectedId, platform)))
    : undefined;
  const selectedAvailable = !!online;
  const withOfflineDevice = (devices: Device[], section: Platform) =>
    selectedDevice?.platform === section && !selectedAvailable
      ? [...devices, selectedDevice]
      : devices;
  const simulators = sameDevices(
    previous.simulators,
    platform === 'android' ? EMPTY_DEVICES : withOfflineDevice(booted.simulators, 'ios')
  );
  const emulators = sameDevices(
    previous.emulators,
    platform === 'ios' ? EMPTY_DEVICES : withOfflineDevice(booted.emulators, 'android')
  );

  if (
    simulators === previous.simulators &&
    emulators === previous.emulators &&
    recent === previous.recent &&
    selectedDevice === previous.selectedDevice &&
    selectedAvailable === previous.selectedAvailable
  )
    return previous;
  return { ...previous, simulators, emulators, recent, selectedDevice, selectedAvailable };
}

export function createDeviceSessionStore() {
  return create<
    DeviceSession & {
      update: (update: SessionUpdate) => void;
      rememberDevice: (device: Device) => void;
      setConnectionStatus: (status: DeviceListConnectionStatus) => void;
    }
  >()((set) => ({
    simulators: EMPTY_DEVICES,
    emulators: EMPTY_DEVICES,
    recent: { simulators: EMPTY_DEVICES, emulators: EMPTY_DEVICES },
    selectedAvailable: false,
    connectionStatus: 'connecting',
    update: (update) => set((state) => reconcileDeviceSession(state, update)),
    rememberDevice: (selectedDevice) =>
      set((state) =>
        state.selectedAvailable && state.selectedDevice?.id === selectedDevice.id
          ? state
          : { selectedDevice, selectedAvailable: false }
      ),
    setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  }));
}

export const useDeviceSessionStore = createDeviceSessionStore();
