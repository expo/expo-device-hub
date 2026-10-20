import { useEffect, useMemo, useState } from "react";

import {
  type Device,
  type NetworkPanelBody,
  type NetworkPanelStatus,
  type NetworkSectionProps,
} from "@expo/hub-components";

import {
  type NetworkClientMessage,
  type NetworkRequest,
  type NetworkServerMessage,
} from "../network-protocol";
import { basePath } from "./basePath";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

/** The Hub's Network socket for one device. */
export function networkWebSocketUrl(device: Device, locationHref = window.location.href): string {
  const url = new URL(`${basePath()}/api/network/ws`, locationHref);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("platform", device.platform);
  url.searchParams.set("id", device.id);
  url.searchParams.set("name", device.name);
  url.searchParams.set("version", device.version);
  return url.toString();
}

export interface NetworkPanelState {
  status: NetworkPanelStatus;
  requests: NetworkRequest[];
  responseBodies: Record<string, NetworkPanelBody>;
}

export const INITIAL_NETWORK_STATE: NetworkPanelState = {
  status: { state: "connecting" },
  requests: [],
  responseBodies: {},
};

/** Fold one server message into the panel state. */
export function applyNetworkMessage(
  state: NetworkPanelState,
  message: NetworkServerMessage,
): NetworkPanelState {
  switch (message.type) {
    case "status":
      return { ...state, status: message.status };
    case "snapshot":
      return { ...state, requests: message.requests };
    case "request": {
      const index = state.requests.findIndex((request) => request.id === message.request.id);
      const requests =
        index === -1
          ? [...state.requests, message.request]
          : state.requests.map((request, i) => (i === index ? message.request : request));
      return { ...state, requests };
    }
    case "cleared":
      return { ...state, requests: [], responseBodies: {} };
    case "response-body":
      return {
        ...state,
        responseBodies: {
          ...state.responseBodies,
          [message.id]: message.body
            ? {
                state: "loaded",
                body: message.body.body,
                base64Encoded: message.body.base64Encoded,
              }
            : { state: "error", message: message.error ?? "The body is not available." },
        },
      };
  }
}

type NetworkSocket = {
  send(data: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

/**
 * Keep a Network socket open for `device` until the returned function is called, reconnecting with
 * backoff. `send` reaches the current socket.
 */
export function subscribeToNetwork({
  url,
  createSocket = (socketUrl) => new WebSocket(socketUrl) as unknown as NetworkSocket,
  onMessage,
  onDisconnected,
}: {
  url: string;
  createSocket?: (url: string) => NetworkSocket;
  onMessage: (message: NetworkServerMessage) => void;
  onDisconnected: () => void;
}): { send: (message: NetworkClientMessage) => void; close: () => void } {
  let cancelled = false;
  let socket: NetworkSocket | null = null;
  let delay = RECONNECT_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (cancelled) return;
    const next = createSocket(url);
    socket = next;
    next.onmessage = (event) => {
      delay = RECONNECT_MIN_MS;
      try {
        onMessage(JSON.parse(String(event.data)) as NetworkServerMessage);
      } catch {}
    };
    next.onerror = () => next.close();
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      if (cancelled) return;
      onDisconnected();
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };
  };
  connect();

  return {
    send: (message) => {
      try {
        socket?.send(JSON.stringify(message));
      } catch {}
    },
    close: () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}

/**
 * The Network section's props for the selected device. The Hub watches the app only while the
 * section is open, so a closed section costs no inspector connection.
 */
export function useNetworkInspector(device: Device | undefined): NetworkSectionProps {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<NetworkPanelState>(INITIAL_NETWORK_STATE);
  const [connection, setConnection] = useState<ReturnType<typeof subscribeToNetwork> | null>(null);
  const url = device ? networkWebSocketUrl(device) : null;

  useEffect(() => {
    setState(INITIAL_NETWORK_STATE);
    if (!open || !url) {
      setConnection(null);
      return;
    }
    const subscription = subscribeToNetwork({
      url,
      onMessage: (message) => setState((current) => applyNetworkMessage(current, message)),
      onDisconnected: () =>
        setState((current) => ({ ...current, status: { state: "connecting" } })),
    });
    setConnection(subscription);
    return () => subscription.close();
  }, [open, url]);

  return useMemo<NetworkSectionProps>(
    () => ({
      status: state.status,
      requests: state.requests,
      responseBodies: state.responseBodies,
      onOpenChange: setOpen,
      onClear: () => connection?.send({ type: "clear" }),
      onRequestResponseBody: (id) => {
        setState((current) => ({
          ...current,
          responseBodies: { ...current.responseBodies, [id]: { state: "loading" } },
        }));
        connection?.send({ type: "get-response-body", id });
      },
    }),
    [state, connection],
  );
}
