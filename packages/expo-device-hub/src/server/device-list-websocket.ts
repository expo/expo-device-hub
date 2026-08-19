import { DEVICE_LIST_MESSAGE_TYPE } from '../device-list-protocol';
import { type HubDevice, type HubDeviceList, listDevices } from './devices';
import { SERVER_PLATFORM_FILTER } from './platform-filter';

const POLL_INTERVAL_MS = 500;

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
  onError?: (error: unknown) => void;
}

type Schedule = NonNullable<DeviceListBroadcasterOptions['schedule']>;
type CancelSchedule = NonNullable<DeviceListBroadcasterOptions['cancelSchedule']>;

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
  readonly #onError: (error: unknown) => void;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #polling = false;
  #refreshQueued = false;
  #snapshot: HubDeviceList | null = null;
  #fingerprint: string | null = null;

  constructor(options: DeviceListBroadcasterOptions = {}) {
    this.#load = options.load ?? (() => listDevices(SERVER_PLATFORM_FILTER));
    this.#intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelSchedule = options.cancelSchedule ?? clearTimeout;
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
      this.#clients.delete(socket);
      if (this.#clients.size === 0) {
        this.#refreshQueued = false;
        this.#stopTimer();
      }
    };
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);

    // A reconnecting/new tab gets the latest known state immediately. The
    // first subscriber also starts a fresh discovery pass in the background.
    if (this.#snapshot) this.#send(socket, this.#snapshot);
    if (wasEmpty) this.refresh();
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

  #send(socket: DeviceListSocket, snapshot: HubDeviceList): void {
    try {
      socket.send(JSON.stringify({ type: DEVICE_LIST_MESSAGE_TYPE, devices: snapshot }));
    } catch {
      this.#clients.delete(socket);
      if (this.#clients.size === 0) this.#stopTimer();
      try {
        socket.close();
      } catch {}
    }
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
      .map(({ id, name, version, platform, booted, physical, lastUsedAt }) => ({
        id,
        name,
        version,
        platform,
        booted,
        physical,
        lastUsedAt,
      }))
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
