import { useEffect, useState } from 'react';

import { type AgentInteraction } from '@expo/hub-client';

import {
  ARGENT_INTERACTION_MESSAGE_TYPE,
  type ArgentInteractionMessage,
} from '../argent-interaction-protocol';
import { basePath } from './basePath';

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

export function argentInteractionsWebSocketUrl(locationHref = window.location.href): string {
  const url = new URL(`${basePath()}/api/argent-interactions/ws`, locationHref);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function useArgentInteraction(deviceId?: string): AgentInteraction | null {
  const [latest, setLatest] = useState<Record<string, AgentInteraction>>({});

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelay = RECONNECT_MIN_MS;

    function connect() {
      if (cancelled) return;
      let nextSocket: WebSocket;
      try {
        nextSocket = new WebSocket(argentInteractionsWebSocketUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socket = nextSocket;
      nextSocket.onopen = () => {
        reconnectDelay = RECONNECT_MIN_MS;
      };
      nextSocket.onmessage = (event) => {
        const message = parseArgentInteractionMessage(event.data);
        if (!message) return;
        setLatest((current) => ({
          ...current,
          [message.interaction.deviceId]: message.interaction,
        }));
      };
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = () => {
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

  return deviceId ? (latest[deviceId] ?? null) : null;
}

export function parseArgentInteractionMessage(data: unknown): ArgentInteractionMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const message = JSON.parse(data) as Partial<ArgentInteractionMessage>;
    const interaction = message.interaction;
    if (
      message.type !== ARGENT_INTERACTION_MESSAGE_TYPE ||
      typeof interaction?.id !== 'string' ||
      typeof interaction.deviceId !== 'string' ||
      typeof interaction.timestamp !== 'string' ||
      !Array.isArray(interaction.segments) ||
      !interaction.segments.every(isInteractionSegment)
    ) {
      return null;
    }
    return message as ArgentInteractionMessage;
  } catch {
    return null;
  }
}

function isInteractionSegment(value: unknown): boolean {
  if (!isObject(value) || !isFiniteNumber(value.startMs) || !Array.isArray(value.frames)) {
    return false;
  }
  return value.frames.every(
    (frame) =>
      isObject(frame) &&
      isFiniteNumber(frame.atMs) &&
      Array.isArray(frame.points) &&
      frame.points.length >= 1 &&
      frame.points.length <= 2 &&
      frame.points.every(
        (point) => isObject(point) && isFiniteNumber(point.x) && isFiniteNumber(point.y)
      )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
