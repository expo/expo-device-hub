import { useEffect, useMemo, useState } from 'react';

import { type Device } from '@expo/hub-components';

import { DEVICE_LIST_MESSAGE_TYPE } from '../device-list-protocol';
import { basePath } from './basePath';
import { isUtilityError, logUtilityErrors, type UtilityError } from './utilityErrors';

/**
 * The Expo Hub server (`src/server/`) exposes the live device list here,
 * under whatever mount `basePath()` resolves (the Expo CLI plugin prefix,
 * or wherever the standalone CLI mounts it). One WebSocket response includes
 * both running and shut-down devices.
 */
export function devicesWebSocketUrl(locationHref = window.location.href): string {
  const url = new URL(`${basePath()}/api/devices/ws`, locationHref);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export type DeviceList = {
  simulators: Device[];
  emulators: Device[];
};

export type DeviceListSnapshot = DeviceList & { errors?: UtilityError[] };

const EMPTY: DeviceList = { simulators: [], emulators: [] };

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/**
 * Subscribes to the server's shared device-discovery loop. The server does the
 * host polling once regardless of how many dashboards are open and sends only
 * changed snapshots. Returns the empty list until the first snapshot arrives.
 */
function useDeviceList(): DeviceList {
  const [devices, setDevices] = useState<DeviceList>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;
    let activeErrorIds = new Set<string>();

    function connect() {
      if (cancelled) return;
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(devicesWebSocketUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socket = nextSocket;

      nextSocket.onopen = () => {
        reconnectDelay = RECONNECT_MIN_MS;
      };
      nextSocket.onmessage = (event) => {
        const next = parseDeviceListMessage(event.data);
        if (!next) return;

        activeErrorIds = logUtilityErrors(next.errors, activeErrorIds);

        const { errors: _errors, ...nextDevices } = next;
        setDevices(nextDevices);
      };
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = () => {
        // Ignore a late close from a socket already superseded by a reconnect.
        if (socket !== nextSocket) return;
        socket = null;
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return devices;
}

export function parseDeviceListMessage(data: unknown): DeviceListSnapshot | null {
  if (typeof data !== 'string') return null;
  try {
    const message = JSON.parse(data) as {
      type?: unknown;
      devices?: { simulators?: unknown; emulators?: unknown; errors?: unknown };
    };
    if (
      message.type !== DEVICE_LIST_MESSAGE_TYPE ||
      !Array.isArray(message.devices?.simulators) ||
      !Array.isArray(message.devices?.emulators) ||
      (message.devices.errors !== undefined && !Array.isArray(message.devices.errors))
    ) {
      return null;
    }
    const errors = message.devices.errors?.filter(isUtilityError);
    return {
      simulators: message.devices.simulators as Device[],
      emulators: message.devices.emulators as Device[],
      ...(errors ? { errors } : {}),
    };
  } catch {
    return null;
  }
}

export function splitDeviceList(all: DeviceList): { booted: DeviceList; recent: DeviceList } {
  const filter = (booted: boolean) => ({
    simulators: all.simulators.filter((device) => device.booted === booted),
    emulators: all.emulators.filter((device) => device.booted === booted),
  });
  return { booted: filter(true), recent: filter(false) };
}

/** One connection supplying both the running sidebar and recent-device picker. */
export function useDeviceLists(): { booted: DeviceList; recent: DeviceList } {
  const all = useDeviceList();
  return useMemo(() => splitDeviceList(all), [all]);
}
