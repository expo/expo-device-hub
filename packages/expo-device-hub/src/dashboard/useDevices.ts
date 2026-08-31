import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { type Device } from '@expo/hub-components';

import { DEVICE_LIST_MESSAGE_TYPE, HEARTBEAT_MESSAGE_TYPE } from '../device-list-protocol';
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
export type DeviceListConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type DeviceListSocketMessage =
  | { type: typeof HEARTBEAT_MESSAGE_TYPE }
  | { type: typeof DEVICE_LIST_MESSAGE_TYPE; devices: DeviceListSnapshot };

const EMPTY: DeviceList = { simulators: [], emulators: [] };

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 6_000;

type DeviceListSocket = {
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
};

type ConnectionTimer = ReturnType<typeof setTimeout>;

type DeviceListSubscriptionOptions = {
  url?: string;
  createSocket?: (url: string) => DeviceListSocket;
  schedule?: (callback: () => void, delay: number) => ConnectionTimer;
  cancelSchedule?: (timer: ConnectionTimer) => void;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  heartbeatTimeoutMs?: number;
  onSnapshot: (snapshot: DeviceListSnapshot) => void;
  onStatus: (status: DeviceListConnectionStatus) => void;
};

export type DeviceListSubscription = {
  /** Replace the current socket with a fresh connection attempt immediately. */
  reconnect: () => void;
  unsubscribe: () => void;
};

/**
 * Owns the device-list socket lifecycle independently from React so reconnect
 * and heartbeat-timeout behavior can be tested with fake sockets and clocks.
 */
export function subscribeToDeviceList({
  url = devicesWebSocketUrl(),
  createSocket = (socketUrl) => new WebSocket(socketUrl) as DeviceListSocket,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  reconnectMinMs = RECONNECT_MIN_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  onSnapshot,
  onStatus,
}: DeviceListSubscriptionOptions): DeviceListSubscription {
  let cancelled = false;
  let socket: DeviceListSocket | null = null;
  let reconnectTimer: ConnectionTimer | null = null;
  let watchdogTimer: ConnectionTimer | null = null;
  let reconnectDelay = reconnectMinMs;
  let status: DeviceListConnectionStatus = 'connecting';

  const updateStatus = (next: DeviceListConnectionStatus) => {
    if (status === next) return;
    status = next;
    onStatus(next);
  };

  const clearWatchdog = () => {
    if (watchdogTimer === null) return;
    cancelSchedule(watchdogTimer);
    watchdogTimer = null;
  };

  const scheduleReconnect = () => {
    if (cancelled || reconnectTimer !== null) return;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs);
  };

  const disconnect = (target: DeviceListSocket) => {
    if (cancelled || socket !== target) return;
    socket = null;
    clearWatchdog();
    updateStatus('disconnected');
    try {
      target.close();
    } catch {}
    scheduleReconnect();
  };

  const armWatchdog = (target: DeviceListSocket) => {
    clearWatchdog();
    watchdogTimer = schedule(() => disconnect(target), heartbeatTimeoutMs);
  };

  const markAlive = (target: DeviceListSocket) => {
    if (cancelled || socket !== target) return;
    reconnectDelay = reconnectMinMs;
    updateStatus('connected');
    armWatchdog(target);
  };

  function connect() {
    if (cancelled) return;

    let nextSocket: DeviceListSocket;
    try {
      nextSocket = createSocket(url);
    } catch {
      updateStatus('disconnected');
      scheduleReconnect();
      return;
    }
    socket = nextSocket;
    armWatchdog(nextSocket);

    // Opening the transport is not enough to prove this is a compatible,
    // responsive Hub server. A valid protocol message marks it connected.
    nextSocket.onmessage = (event) => {
      const message = parseDeviceListSocketMessage(event.data);
      if (!message) return;

      markAlive(nextSocket);
      if (message.type === DEVICE_LIST_MESSAGE_TYPE) onSnapshot(message.devices);
    };
    nextSocket.onerror = () => disconnect(nextSocket);
    nextSocket.onclose = () => disconnect(nextSocket);
  }

  onStatus(status);
  connect();

  const reconnect = () => {
    if (cancelled) return;
    if (reconnectTimer !== null) {
      cancelSchedule(reconnectTimer);
      reconnectTimer = null;
    }
    clearWatchdog();
    const activeSocket = socket;
    socket = null;
    try {
      activeSocket?.close();
    } catch {}
    reconnectDelay = reconnectMinMs;
    updateStatus('connecting');
    connect();
  };

  const unsubscribe = () => {
    cancelled = true;
    if (reconnectTimer !== null) cancelSchedule(reconnectTimer);
    clearWatchdog();
    const activeSocket = socket;
    socket = null;
    try {
      activeSocket?.close();
    } catch {}
  };

  return { reconnect, unsubscribe };
}

/**
 * Subscribes to the server's shared device-discovery loop. The server does the
 * host polling once regardless of how many dashboards are open and sends only
 * changed snapshots. Returns the empty list until the first snapshot arrives.
 */
function useDeviceList(): {
  devices: DeviceList;
  connectionStatus: DeviceListConnectionStatus;
  reconnect: () => void;
} {
  const [devices, setDevices] = useState<DeviceList>(EMPTY);
  const [connectionStatus, setConnectionStatus] =
    useState<DeviceListConnectionStatus>('connecting');
  const subscriptionRef = useRef<DeviceListSubscription | null>(null);

  useEffect(() => {
    let activeErrorIds = new Set<string>();

    const subscription = subscribeToDeviceList({
      onSnapshot: (snapshot) => {
        activeErrorIds = logUtilityErrors(snapshot.errors, activeErrorIds);
        const { errors: _errors, ...nextDevices } = snapshot;
        setDevices(nextDevices);
      },
      onStatus: setConnectionStatus,
    });
    subscriptionRef.current = subscription;

    return () => {
      if (subscriptionRef.current === subscription) subscriptionRef.current = null;
      subscription.unsubscribe();
    };
  }, []);

  const reconnect = useCallback(() => subscriptionRef.current?.reconnect(), []);

  return { devices, connectionStatus, reconnect };
}

export function parseDeviceListSocketMessage(data: unknown): DeviceListSocketMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const message = JSON.parse(data) as {
      type?: unknown;
      devices?: { simulators?: unknown; emulators?: unknown; errors?: unknown };
    };
    if (message.type === HEARTBEAT_MESSAGE_TYPE) {
      return { type: HEARTBEAT_MESSAGE_TYPE };
    }
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
      type: DEVICE_LIST_MESSAGE_TYPE,
      devices: {
        simulators: message.devices.simulators as Device[],
        emulators: message.devices.emulators as Device[],
        ...(errors ? { errors } : {}),
      },
    };
  } catch {
    return null;
  }
}

export function parseDeviceListMessage(data: unknown): DeviceListSnapshot | null {
  const message = parseDeviceListSocketMessage(data);
  return message?.type === DEVICE_LIST_MESSAGE_TYPE ? message.devices : null;
}

export function splitDeviceList(all: DeviceList): {
  booted: DeviceList;
  recent: DeviceList;
} {
  const filter = (booted: boolean) => ({
    simulators: all.simulators.filter((device) => device.booted === booted),
    emulators: all.emulators.filter((device) => device.booted === booted),
  });
  return { booted: filter(true), recent: filter(false) };
}

/** One connection supplying both the running sidebar and recent-device picker. */
export function useDeviceLists(): {
  booted: DeviceList;
  recent: DeviceList;
  connectionStatus: DeviceListConnectionStatus;
  reconnect: () => void;
} {
  const { devices, connectionStatus, reconnect } = useDeviceList();
  const lists = useMemo(() => splitDeviceList(devices), [devices]);
  return { ...lists, connectionStatus, reconnect };
}
