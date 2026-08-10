import { type AgentInteraction } from '@expo/hub-client';

import { argentInteractionMessage } from '../argent-interaction-protocol';
import { ArgentInteractionLog } from './argent-interaction-log';

const POLL_INTERVAL_MS = 100;

export interface ArgentInteractionSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'close' | 'error', listener: () => void): unknown;
}

interface ArgentInteractionBroadcasterOptions {
  read?: () => Promise<AgentInteraction[]>;
  intervalMs?: number;
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}

export class ArgentInteractionBroadcaster {
  readonly #clients = new Set<ArgentInteractionSocket>();
  readonly #latest = new Map<string, AgentInteraction>();
  readonly #read: () => Promise<AgentInteraction[]>;
  readonly #intervalMs: number;
  readonly #schedule: NonNullable<ArgentInteractionBroadcasterOptions['schedule']>;
  readonly #cancelSchedule: NonNullable<ArgentInteractionBroadcasterOptions['cancelSchedule']>;
  readonly #onError: (error: unknown) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #polling = false;
  #initialized = false;

  constructor(options: ArgentInteractionBroadcasterOptions = {}) {
    const log = new ArgentInteractionLog();
    this.#read = options.read ?? (() => log.read());
    this.#intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancelSchedule = options.cancelSchedule ?? clearTimeout;
    this.#onError =
      options.onError ??
      ((error) => console.warn('[expo-device-hub] Failed to read Argent interactions:', error));
  }

  subscribe(socket: ArgentInteractionSocket): void {
    const wasEmpty = this.#clients.size === 0;
    this.#clients.add(socket);
    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.#clients.delete(socket);
      if (this.#clients.size === 0) this.#stopTimer();
    };
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);

    for (const interaction of this.#latest.values()) this.#send(socket, interaction);
    if (wasEmpty) void this.#poll();
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#clients.size === 0) return;
    this.#polling = true;
    try {
      const interactions = await this.#read();
      for (const interaction of interactions) this.#latest.set(interaction.deviceId, interaction);
      if (this.#initialized) {
        for (const interaction of interactions) this.#broadcast(interaction);
      } else {
        this.#initialized = true;
        for (const interaction of this.#latest.values()) this.#broadcast(interaction);
      }
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#polling = false;
      if (this.#clients.size > 0) {
        this.#timer = this.#schedule(() => {
          this.#timer = null;
          void this.#poll();
        }, this.#intervalMs);
      }
    }
  }

  #broadcast(interaction: AgentInteraction): void {
    for (const socket of this.#clients) this.#send(socket, interaction);
  }

  #send(socket: ArgentInteractionSocket, interaction: AgentInteraction): void {
    try {
      socket.send(JSON.stringify(argentInteractionMessage(interaction)));
    } catch {
      this.#clients.delete(socket);
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

const argentInteractionBroadcaster = new ArgentInteractionBroadcaster();

export function argentInteractionWebSocketHandler(socket: ArgentInteractionSocket): void {
  argentInteractionBroadcaster.subscribe(socket);
}
