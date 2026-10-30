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
  matchTarget,
  MetroUrlError,
  metroOriginFor,
  type NetworkDeviceRef,
} from "./network-targets";

const TARGET_POLL_MS = 2_000;
const ATTACH_TIMEOUT_MS = 3_000;
const BODY_TIMEOUT_MS = 5_000;
/** Extra-info headers kept for requests whose `requestWillBeSent` has not arrived yet. */
const MAX_PENDING_EXTRA_HEADERS = 200;
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
  connect: connectInspector,
  now: Date.now,
  setTimeout,
  clearTimeout,
};

/**
 * Open an inspector connection with an `Origin` header.
 *
 * @ref LLP 0014#origin — under Bun the bundled `ws` client never gets a working connection, so use
 * Bun's own `WebSocket`, which takes headers too. Node keeps `ws`.
 */
function connectInspector(url: string, origin: string): CdpSocket {
  const runtime = globalThis as { Bun?: unknown; WebSocket?: typeof globalThis.WebSocket };
  if (runtime.Bun !== undefined && runtime.WebSocket) {
    const BunWebSocket = runtime.WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => globalThis.WebSocket;
    return adaptWebSocket(new BunWebSocket(url, { headers: { Origin: origin } }));
  }
  return new WebSocket(url, { headers: { Origin: origin } });
}

/** A browser-style WebSocket behind the `ws`-style `on` interface the session uses. */
export function adaptWebSocket(socket: globalThis.WebSocket): CdpSocket {
  const adapted: CdpSocket = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    on: (event: "open" | "message" | "close" | "error", listener: (data?: unknown) => void) => {
      socket.addEventListener(event, (e) =>
        event === "message" ? listener((e as MessageEvent).data) : listener(),
      );
      return adapted;
    },
  };
  return adapted;
}

/** Internal per-request state: the panel's view plus what maps it back to the inspector. */
interface TrackedRequest {
  view: NetworkRequest;
  /** The inspector's own request id, valid only on the connection numbered `generation`. */
  cdpId: string;
  generation: number;
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
  /** Inspector request id → the session id of its current hop, for the current connection. */
  readonly #keys = new Map<string, string>();
  /** Inspector request id → how many redirects it has followed, for the current connection. */
  readonly #hops = new Map<string, number>();
  readonly #pendingExtraHeaders = new Map<string, Record<string, string>>();
  /** Counts inspector connections, so request ids from different connections never collide. */
  #generation = 0;

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
      const match = matchTarget(targets, this.#deviceNames);
      if (match.kind === "ambiguous") {
        this.#detach();
        this.#setStatus({
          state: "searching",
          message:
            match.reason === "shared-name"
              ? `More than one device is named "${match.deviceName}", so the Hub cannot tell which app runs on this one. Rename one of them.`
              : `More than one app answers to "${match.deviceName}", and not all of them report which device they run on, so the Hub cannot tell which one to show. Close the other apps, or rename this device if another device shares its name.`,
        });
        return;
      }
      if (match.kind === "none") {
        this.#detach();
        this.#setStatus({
          state: "searching",
          message:
            "Open a development build of your app on this device, connected to this Metro server.",
        });
        return;
      }
      const { target } = match;
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
      // @ref LLP 0014#how-it-works — the inspector numbers requests per connection, so a new
      // connection starts a new id space; requests already listed keep theirs.
      this.#generation += 1;
      this.#keys.clear();
      this.#hops.clear();
      this.#pendingExtraHeaders.clear();
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
    this.#pendingExtraHeaders.clear();
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
    const cdpId: string = params.requestId;

    if (method === "Network.requestWillBeSent") {
      this.#onRequestWillBeSent(cdpId, params);
      return;
    }

    const key = this.#keys.get(cdpId);
    const existing = key ? this.#requests.get(key) : undefined;

    if (method === "Network.requestWillBeSentExtraInfo") {
      if (!params.headers || typeof params.headers !== "object") return;
      const headers = redactHeaders(params.headers);
      // CDP does not order extra-info before or after the request it describes.
      if (!key || !existing) {
        this.#bufferExtraHeaders(cdpId, headers);
        return;
      }
      this.#upsert(key, {
        ...existing,
        view: { ...existing.view, requestHeaders: { ...existing.view.requestHeaders, ...headers } },
      });
      return;
    }

    if (!key || !existing) return;
    switch (method) {
      case "Network.responseReceived": {
        this.#upsert(key, {
          ...existing,
          view: { ...existing.view, ...responseFields(params.response, existing.view) },
        });
        return;
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const finishedAt = this.#finishedAt(existing, numberOrUndefined(params.timestamp));
        this.#upsert(key, {
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

  /**
   * Start a request, or its next hop. A redirect reuses the inspector's id and carries the
   * previous hop's response, so that hop is finished and the new one gets an id of its own.
   */
  #onRequestWillBeSent(cdpId: string, params: Record<string, any>): void {
    const request = params.request ?? {};
    let key = this.#keys.get(cdpId);
    const previous = key ? this.#requests.get(key) : undefined;
    const redirected = previous !== undefined && params.redirectResponse !== undefined;

    if (key && previous && redirected) {
      this.#upsert(key, {
        ...previous,
        view: {
          ...previous.view,
          ...responseFields(params.redirectResponse, previous.view),
          finishedAt: this.#finishedAt(previous, numberOrUndefined(params.timestamp)),
        },
      });
      const hop = (this.#hops.get(cdpId) ?? 0) + 1;
      this.#hops.set(cdpId, hop);
      key = `${this.#generation}.${cdpId}~${hop}`;
      this.#keys.set(cdpId, key);
    } else if (!key) {
      key = `${this.#generation}.${cdpId}`;
      this.#keys.set(cdpId, key);
    }

    const existing = redirected ? undefined : previous;
    const startedAt =
      typeof params.wallTime === "number" ? Math.round(params.wallTime * 1000) : this.#deps.now();
    const headers =
      request.headers && typeof request.headers === "object"
        ? redactHeaders(request.headers)
        : existing?.view.requestHeaders;
    const extra = this.#pendingExtraHeaders.get(cdpId);
    this.#pendingExtraHeaders.delete(cdpId);

    this.#upsert(key, {
      cdpId,
      generation: this.#generation,
      view: {
        ...existing?.view,
        id: key,
        method: String(request.method ?? "GET"),
        url: String(request.url ?? ""),
        startedAt: existing?.view.startedAt ?? startedAt,
        resourceType: typeof params.type === "string" ? params.type : existing?.view.resourceType,
        requestHeaders: extra ? { ...headers, ...extra } : headers,
        requestBody:
          typeof request.postData === "string" ? request.postData : existing?.view.requestBody,
      },
      startTimestamp: existing?.startTimestamp ?? numberOrUndefined(params.timestamp),
    });
  }

  #bufferExtraHeaders(cdpId: string, headers: Record<string, string>): void {
    if (
      !this.#pendingExtraHeaders.has(cdpId) &&
      this.#pendingExtraHeaders.size >= MAX_PENDING_EXTRA_HEADERS
    ) {
      const oldest = this.#pendingExtraHeaders.keys().next().value;
      if (oldest !== undefined) this.#pendingExtraHeaders.delete(oldest);
    }
    this.#pendingExtraHeaders.set(cdpId, { ...this.#pendingExtraHeaders.get(cdpId), ...headers });
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
    const evicted: string[] = [];
    if (!this.#requests.has(id) && this.#requests.size >= NETWORK_MAX_REQUESTS) {
      const oldest = this.#requests.keys().next().value;
      if (oldest !== undefined) {
        this.#requests.delete(oldest);
        evicted.push(oldest);
      }
    }
    this.#requests.set(id, request);
    // Dashboards drop what the server dropped, so a long-open panel stays as bounded as a new one.
    this.#broadcast(
      evicted.length > 0
        ? { type: "request", request: request.view, evicted }
        : { type: "request", request: request.view },
    );
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
    const tracked = this.#requests.get(id);
    if (!tracked || tracked.generation !== this.#generation || !this.#cdp) {
      this.#sendTo(socket, {
        type: "response-body",
        id,
        body: null,
        error: tracked
          ? "This request came from an earlier connection to the app, which no longer has its body."
          : "The Hub no longer keeps this request.",
      });
      return;
    }
    const reply = await this.#call("Network.getResponseBody", { requestId: tracked.cdpId });
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

/** The panel fields of a CDP `Response`, keeping what `current` has where the response is silent. */
function responseFields(
  response: Record<string, any> | undefined,
  current: NetworkRequest,
): Partial<NetworkRequest> {
  const value = response ?? {};
  return {
    status: numberOrUndefined(value.status),
    statusText: typeof value.statusText === "string" ? value.statusText : undefined,
    mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    responseHeaders:
      value.headers && typeof value.headers === "object"
        ? redactHeaders(value.headers)
        : current.responseHeaders,
  };
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
  if (!device) {
    socket.close(1008, "Expected ?platform=&id=&name=&version=");
    return;
  }
  let metroOrigin: string | null;
  try {
    metroOrigin = metroOriginFor(request.url);
  } catch (error) {
    if (!(error instanceof MetroUrlError)) throw error;
    // Say why and keep the socket open, so the dashboard shows the reason instead of reconnecting.
    const message: NetworkServerMessage = {
      type: "status",
      status: { state: "unavailable", message: error.message },
    };
    socket.send(JSON.stringify(message));
    return;
  }
  if (!metroOrigin) {
    socket.close(1008, "Could not read the request URL");
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
