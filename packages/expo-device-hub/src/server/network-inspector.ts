/**
 * The Network panel's server half: for each device a dashboard watches, one connection to the
 * React Native inspector of the app on that device, through the Metro server, with the Network
 * domain enabled. Requests are kept in memory, redacted, and streamed to every watching dashboard.
 *
 * @ref LLP 0014 — why the Hub reads app traffic through Metro instead of a device proxy.
 */

import { readDeviceProps } from "@expo/hub-android-utils";
import WebSocket from "ws";

import {
  NETWORK_MAX_REQUESTS,
  type NetworkClientMessage,
  type NetworkInspectorStatus,
  type NetworkRequest,
  type NetworkResponseBody,
  type NetworkServerMessage,
} from "../network-protocol";
import { redactHeaders } from "./network-redact";
import {
  androidInspectorDeviceName,
  debuggerUrlOn,
  type InspectorTarget,
  inspectorOrigins,
  iosInspectorDeviceNames,
  listInspectorTargets,
  metroOriginFor,
  type NetworkDeviceRef,
  pickTarget,
} from "./network-targets";

const TARGET_POLL_MS = 2_000;
const ATTACH_TIMEOUT_MS = 3_000;
const BODY_TIMEOUT_MS = 5_000;
/** How long a session outlives its last dashboard, so switching devices back keeps the list. */
const IDLE_DISPOSE_MS = 30_000;

export interface NetworkSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

/** The inspector connection, narrowed to what the session uses. */
export interface CdpSocket {
  send(data: string): void;
  close(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface NetworkSessionDeps {
  listTargets: (metroOrigin: string) => Promise<InspectorTarget[]>;
  /** The names the inspector may give the device, best first; null when they cannot be read yet. */
  deviceNames: (device: NetworkDeviceRef) => Promise<string[] | null>;
  connect: (url: string, origin: string) => CdpSocket;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultDeps: NetworkSessionDeps = {
  listTargets: (metroOrigin) => listInspectorTargets(metroOrigin),
  deviceNames: async (device) => {
    if (device.platform === "ios") return iosInspectorDeviceNames(device);
    const props = await readDeviceProps(device.id);
    const name = props.value ? androidInspectorDeviceName(props.value) : null;
    return name ? [name] : null;
  },
  connect: (url, origin) => new WebSocket(url, { headers: { Origin: origin } }),
  now: Date.now,
  setTimeout,
  clearTimeout,
};

/** Internal per-request state: the panel's view plus the CDP monotonic start time. */
interface TrackedRequest {
  view: NetworkRequest;
  /** CDP `timestamp` (monotonic seconds) of `requestWillBeSent`. */
  startTimestamp?: number;
}

type CdpEvent = { method: string; params?: Record<string, any> };
type CdpReply = { id: number; result?: Record<string, any>; error?: { message?: string } };

/**
 * One device's network view. It finds the device's app among Metro's inspector targets, keeps one
 * inspector connection to it while any dashboard watches, and reattaches when the app reconnects.
 */
export class NetworkSession {
  readonly #device: NetworkDeviceRef;
  readonly #metroOrigin: string;
  readonly #deps: NetworkSessionDeps;
  readonly #onIdle: () => void;

  readonly #clients = new Set<NetworkSocket>();
  readonly #requests = new Map<string, TrackedRequest>();
  readonly #pendingReplies = new Map<number, (reply: CdpReply) => void>();

  #status: NetworkInspectorStatus = { state: "searching" };
  #deviceNames: string[] | null = null;
  #target: InspectorTarget | null = null;
  #cdp: CdpSocket | null = null;
  #nextCdpId = 1;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  #polling = false;
  #disposed = false;

  constructor(
    device: NetworkDeviceRef,
    metroOrigin: string,
    onIdle: () => void,
    deps: NetworkSessionDeps = defaultDeps,
  ) {
    this.#device = device;
    this.#metroOrigin = metroOrigin;
    this.#onIdle = onIdle;
    this.#deps = deps;
  }

  get status(): NetworkInspectorStatus {
    return this.#status;
  }

  subscribe(socket: NetworkSocket): void {
    if (this.#idleTimer !== null) {
      this.#deps.clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const wasEmpty = this.#clients.size === 0;
    this.#clients.add(socket);

    let active = true;
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      this.#clients.delete(socket);
      if (this.#clients.size === 0) this.#scheduleIdle();
    };
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    socket.on("message", (data) => this.#onClientMessage(socket, data));

    this.#sendTo(socket, { type: "status", status: this.#status });
    this.#sendTo(socket, {
      type: "snapshot",
      requests: [...this.#requests.values()].map((request) => request.view),
    });
    if (wasEmpty) void this.#poll();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== null) this.#deps.clearTimeout(this.#pollTimer);
    if (this.#idleTimer !== null) this.#deps.clearTimeout(this.#idleTimer);
    this.#pollTimer = null;
    this.#idleTimer = null;
    this.#detach();
    for (const socket of this.#clients) {
      try {
        socket.close();
      } catch {}
    }
    this.#clients.clear();
  }

  #scheduleIdle(): void {
    if (this.#idleTimer !== null) return;
    this.#idleTimer = this.#deps.setTimeout(() => {
      this.#idleTimer = null;
      if (this.#clients.size > 0) return;
      this.dispose();
      this.#onIdle();
    }, IDLE_DISPOSE_MS);
  }

  /** Find the app's target; attach to it, or follow it to a new page after a reconnect. */
  async #poll(): Promise<void> {
    if (this.#polling || this.#disposed) return;
    this.#polling = true;
    try {
      this.#deviceNames ??= await this.#deps.deviceNames(this.#device);
      if (this.#deviceNames === null) {
        this.#setStatus({
          state: "searching",
          message: "Reading the device's name for the React Native inspector.",
        });
        return;
      }
      let targets: InspectorTarget[];
      try {
        targets = await this.#deps.listTargets(this.#metroOrigin);
      } catch {
        this.#detach();
        this.#setStatus({
          state: "unavailable",
          message:
            "No Metro server answers here. Open the Hub from `expo start`, or set EXPO_DEVICE_HUB_METRO_URL.",
        });
        return;
      }
      const target = pickTarget(targets, this.#deviceNames);
      if (!target) {
        this.#detach();
        this.#setStatus({
          state: "searching",
          message:
            "Open a development build of your app on this device, connected to this Metro server.",
        });
        return;
      }
      if (this.#cdp && this.#target?.webSocketDebuggerUrl === target.webSocketDebuggerUrl) return;
      this.#detach();
      await this.#attach(target);
    } finally {
      this.#polling = false;
      if (!this.#disposed && this.#clients.size > 0) {
        this.#pollTimer = this.#deps.setTimeout(() => {
          this.#pollTimer = null;
          void this.#poll();
        }, TARGET_POLL_MS);
      }
    }
  }

  /** Try each origin until the inspector keeps the connection and enables the Network domain. */
  async #attach(target: InspectorTarget): Promise<void> {
    const url = debuggerUrlOn(this.#metroOrigin, target);
    for (const origin of inspectorOrigins(this.#metroOrigin)) {
      const socket = await this.#tryAttach(url, origin);
      if (!socket) continue;
      if (this.#disposed) {
        socket.close();
        return;
      }
      this.#cdp = socket;
      this.#target = target;
      socket.on("close", () => {
        if (this.#cdp !== socket) return;
        this.#cdp = null;
        this.#target = null;
        this.#rejectPendingReplies();
        this.#setStatus({ state: "searching", message: "The app disconnected from Metro." });
      });
      this.#setStatus({
        state: "attached",
        app: { id: target.appId, deviceName: target.deviceName },
      });
      return;
    }
    this.#setStatus({
      state: "unavailable",
      message: "Metro refused the inspector connection. Is the Hub running inside `expo start`?",
    });
  }

  /** Resolves with an open socket whose `Network.enable` succeeded, or null. */
  #tryAttach(url: string, origin: string): Promise<CdpSocket | null> {
    return new Promise((resolve) => {
      let settled = false;
      const enableId = this.#nextCdpId++;
      const socket = this.#deps.connect(url, origin);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.#deps.clearTimeout(timer);
        if (!ok) {
          try {
            socket.close();
          } catch {}
        }
        resolve(ok ? socket : null);
      };
      const timer = this.#deps.setTimeout(() => finish(false), ATTACH_TIMEOUT_MS);
      socket.on("open", () => {
        socket.send(JSON.stringify({ id: enableId, method: "Network.enable", params: {} }));
      });
      socket.on("message", (data) => {
        const message = parseJson(data);
        if (!message) return;
        if (!settled) {
          if ("id" in message && message.id === enableId)
            finish(!("error" in message && message.error));
          return;
        }
        this.#onCdpMessage(message);
      });
      // Expo CLI closes a debugger with the wrong origin right after the handshake.
      socket.on("close", () => finish(false));
      socket.on("error", () => finish(false));
    });
  }

  #detach(): void {
    const socket = this.#cdp;
    this.#cdp = null;
    this.#target = null;
    this.#rejectPendingReplies();
    if (socket) {
      try {
        socket.close();
      } catch {}
    }
  }

  #onCdpMessage(message: CdpEvent | CdpReply): void {
    if ("id" in message && typeof message.id === "number") {
      const resolve = this.#pendingReplies.get(message.id);
      if (resolve) {
        this.#pendingReplies.delete(message.id);
        resolve(message);
      }
      return;
    }
    if ("method" in message && typeof message.method === "string") this.#onNetworkEvent(message);
  }

  #onNetworkEvent({ method, params }: CdpEvent): void {
    if (!params || typeof params.requestId !== "string") return;
    const id: string = params.requestId;
    const existing = this.#requests.get(id);

    switch (method) {
      case "Network.requestWillBeSent": {
        const request = params.request ?? {};
        const startedAt =
          typeof params.wallTime === "number"
            ? Math.round(params.wallTime * 1000)
            : this.#deps.now();
        this.#upsert(id, {
          view: {
            ...existing?.view,
            id,
            method: String(request.method ?? "GET"),
            url: String(request.url ?? ""),
            startedAt: existing?.view.startedAt ?? startedAt,
            resourceType:
              typeof params.type === "string" ? params.type : existing?.view.resourceType,
            requestHeaders:
              request.headers && typeof request.headers === "object"
                ? redactHeaders(request.headers)
                : existing?.view.requestHeaders,
            requestBody:
              typeof request.postData === "string" ? request.postData : existing?.view.requestBody,
          },
          startTimestamp: existing?.startTimestamp ?? numberOrUndefined(params.timestamp),
        });
        return;
      }
      case "Network.requestWillBeSentExtraInfo": {
        if (!existing || !params.headers || typeof params.headers !== "object") return;
        this.#upsert(id, {
          ...existing,
          view: { ...existing.view, requestHeaders: redactHeaders(params.headers) },
        });
        return;
      }
      case "Network.responseReceived": {
        if (!existing) return;
        const response = params.response ?? {};
        this.#upsert(id, {
          ...existing,
          view: {
            ...existing.view,
            status: numberOrUndefined(response.status),
            statusText: typeof response.statusText === "string" ? response.statusText : undefined,
            mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
            responseHeaders:
              response.headers && typeof response.headers === "object"
                ? redactHeaders(response.headers)
                : existing.view.responseHeaders,
          },
        });
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        if (!existing) return;
        const finishedAt = this.#finishedAt(existing, numberOrUndefined(params.timestamp));
        this.#upsert(id, {
          ...existing,
          view: {
            ...existing.view,
            finishedAt,
            encodedDataLength:
              numberOrUndefined(params.encodedDataLength) ?? existing.view.encodedDataLength,
            failed:
              method === "Network.loadingFailed"
                ? params.canceled
                  ? "Canceled"
                  : String(params.errorText || "Failed")
                : existing.view.failed,
          },
        });
        return;
      }
    }
  }

  /** CDP timestamps are monotonic seconds; place the end relative to the wall-clock start. */
  #finishedAt(request: TrackedRequest, timestamp: number | undefined): number {
    if (timestamp !== undefined && request.startTimestamp !== undefined) {
      return (
        request.view.startedAt +
        Math.max(0, Math.round((timestamp - request.startTimestamp) * 1000))
      );
    }
    return this.#deps.now();
  }

  #upsert(id: string, request: TrackedRequest): void {
    if (!this.#requests.has(id) && this.#requests.size >= NETWORK_MAX_REQUESTS) {
      const oldest = this.#requests.keys().next().value;
      if (oldest !== undefined) this.#requests.delete(oldest);
    }
    this.#requests.set(id, request);
    this.#broadcast({ type: "request", request: request.view });
  }

  #onClientMessage(socket: NetworkSocket, data: unknown): void {
    const message = parseJson(data) as NetworkClientMessage | null;
    if (!message || typeof message !== "object") return;
    if (message.type === "clear") {
      this.#requests.clear();
      this.#broadcast({ type: "cleared" });
    } else if (message.type === "get-response-body" && typeof message.id === "string") {
      void this.#sendResponseBody(socket, message.id);
    }
  }

  async #sendResponseBody(socket: NetworkSocket, id: string): Promise<void> {
    const reply = await this.#call("Network.getResponseBody", { requestId: id });
    if (!reply || reply.error || !reply.result) {
      this.#sendTo(socket, {
        type: "response-body",
        id,
        body: null,
        error: reply?.error?.message ?? "The app no longer has this response body.",
      });
      return;
    }
    const body: NetworkResponseBody = {
      body: String(reply.result.body ?? ""),
      base64Encoded: reply.result.base64Encoded === true,
    };
    this.#sendTo(socket, { type: "response-body", id, body });
  }

  /** Send a CDP command to the app; null when not attached or no reply arrives in time. */
  #call(method: string, params: Record<string, unknown>): Promise<CdpReply | null> {
    const socket = this.#cdp;
    if (!socket) return Promise.resolve(null);
    const id = this.#nextCdpId++;
    return new Promise((resolve) => {
      const timer = this.#deps.setTimeout(() => {
        this.#pendingReplies.delete(id);
        resolve(null);
      }, BODY_TIMEOUT_MS);
      this.#pendingReplies.set(id, (reply) => {
        this.#deps.clearTimeout(timer);
        resolve(reply);
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.#pendingReplies.delete(id);
        this.#deps.clearTimeout(timer);
        resolve(null);
      }
    });
  }

  #rejectPendingReplies(): void {
    const pending = [...this.#pendingReplies.values()];
    this.#pendingReplies.clear();
    for (const resolve of pending) resolve({ id: -1, error: { message: "The app disconnected." } });
  }

  #setStatus(status: NetworkInspectorStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.#status)) return;
    this.#status = status;
    this.#broadcast({ type: "status", status });
  }

  #broadcast(message: NetworkServerMessage): void {
    const data = JSON.stringify(message);
    for (const socket of this.#clients) this.#sendRaw(socket, data);
  }

  #sendTo(socket: NetworkSocket, message: NetworkServerMessage): void {
    this.#sendRaw(socket, JSON.stringify(message));
  }

  #sendRaw(socket: NetworkSocket, data: string): void {
    try {
      socket.send(data);
    } catch {
      this.#clients.delete(socket);
    }
  }
}

function parseJson(data: unknown): any {
  try {
    return JSON.parse(typeof data === "string" ? data : String(data));
  } catch {
    return null;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse the device the dashboard asks for from the socket URL's query. */
export function parseNetworkDeviceRef(requestUrl: string): NetworkDeviceRef | null {
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    return null;
  }
  const platform = params.get("platform");
  const id = params.get("id");
  const name = params.get("name");
  const version = params.get("version");
  if ((platform !== "ios" && platform !== "android") || !id || name === null || version === null) {
    return null;
  }
  return { platform, id, name, version };
}

const sessions = new Map<string, NetworkSession>();

/** `/api/network/ws?platform=&id=&name=&version=`: stream one device's app traffic. */
export function networkWebSocketHandler(socket: NetworkSocket, request: Request): void {
  const device = parseNetworkDeviceRef(request.url);
  const metroOrigin = metroOriginFor(request.url);
  if (!device || !metroOrigin) {
    socket.close(1008, "Expected ?platform=&id=&name=&version=");
    return;
  }
  const key = `${metroOrigin}|${device.platform}|${device.id}`;
  let session = sessions.get(key);
  if (!session) {
    session = new NetworkSession(device, metroOrigin, () => sessions.delete(key));
    sessions.set(key, session);
  }
  session.subscribe(socket);
}
