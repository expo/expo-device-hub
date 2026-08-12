import { DEVICE_LIST_MESSAGE_TYPE, HEARTBEAT_MESSAGE_TYPE } from '../device-list-protocol';
import { type HubDevice, type HubDeviceList, listDevices } from './devices';
import { SERVER_PLATFORM_FILTER } from './platform-filter';

const POLL_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 2_000;

export interface DeviceListSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

interface DeviceListBroadcasterOptions {
  load?: () => Promise<HubDeviceList>;
  intervalMs?: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  heartbeatIntervalMs?: number;
  scheduleHeartbeat?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  cancelHeartbeat?: (timer: ReturnType<typeof setInterval>) => void;
  onError?: (error: unknown) => void;
}

type Schedule = NonNullable<DeviceListBroadcasterOptions['schedule']>;
type CancelSchedule = NonNullable<DeviceListBroadcasterOptions['cancelSchedule']>;
type ScheduleHeartbeat = NonNullable<DeviceListBroadcasterOptions['scheduleHeartbeat']>;
type CancelHeartbeat = NonNullable<DeviceListBroadcasterOptions['cancelHeartbeat']>;

/**
 * A single device-discovery loop shared by every dashboard connection.
 * Polls never overlap, and the loop sleeps while there are no subscribers.
 */
export class DeviceListBroadcaster {
  readonly #clients = new Set<DeviceListSocket>();
  readonly #load: () => Promise<HubDeviceList>;
  readonly #intervalMs: number;
  readonly #schedule: Schedule;
  readonly #cancelSchedule: CancelSchedule;
  readonly #heartbeatIntervalMs: number;
  readonly #scheduleHeartbeat: ScheduleHeartbeat;
  readonly #cancelHeartbeat: CancelHeartbeat;
  readonly #onError: (error: unknown) => void;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #refreshQueued = false;
  #snapshot: HubDeviceList | null = null;
  #fingerprint: string | null = null;

  constructor(options: DeviceListBroadcasterOptions = {}) {
    this.#load = options.load ?? (() => listDevices(SERVER_PLATFORM_FILTER));
    this.#intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelSchedule = options.cancelSchedule ?? clearTimeout;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#scheduleHeartbeat = options.scheduleHeartbeat ?? setInterval;
    this.#cancelHeartbeat = options.cancelHeartbeat ?? clearInterval;
    this.#onError =
      options.onError ??
      ((error) => console.warn('[expo-device-hub] Failed to refresh device list:', error));
  }

  subscribe(socket: DeviceListSocket): void {
    const wasEmpty = this.#clients.size === 0;
    this.#clients.add(socket);

    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.#removeClient(socket);
    };
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);

    // Confirm liveness immediately, even if the first device discovery pass is
    // slow. Changed device snapshots and periodic heartbeats both keep the
    // browser-side watchdog alive after this initial message.
    if (wasEmpty) {
      this.#startHeartbeat();
      this.refresh();
    }
    this.#sendHeartbeat(socket);
    if (this.#clients.has(socket) && this.#snapshot) this.#send(socket, this.#snapshot);
  }

  /** Request a prompt refresh, coalescing with an in-flight discovery pass. */
  refresh(): void {
    if (this.#clients.size === 0) return;
    if (this.#polling) {
      this.#refreshQueued = true;
      return;
    }
    this.#stopTimer();
    void this.#poll();
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#clients.size === 0) return;
    this.#polling = true;

    try {
      const snapshot = await this.#load();
      const fingerprint = deviceListFingerprint(snapshot);
      if (fingerprint !== this.#fingerprint) {
        this.#snapshot = snapshot;
        this.#fingerprint = fingerprint;
        this.#broadcast(snapshot);
      }
    } catch (error) {
      // Keep serving the last known-good snapshot. A later poll can recover.
      this.#onError(error);
    } finally {
      this.#polling = false;
      if (this.#clients.size === 0) return;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        void this.#poll();
      } else {
        this.#timer = this.#schedule(() => {
          this.#timer = null;
          void this.#poll();
        }, this.#intervalMs);
      }
    }
  }

  #broadcast(snapshot: HubDeviceList): void {
    for (const socket of this.#clients) this.#send(socket, snapshot);
  }

  #broadcastHeartbeat(): void {
    for (const socket of this.#clients) this.#sendHeartbeat(socket);
  }

  #sendHeartbeat(socket: DeviceListSocket): void {
    this.#sendMessage(socket, JSON.stringify({ type: HEARTBEAT_MESSAGE_TYPE }));
  }

  #send(socket: DeviceListSocket, snapshot: HubDeviceList): void {
    this.#sendMessage(
      socket,
      JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: snapshot })
    );
  }

  #sendMessage(socket: DeviceListSocket, message: string): void {
    try {
      socket.send(message);
    } catch {
      this.#removeClient(socket);
      try {
        socket.close();
      } catch {}
    }
  }

  #removeClient(socket: DeviceListSocket): void {
    this.#clients.delete(socket);
    if (this.#clients.size > 0) return;
    this.#refreshQueued = false;
    this.#stopTimer();
    this.#stopHeartbeat();
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer !== null) return;
    this.#heartbeatTimer = this.#scheduleHeartbeat(
      () => this.#broadcastHeartbeat(),
      this.#heartbeatIntervalMs
    );
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer === null) return;
    this.#cancelHeartbeat(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #stopTimer(): void {
    if (this.#timer === null) return;
    this.#cancelSchedule(this.#timer);
    this.#timer = null;
  }
}

/** Compare semantic fields in a stable order, independent of CLI output order. */
export function deviceListFingerprint(list: HubDeviceList): string {
  const normalize = (devices: HubDevice[]) =>
    devices
      .map(
        ({
          id,
          name,
          version,
          platform,
          booted,
          physical,
          supported,
          deviceFrame,
          lastUsedAt,
        }) => ({
          id,
          name,
          version,
          platform,
          booted,
          physical,
          supported,
          deviceFrame,
          lastUsedAt,
        }),
      )
      .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify({
    simulators: normalize(list.simulators),
    emulators: normalize(list.emulators),
    errors: [...new Set((list.errors ?? []).map(({ id }) => id))].sort(),
  });
}

const deviceListBroadcaster = new DeviceListBroadcaster();

export function deviceListWebSocketHandler(socket: DeviceListSocket): void {
  deviceListBroadcaster.subscribe(socket);
}

export function refreshDeviceList(): void {
  deviceListBroadcaster.refresh();
}
