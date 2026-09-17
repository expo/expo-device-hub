import { type AddDeviceTarget, type Device, type Platform } from '@expo/hub-components';
import { create } from 'zustand';

import { type DeviceList, type DeviceListConnectionStatus } from './useDevices';

export type LocalDeviceStartup = {
  requestId: string;
  device: Device;
  target: AddDeviceTarget;
  /** False after HTTP success while waiting for discovery to confirm it online. */
  pending: boolean;
};

type DeviceSession = {
  startups: Record<string, LocalDeviceStartup>;
  aliases: Record<string, string>;
  discovery: SessionUpdate;
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
  const matches = (local: Device, device: Device) =>
    local.platform === device.platform &&
    (local.id === device.id || (local.platform === 'android' && local.name === device.name));
  const retained = Object.values(previous.startups).filter(
    (entry) =>
      entry.pending ||
      entry.device.startup?.phase === 'failed' ||
      !running.some(
        (device) => device.platform === entry.device.platform && device.id === entry.device.id
      )
  );
  const startups =
    retained.length === Object.keys(previous.startups).length
      ? previous.startups
      : Object.fromEntries(retained.map((entry) => [entry.requestId, entry]));
  const locals = retained.map((entry) => entry.device);
  const displayed = [
    ...running.filter((device) => !locals.some((local) => matches(local, device))),
    ...locals,
  ];
  const known =
    displayed.find((device) => device.id === selectedId) ??
    [...recent.simulators, ...recent.emulators].find((device) => device.id === selectedId);
  const selectedDevice = selectedId
    ? (known ??
      (previous.selectedDevice?.id === selectedId
        ? previous.selectedDevice
        : unknownDevice(selectedId, platform)))
    : undefined;
  const selectedAvailable =
    !selectedDevice?.startup && running.some((device) => device.id === selectedId);
  const withLocalDevices = (devices: Device[], section: Platform) => {
    const localDevices = locals.filter((device) => device.platform === section);
    const result = localDevices.length
      ? [
          ...devices.filter((device) => !localDevices.some((local) => matches(local, device))),
          ...localDevices,
        ]
      : devices;
    return selectedDevice?.platform === section &&
      !result.some((device) => device.id === selectedId)
      ? [...result, selectedDevice]
      : result;
  };
  const simulators = sameDevices(
    previous.simulators,
    platform === 'android' ? EMPTY_DEVICES : withLocalDevices(booted.simulators, 'ios')
  );
  const emulators = sameDevices(
    previous.emulators,
    platform === 'ios' ? EMPTY_DEVICES : withLocalDevices(booted.emulators, 'android')
  );

  if (
    simulators === previous.simulators &&
    emulators === previous.emulators &&
    recent === previous.recent &&
    selectedDevice === previous.selectedDevice &&
    selectedAvailable === previous.selectedAvailable &&
    startups === previous.startups &&
    previous.discovery.booted === booted &&
    previous.discovery.recent === recent &&
    previous.discovery.selectedId === selectedId &&
    previous.discovery.platform === platform
  )
    return previous;
  return {
    ...previous,
    simulators,
    emulators,
    recent,
    selectedDevice,
    selectedAvailable,
    startups,
    discovery: update,
  };
}

export function createDeviceSessionStore() {
  return create<
    DeviceSession & {
      update: (update: SessionUpdate) => void;
      putStartup: (startup: LocalDeviceStartup, select?: boolean) => void;
      resolveDeviceId: (id: string) => string;
      setConnectionStatus: (status: DeviceListConnectionStatus) => void;
    }
  >()((set, get) => ({
    startups: {},
    aliases: {},
    discovery: {
      booted: { simulators: EMPTY_DEVICES, emulators: EMPTY_DEVICES },
      recent: { simulators: EMPTY_DEVICES, emulators: EMPTY_DEVICES },
      selectedId: '',
    },
    simulators: EMPTY_DEVICES,
    emulators: EMPTY_DEVICES,
    recent: { simulators: EMPTY_DEVICES, emulators: EMPTY_DEVICES },
    selectedAvailable: false,
    connectionStatus: 'connecting',
    update: (update) => set((state) => reconcileDeviceSession(state, update)),
    resolveDeviceId: (id) => {
      const aliases = get().aliases;
      const seen = new Set<string>();
      while (Object.hasOwn(aliases, id) && !seen.has(id)) {
        seen.add(id);
        id = aliases[id];
      }
      return id;
    },
    putStartup: (startup, select = false) =>
      set((state) => {
        const previousId = state.startups[startup.requestId]?.device.id;
        const nextId = startup.device.id;
        let aliases =
          previousId && previousId !== nextId
            ? { ...state.aliases, [previousId]: nextId }
            : state.aliases;
        // Starting an AVD again reuses its name before a new serial exists.
        // Its previous completed request must not redirect the new operation.
        if (select && Object.hasOwn(aliases, nextId)) {
          aliases = { ...aliases };
          delete aliases[nextId];
        }
        const selectedId =
          select || state.discovery.selectedId === previousId ? nextId : state.discovery.selectedId;
        return reconcileDeviceSession(
          {
            ...state,
            aliases,
            startups: { ...state.startups, [startup.requestId]: startup },
          },
          { ...state.discovery, selectedId }
        );
      }),
    setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  }));
}

export const useDeviceSessionStore = createDeviceSessionStore();
