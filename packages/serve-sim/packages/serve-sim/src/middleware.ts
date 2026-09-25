import { openSseStream } from "./sse-stream";
import { execFile, execSync } from "child_process";
import { readdirSync, readFileSync, existsSync, unlinkSync, watch, type FSWatcher } from "fs";
import { readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createServer as createNetServer } from "net";
import { createHash, randomBytes } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Socket } from "net";
// `ws` (kept external in the build) supplies a WebSocket *client* for the
// helper/devtools proxy. Node only exposes a global `WebSocket` on newer LTS
// lines, and `serve-sim/middleware` is embedded in third-party dev servers, so
// importing the dependency keeps the proxy working regardless of runtime.
import { WebSocket } from "ws";
import { createAxStreamerCache } from "./ax";
import { readCameraStatus } from "./camera-helper";
import { captureRuntime, rebootedWithCaptureSince, startCaptureForDevice, type CaptureRuntime } from "./capture";
import { createMetricsSamplerCache, MetricsSampler, type MetricsSamplerCache } from "./metrics-sampler";
import { foregroundTracker, type ForegroundApp, type ForegroundTrackerCache } from "./foreground-tracker";
import { corsAllowOriginHeaders, frameAncestorsPolicy } from "./middleware-utils";
import {
  closeDeviceSession,
  getDeviceSession,
  peekDeviceSession,
  type HidSocket,
} from "./device-session";
import {
  acceptedTokenSubprotocol,
  assertCaptureAccess,
  assertPreviewAccess,
  assertUpgradeAccess,
  upgradeAuthHeaders,
} from "./session-auth";
import {
  eventLogEventForAction,
  readEventLog,
  recordEventLogEvent,
  subscribeEventLog,
} from "./event-log";
import { inProcessServeSimState, stateDir, writeServeSimState, type ServeSimDeviceState, type StreamSettings } from "./state";
import { debugMw } from "./debug";
import {
  resolveDevicePlaceholderAsset,
  resolveDeviceKitChrome,
  serveDeviceKitChromeAsset,
  serveDevicePlaceholderAsset,
  type DeviceKitChromeDescriptor,
} from "./devicekit-chrome";
import { serveDeviceKitModelAsset } from "./devicekit-model";
import { validatePanelRoute } from "./panel-route";
import { createExecWebSocketHandler, type UiRequestHandler } from "./exec-ws";
import { crashRuntime } from "./crash/runtime";
import { handleCrashesRequestAfter, handleCrashReportRequest } from "./crash/routes";
export { handleCrashesRequest, handleCrashReportRequest } from "./crash/routes";
import { booleanParam } from "./request-params";
import { logBufferCache, type LogBufferCache, type LogLine } from "./log-buffer";
import { claimHelperHidSocket, type UpgradeHandlerWebSocket } from "./middleware-utils";
import { UI_OPTIONS, getUiStatus, normalizeUiValue, setUiOption } from "./ui-settings";
import { type WebMiddleware } from "./runtime-utils";
import { connectToFetch, type ConnectMiddleware } from "./connect-to-fetch";

/** Captured traffic is decrypted credentials; `no-cache` would still let a cache keep a copy. */
const NO_STORE = { "Cache-Control": "no-store, private", Pragma: "no-cache" } as const;

type SimReq = IncomingMessage;
type SimRes = ServerResponse;
type SimNext = (err?: unknown) => Promise<void>;
export type SimMiddleware = WebMiddleware & {
  handleUpgrade(req: SimReq, socket: Socket, head: Buffer): void;
};

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
// Last logged result of a GET /api selection, used to suppress the
// once-every-poll duplicate debugMw lines (the UI polls /api every ~2s).
let lastApiLogKey: string | undefined;
const DEVTOOLS_FRONTEND_REV = "854a02be78c7ffea104cb523636efa991bef5c5b";
const INSPECT_WEBKIT_START_PORT = 9222;

type WebKitBridgeTarget = {
  id: string;
  title: string;
  url: string;
  type: string;
  appName?: string;
  bundleId?: string;
  /** udid of the simulator hosting the target, when known. */
  udid?: string;
  inUseByOtherInspector?: boolean;
};

export type WebKitBridge = {
  port: number;
  cdpUrl: string;
  listTargets(): Promise<WebKitBridgeTarget[]>;
  highlightTarget?(targetId: string, on: boolean): Promise<void>;
  releaseHighlight?(targetId?: string): void;
};

type InspectWebKitBridgeTarget = {
  targetId: string;
  title?: string;
  appName?: string;
  url?: string;
  type?: string;
  bundleId?: string;
  inUseByOtherInspector?: boolean;
  source?: { kind?: string; id?: string };
};

type CdpHttpListEntry = {
  id: string;
  title: string;
  url: string;
  type: string;
  description?: string;
};

type CdpHttpVersion = { Browser?: string };

type SimctlBootedList = {
  devices: Record<
    string,
    Array<{ udid: string; state: string; name: string; deviceTypeIdentifier?: string }>
  >;
};

type SimctlAllList = {
  devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
};

type ShutdownRequestBody = { udid?: string };
type StartRequestBody = { udid?: string };
type ReleaseRequestBody = { targetId?: string };
type HighlightRequestBody = { targetId?: string; on?: boolean };
/** Re-exported alias for the canonical device-state record in `./state`. */
export type ServeSimState = ServeSimDeviceState;

const axStreamerCache = createAxStreamerCache();
// One shared cpu/mem sampler per udid; every /metrics viewer subscribes. Stamp the device name
// (from the last booted-device snapshot) into the sampler's meta frame when we know it.
// Host network counters look idle under capture (loopback); proxy totals win via networkRateOverride.
const metricsSamplerCache = createMetricsSamplerCache(
  (udid) =>
    new MetricsSampler({
      udid,
      deviceName: bootedDeviceName(udid),
      networkRateOverride: () => captureRuntime.throughputFor(udid),
    }),
);

let inspectWebKitBridge: Promise<WebKitBridge> | null = null;

function eventLogLimit(rawUrl: string): number | undefined {
  const value = new URL(rawUrl, "http://x").searchParams.get("limit");
  if (!value) return undefined;
  const limit = Number(value);
  return Number.isFinite(limit) ? limit : undefined;
}

function eventLogSinceId(rawUrl: string): number | undefined {
  const value = new URL(rawUrl, "http://x").searchParams.get("since");
  if (!value) return undefined;
  const since = Number(value);
  return Number.isFinite(since) ? since : undefined;
}

function recordActionEvent(
  action: string,
  params: Record<string, unknown> | undefined,
  result: { exitCode?: number },
): void {
  try {
    const event = eventLogEventForAction(action, params, result);
    if (event) recordEventLogEvent(event);
  } catch {
    // Event-log recording is diagnostic; it must never break the action path.
  }
}

// Known bundle IDs that are always React Native shells (used as a fallback
// before the app-container path resolves, since simctl can lag after launch).
const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent",       // Expo Go (App Store)
  "dev.expo.Exponent",       // Expo Go dev builds
]);

const RN_MARKERS = [
  "Frameworks/React.framework",
  "Frameworks/hermes.framework",
  "Frameworks/Hermes.framework",
  "Frameworks/ExpoModulesCore.framework",
  "main.jsbundle",
];

function isSimulatorUdid(value: string): boolean {
  return /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
}

/** What to do with a persisted device state when reaping during a grid poll. */
type StaleStateAction = "keep" | "recycle-self" | "recycle-helper";

/**
 * Decide how to reap a state record whose backing simulator may have been shut
 * down. A booted device (or a non-simulator/unknown `booted` set) is kept.
 *
 * The critical distinction is `recycle-self` vs `recycle-helper`: in in-process
 * mode `inProcessServeSimState` records the *server's own* pid, so SIGTERMing it
 * (as we do for a separate stale helper) would kill the whole server — and
 * index.ts converts SIGTERM into `process.exit`. When the dead device is ours,
 * we stop just that device's capture session instead of signalling the pid.
 */
function classifyStaleState(
  state: { pid: number; device: string },
  booted: Set<string> | null,
  selfPid: number,
): StaleStateAction {
  if (booted && isSimulatorUdid(state.device) && !booted.has(state.device)) {
    return state.pid === selfPid ? "recycle-self" : "recycle-helper";
  }
  return "keep";
}

function detectReactNative(udid: string, bundleId: string): Promise<boolean> {
  if (RN_BUNDLE_IDS.has(bundleId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) return resolve(false);
        const appPath = stdout.trim();
        if (!appPath) return resolve(false);
        for (const marker of RN_MARKERS) {
          if (existsSync(join(appPath, marker))) return resolve(true);
        }
        resolve(false);
      });
  });
}

type InstalledApp = {
  CFBundleDisplayName?: string;
  CFBundleExecutable?: string;
  CFBundleIdentifier?: string;
  CFBundleName?: string;
};

function normalizeAppName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function matchInstalledAppByDisplayName(
  apps: Record<string, InstalledApp>,
  displayName: string,
): string | null {
  const wanted = normalizeAppName(displayName);
  if (!wanted) return null;

  for (const [bundleId, app] of Object.entries(apps)) {
    const names = [
      app.CFBundleDisplayName,
      app.CFBundleName,
      app.CFBundleExecutable,
    ].filter((value): value is string => typeof value === "string");
    if (names.some((name) => normalizeAppName(name) === wanted)) {
      return app.CFBundleIdentifier || bundleId;
    }
  }
  return null;
}

// Cache simctl's booted-device set briefly so per-request cost stays bounded.
// The middleware runs inside the user's dev server (Metro etc.) and
// The window has to outlast the logs drawer's poll interval.
const BOOTED_CACHE_TTL_MS = 5_000;
let bootedSnapshot: {
  at: number;
  booted: Set<string> | null;
  names: Map<string, string>;
  deviceTypes: Map<string, string>;
} = {
  at: 0,
  booted: null,
  names: new Map(),
  deviceTypes: new Map(),
};
async function getBootedUdids(): Promise<Set<string> | null> {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < BOOTED_CACHE_TTL_MS) {
    return bootedSnapshot.booted;
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        "xcrun",
        ["simctl", "list", "devices", "booted", "-j"],
        { encoding: "utf-8", timeout: 3_000 },
        (err, stdout) => {
          if (err) {
            reject(err);
          } else {
            resolve(stdout);
          }
        },
      );
    });
    const data = JSON.parse(stdout) as SimctlBootedList;
    const booted = new Set<string>();
    const names = new Map<string, string>();
    const deviceTypes = new Map<string, string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") {
          // simctl's JSON is uppercase; canonicalize so Map/Set lookups stay case-insensitive.
          const udid = device.udid.toUpperCase();
          booted.add(udid);
          names.set(udid, device.name);
          if (device.deviceTypeIdentifier) deviceTypes.set(udid, device.deviceTypeIdentifier);
        }
      }
    }
    bootedSnapshot = { at: now, booted, names, deviceTypes };
    return booted;
  } catch {
    return null;
  }
}

/** Look up a display name in a simctl udid→name map. Keys are stored uppercase. */
export function deviceNameFromBootedNames(
  names: Map<string, string>,
  udid: string,
): string | undefined {
  return names.get(udid.toUpperCase());
}

// Display name for a booted udid, from the last simctl snapshot (refreshed on grid polls).
// Undefined until the first snapshot lands or if the device isn't booted.
function bootedDeviceName(udid: string): string | undefined {
  return deviceNameFromBootedNames(bootedSnapshot.names, udid);
}

function bootedDeviceChrome(udid: string): DeviceKitChromeDescriptor | null {
  const name = bootedDeviceName(udid);
  if (!name) return null;
  return resolveDeviceKitChrome({
    name,
    deviceTypeIdentifier: bootedSnapshot.deviceTypes.get(udid.toUpperCase()),
  });
}

// The device the user most recently opened in Simulator.app, regardless of
// which tool launched it. Simulator.app persists this as CurrentDeviceUDID, so
// it's the best signal for "the device this user actually cares about" — we
// surface it near the top of the grid the way Xcode's Devices window does.
let preferredSnapshot: { at: number; udid: string | null } = { at: 0, udid: null };
function getPreferredDeviceUdid(): string | null {
  const now = Date.now();
  if (now - preferredSnapshot.at < 1500) return preferredSnapshot.udid;
  let udid: string | null = null;
  try {
    udid =
      execSync("defaults read com.apple.iphonesimulator CurrentDeviceUDID", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim() || null;
  } catch {
    udid = null;
  }
  preferredSnapshot = { at: now, udid };
  return udid;
}

export async function readServeSimStates(): Promise<ServeSimState[]> {
  let files: string[];
  try {
    files = readdirSync(stateDir()).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = await getBootedUdids();
  const bootedAt = bootedSnapshot.at;
  void retryPendingCaptureCleanup();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(stateDir(), f);
    try {
      const state: ServeSimState = JSON.parse(readFileSync(path, "utf-8"));
      try {
        process.kill(state.pid, 0);
      } catch {
        debugMw("helper pid=%d gone, removing %s", state.pid, path);
        try { unlinkSync(path); } catch {}
        continue;
      }
      // Helper alive but its simulator was shut down — the MJPEG stream
      // would accept connections yet never produce frames, leaving the
      // preview stuck on "Connecting...". Recycle the stale state so the
      // caller can spawn a fresh helper bound to whatever is booted.
      const action = classifyStaleState(state, booted, process.pid);
      if (action !== "keep" && rebootedWithCaptureSince(state.device, bootedAt)) {
        states.push(state);
        continue;
      }
      if (action !== "keep") {
        if (action === "recycle-self") {
          // This device is streamed in-process by *us* (the close button just
          // shut its sim down). SIGTERMing state.pid would kill the whole
          // server; instead stop just this device's capture session.
          debugMw(
            "closing in-process session for shut-down device %s (own pid %d)",
            state.device,
            state.pid,
          );
          closeDeviceSession(state.device);
          void disableNetworkCaptureForStoppedDevice(state.device);
        } else {
          debugMw(
            "recycling stale helper pid=%d (device %s no longer booted)",
            state.pid,
            state.device,
          );
          try { process.kill(state.pid, "SIGTERM"); } catch {}
        }
        try { unlinkSync(path); } catch {}
        continue;
      }
      states.push(state);
    } catch {}
  }
  return states;
}

export function selectServeSimState(
  states: ServeSimState[],
  device?: string | null,
): ServeSimState | null {
  if (device) {
    return states.find((state) => state.device === device) ?? null;
  }
  return states[0] ?? null;
}

function queryDevice(rawUrl: string): string | null {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return null;
  return new URLSearchParams(rawUrl.slice(qIndex + 1)).get("device");
}

/**
 * Parse `/grid/api` pagination params. `limit` absent → return the whole list
 * (back-compat for embedded mounts that expect every device in one response).
 * The full DeviceKit `chrome` descriptor is only resolved for the returned
 * page, so a remote viewer over a tunnel fetches a small first page instead of
 * the whole simulator catalog (~150KB) up front.
 */
export function parseGridPaging(rawUrl: string): { limit: number | null; offset: number } {
  const qIndex = rawUrl.indexOf("?");
  if (qIndex === -1) return { limit: null, offset: 0 };
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  const rawLimit = params.get("limit");
  const rawOffset = params.get("offset");
  // Clamp to sane bounds; ignore non-numeric/negative input rather than erroring.
  const limit =
    rawLimit == null || !/^\d+$/.test(rawLimit)
      ? null
      : Math.min(Math.max(Number(rawLimit), 1), 1000);
  const offset =
    rawOffset == null || !/^\d+$/.test(rawOffset) ? 0 : Math.max(Number(rawOffset), 0);
  return { limit, offset };
}

function hostForRequest(req: SimReq): string | undefined {
  const host = req.headers?.host;
  if (host) return host;
  const port = req.socket.localPort;
  return port ? `localhost:${port}` : undefined;
}

function endpoint(base: string, path: string, device: string): string {
  const value = `${base}${path}`;
  return `${value}?device=${encodeURIComponent(device)}`;
}

function streamSettingsEndpointFrom(streamUrl: string): string {
  const url = new URL(streamUrl);
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1)}stream-settings`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Rewrite the helper URLs in a state for the requesting browser.
 *
 * When `proxy` is set (standalone `serve-sim`, which owns its server and wires
 * WebSocket upgrades), the URLs point at the preview's same-origin `/helper`
 * proxy so remote viewers only need the one preview port. When it's off — the
 * default for embedded `app.use(simMiddleware(...))` mounts, where the host's
 * server doesn't forward `upgrade` events to `handleUpgrade` — the helper's
 * loopback URLs are emitted directly (with `127.0.0.1` swapped for the request
 * hostname so LAN/tunnel viewers can still reach the separate helper port).
 */
export function rewriteStateForRequestHost(
  state: ServeSimState,
  hostHeader: string | undefined,
  base = "",
  protocol: "http" | "https" = "http",
  proxy = false,
): ServeSimState {
  if (!hostHeader) {
    return state;
  }
  if (!proxy) {
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return state;
    }
    // `URL.hostname` keeps brackets around IPv6 literals, so the IPv6 loopback
    // comparison is against the bracketed form rather than `::1`.
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return state;
    }
    const rewrite = (s: string) => s.replace("127.0.0.1", hostname);
    return {
      ...state,
      url: rewrite(state.url),
      streamUrl: rewrite(state.streamUrl),
      wsUrl: rewrite(state.wsUrl),
    };
  }
  const normalizedBase = base === "/" ? "" : base.replace(/\/+$/, "");
  const helperBase = `${normalizedBase}/helper`;
  const devicePath = `${helperBase}/${encodeURIComponent(state.device)}`;
  // Match the request's scheme so an HTTPS-served preview doesn't hand the
  // browser `http`/`ws` helper URLs (blocked as mixed content). Behind a proxy
  // the original scheme arrives via `x-forwarded-proto`.
  const origin = `${protocol}://${hostHeader}`;
  const wsOrigin = `${protocol === "https" ? "wss" : "ws"}://${hostHeader}`;
  return {
    ...state,
    url: `${origin}${devicePath}`,
    streamUrl: `${origin}${devicePath}/stream.mjpeg`,
    wsUrl: `${wsOrigin}${devicePath}/ws`,
  };
}

function helperProxyPrefix(base: string): string {
  return `${base === "/" ? "" : base}/helper`;
}

function devtoolsProxyPrefix(base: string): string {
  return `${base === "/" ? "" : base}/devtools`;
}

function devtoolsProxyTarget(rawUrl: string, prefix: string): { upstreamPath: string } | null {
  const parsed = new URL(rawUrl, "http://serve-sim.local");
  if (!parsed.pathname.startsWith(`${prefix}/page/`)) {
    return null;
  }
  const suffix = parsed.pathname.slice(prefix.length);
  return { upstreamPath: `/devtools${suffix}${parsed.search}` };
}

function helperProxyTarget(rawUrl: string, prefix: string): { device: string | null; upstreamPath: string } | null {
  const parsed = new URL(rawUrl, "http://serve-sim.local");
  if (parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  const rawSuffix = parsed.pathname.slice(prefix.length);
  const segments = rawSuffix.replace(/^\/+/, "").split("/").filter(Boolean);
  const directHelperEndpoints = new Set([
    "ax",
    "config",
    "foreground",
    "health",
    "panel",
    "stream.avcc",
    "stream.mjpeg",
    "webrtc",
    "ws",
  ]);
  let device = parsed.searchParams.get("device");
  let upstreamSegments = segments;
  if (segments[0] && !directHelperEndpoints.has(segments[0])) {
    device = decodeURIComponent(segments[0]);
    upstreamSegments = segments.slice(1);
  }
  const suffix = upstreamSegments.length > 0 ? `/${upstreamSegments.join("/")}` : "/";
  parsed.searchParams.delete("device");
  return { device, upstreamPath: `${suffix}${parsed.search}` };
}

const WS_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketFrame(opcode: number, payload: Buffer<ArrayBufferLike>): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

type ParsedWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
  consumed: number;
};

function parseWebSocketFrame(buffer: Buffer): ParsedWebSocketFrame | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame too large");
    }
    length = Number(bigLength);
    offset += 8;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i]! ^ mask[i % 4]!;
    }
  }
  return { opcode, payload, consumed: offset + length };
}

function sendBrowserFrame(socket: Socket, opcode: number, payload: Buffer<ArrayBufferLike> = Buffer.alloc(0)): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(websocketFrame(opcode, payload));
}

type PendingWebSocketFrame = {
  opcode: number;
  payload: Buffer<ArrayBufferLike>;
};

function webSocketBinary(payload: Buffer<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(payload.length);
  bytes.set(payload);
  return bytes;
}

/**
 * Complete the server side of a WebSocket upgrade by hand (the `ws` server's
 * handshake doesn't flush under Bun). Writes the 101 response and resumes the
 * socket on success; on a missing key writes 400 and returns false.
 */
function writeWebSocketAccept(req: SimReq, socket: Socket, execToken: string): boolean {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return false;
  }
  const accept = createHash("sha1").update(key + WS_ACCEPT_GUID).digest("base64");
  // A client that offered subprotocols fails the handshake unless one is named back.
  const subprotocol = acceptedTokenSubprotocol(req.headers, execToken);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (subprotocol ? `Sec-WebSocket-Protocol: ${subprotocol}\r\n` : "") +
    "\r\n",
  );
  socket.resume();
  return true;
}

function bridgeWebSocketFrames(
  req: SimReq,
  socket: Socket,
  head: Buffer,
  upstreamUrl: string,
  execToken: string,
): void {
  if (!writeWebSocketAccept(req, socket, execToken)) return;

  const upstream = new WebSocket(upstreamUrl);
  upstream.binaryType = "arraybuffer";
  let upstreamOpen = false;
  let closed = false;
  let pendingToUpstream: PendingWebSocketFrame[] = [];
  let buffered = Buffer.from(head);

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    try { upstream.close(); } catch {}
    try { socket.end(websocketFrame(0x8, Buffer.alloc(0))); } catch {}
    try { socket.destroy(); } catch {}
  };

  const sendToUpstream = (frame: PendingWebSocketFrame) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
      return;
    }
    pendingToUpstream.push({ opcode: frame.opcode, payload: Buffer.from(frame.payload) });
  };

  const drainFrames = () => {
    try {
      while (buffered.length > 0) {
        const frame = parseWebSocketFrame(buffered);
        if (!frame) break;
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          sendBrowserFrame(socket, 0x8, frame.payload);
          closeBoth();
          return;
        }
        if (frame.opcode === 0x9) {
          sendBrowserFrame(socket, 0xA, frame.payload);
          continue;
        }
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          sendToUpstream({ opcode: frame.opcode, payload: frame.payload });
        }
      }
    } catch {
      closeBoth();
    }
  };

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const frame of pendingToUpstream) {
      upstream.send(frame.opcode === 0x1 ? frame.payload.toString("utf8") : webSocketBinary(frame.payload));
    }
    pendingToUpstream = [];
  };
  upstream.onmessage = (event) => {
    const data = event.data;
    const payload = typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(data as ArrayBuffer);
    sendBrowserFrame(socket, typeof data === "string" ? 0x1 : 0x2, payload);
  };
  upstream.onerror = closeBoth;
  upstream.onclose = closeBoth;

  socket.on("data", (chunk) => {
    if (typeof chunk === "string") chunk = Buffer.from(chunk);
    buffered = Buffer.concat([buffered, chunk]);
    drainFrames();
  });
  socket.on("error", closeBoth);
  socket.on("close", closeBoth);
  drainFrames();
}

/** Read camera-helper state without opening the simulator capture session. */
async function handleCameraStatus(req: SimReq, res: SimRes, device: string): Promise<void> {
  if (!isSimulatorUdid(device)) {
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "invalid_device" }));
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, {
      Allow: "GET",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }
  try {
    const status = await readCameraStatus(device);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(status));
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({
      udid: device,
      alive: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Serve a device-scoped helper endpoint in-process. Camera status reads the
 * camera helper's persisted state; stream and input routes lazily create a
 * DeviceSession. Returns false for paths this function doesn't own or when a
 * session-backed route cannot open the requested simulator.
 */
function serveHelperInProcess(
  req: SimReq,
  res: SimRes,
  device: string | null,
  upstreamPath: string,
  initialStreamSettings?: StreamSettings,
): boolean {
  if (!device) return false;
  const endpoint = upstreamPath.split("?")[0];
  const panelRoute = /^\/panel\/([^/]+)\/(.+)$/.exec(endpoint ?? "");
  if (panelRoute) {
    const route = validatePanelRoute(panelRoute[1]!, panelRoute[2]!, req.method);
    if ("error" in route) {
      res.writeHead(route.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: route.error }));
      return true;
    }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
  }
  if (endpoint === "/camera/status") {
    void handleCameraStatus(req, res, device);
    return true;
  }
  // Polled once a second by the panel and the recorder, so creating a session here would start a
  // capture nothing asked for, and re-create one every tick after the simulator is shut down.
  if (endpoint === "/webrtc/stats") {
    const live = peekDeviceSession(device);
    if (!live) return false;
    void live.handleWebRTCStats(req, res);
    return true;
  }
  let session;
  if (panelRoute && (panelRoute[2] === "webrtc/stats" || panelRoute[2] === "webrtc/close")) {
    const live = peekDeviceSession(device);
    if (!live) {
      res.writeHead(panelRoute[2] === "webrtc/close" ? 204 : 404);
      res.end();
      return true;
    }
    void live.handlePanel(req, res, Number(panelRoute[1]), panelRoute[2]!);
    return true;
  }
  try {
    session = getDeviceSession(device, initialStreamSettings);
  } catch {
    return false; // not booted / capture unavailable → 404
  }
  if (panelRoute) {
    void session.handlePanel(req, res, Number(panelRoute[1]), panelRoute[2]!);
    return true;
  }
  switch (endpoint) {
    case "/stream.mjpeg": session.handleMjpeg(req, res); return true;
    case "/stream.avcc": session.handleAvcc(req, res); return true;
    case "/stream-settings": void session.handleStreamSettings(req, res); return true;
    case "/config": session.handleConfig(req, res); return true;
    case "/health": session.handleHealth(req, res); return true;
    case "/webrtc/offer": void session.handleWebRTCOffer(req, res); return true;
    case "/webrtc/close": void session.handleWebRTCClose(req, res); return true;
    case "/ax": session.handleAx(req, res); return true;
    case "/foreground": session.handleForeground(req, res); return true;
    default: return false;
  }
}

/**
 * Boot a simulator (if needed) and record its in-process state so the grid /
 * preview enumerate it. Replaces spawning `serve-sim --detach <udid>`; the
 * preview server itself serves the device's /helper routes in-process. Resolves
 * to an error string on boot failure, or null on success.
 */
/** Carries the session token like the primary device's does, or its readers start failing. */
export function gridDeviceState(
  udid: string,
  port: number,
  base: string,
  streamSettings?: StreamSettings,
  sessionToken?: string,
): ServeSimDeviceState {
  const state = inProcessServeSimState(udid, port, base, "127.0.0.1", streamSettings);
  return sessionToken ? { ...state, token: sessionToken } : state;
}

export async function startDeviceInProcess(
  udid: string,
  port: number,
  base: string,
  streamSettings?: StreamSettings,
  /** Session token, when the server runs gated. */
  sessionToken?: string,
  onBoot?: () => Promise<void>,
): Promise<string | null> {
  // `simctl boot` errors when already booted — ignore and let bootstatus confirm.
  await new Promise<void>((resolve) =>
    execFile("xcrun", ["simctl", "boot", udid], () => resolve()),
  );
  const ready = await new Promise<boolean>((resolve) => {
    execFile("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000 }, (err) => resolve(!err));
  });
  if (!ready) {
    // bootstatus can exit non-zero even when the device is actually ready;
    // confirm against the real state before reporting failure.
    const booted = await new Promise<boolean>((resolve) => {
      execFile("xcrun", ["simctl", "list", "devices", "-j"], (err, stdout) => {
        if (err) return resolve(false);
        try {
          const data = JSON.parse(stdout) as { devices: Record<string, Array<{ udid: string; state: string }>> };
          resolve(Object.values(data.devices).flat().some((d) => d.udid === udid && d.state === "Booted"));
        } catch {
          resolve(false);
        }
      });
    });
    if (!booted) return `Device ${udid} failed to reach booted state`;
  }
  await onBoot?.();
  writeServeSimState(gridDeviceState(udid, port, base, streamSettings, sessionToken));
  return null;
}

export async function enableNetworkCaptureForStartedDevice(
  udid: string,
  enabled: boolean,
  deps: {
    enable?: (udid: string) => Promise<{ proxyAddress: string | null }>;
    log?: (message: string) => void;
    error?: (message: string) => void;
  } = {},
): Promise<void> {
  if (!captureRuntime.shouldCaptureDevice(udid, enabled)) return;
  const enable =
    deps.enable ??
    (async (id) => captureRuntime.enableForDevice(id));
  const log = deps.log ?? ((message) => console.log(message));
  const error = deps.error ?? ((message) => console.error(message));
  await startCaptureForDevice(udid, {
    enable,
    onStarted: (meta) =>
      log(
        `Network capture on for ${udid} via ${meta.proxyAddress}. HTTP(S) from this device is ` +
          "recorded from now on. Apps already running may keep existing sessions; HTTPS is decrypted, " +
          "so certificate-pinned apps will refuse to connect.",
      ),
    onFailed: (reason) => error(`Network capture could not start for ${udid}. ${reason}`),
  });
}

// Capture sessions whose cleanup failed after their device stopped, keyed by device. The value is
// the session's store, which names that session: a retry only touches it while it is still there,
// so a newer session on the same device (after a reboot with capture on) is never disabled.
const pendingCaptureCleanup = new Map<string, unknown>();
// Polls come often; one retry per device at a time keeps a failing cleanup from piling up.
const retryingCaptureCleanup = new Set<string>();

interface CaptureCleanupDeps {
  disable?: (udid: string) => Promise<void>;
  /** The device's current capture session, or null. */
  session?: (udid: string) => unknown;
}

export async function disableNetworkCaptureForStoppedDevice(
  udid: string,
  deps: CaptureCleanupDeps = {},
): Promise<boolean> {
  const disable =
    deps.disable ??
    (async (id) => {
      await captureRuntime.disableForDevice(id);
    });
  const sessionOf = deps.session ?? ((id: string) => captureRuntime.storeFor(id));
  const session = sessionOf(udid);
  try {
    await disable(udid);
    pendingCaptureCleanup.delete(udid);
    return true;
  } catch (err) {
    if (session) pendingCaptureCleanup.set(udid, session);
    console.warn(
      `Network capture: disable for ${udid} failed; it is retried on the next device poll:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Retry failed cleanups until the session that failed is gone; a newer session is left alone. */
export async function retryPendingCaptureCleanup(deps: CaptureCleanupDeps = {}): Promise<void> {
  const sessionOf = deps.session ?? ((id: string) => captureRuntime.storeFor(id));
  await Promise.all(
    [...pendingCaptureCleanup].map(async ([udid, session]) => {
      if (sessionOf(udid) !== session) {
        pendingCaptureCleanup.delete(udid);
        return;
      }
      if (retryingCaptureCleanup.has(udid)) return;
      retryingCaptureCleanup.add(udid);
      try {
        await disableNetworkCaptureForStoppedDevice(udid, deps);
      } finally {
        retryingCaptureCleanup.delete(udid);
      }
    }),
  );
}

/**
 * Adapt a raw upgraded socket into the minimal HidSocket the DeviceSession
 * needs. We do the WebSocket framing by hand (same helpers as the DevTools
 * bridge) rather than via `ws`'s server, whose handshake doesn't flush under
 * Bun — and the production CLI is a bun-compiled binary.
 */
function rawHidSocket(socket: Socket, head: Buffer): HidSocket {
  const messageCbs: Array<(d: Buffer) => void> = [];
  const closeCbs: Array<() => void> = [];
  let buffered = Buffer.from(head);
  let closed = false;

  const fireClose = () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  const shutdown = (code?: number, reason = "") => {
    fireClose();
    const payload = code === undefined ? Buffer.alloc(0) : Buffer.alloc(2 + Buffer.byteLength(reason));
    if (code !== undefined) {
      payload.writeUInt16BE(code);
      payload.write(reason, 2);
    }
    try {
      socket.end(websocketFrame(0x8, payload));
      socket.destroySoon();
    } catch { socket.destroy(); }
  };

  const drain = () => {
    if (closed) return;
    for (;;) {
      let frame: ParsedWebSocketFrame | null;
      try {
        frame = parseWebSocketFrame(buffered);
      } catch {
        shutdown();
        return;
      }
      if (!frame) return;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) return shutdown();       // close
      if (frame.opcode === 0x9) { sendBrowserFrame(socket, 0xa, frame.payload); continue; } // ping → pong
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        for (const cb of messageCbs) cb(frame.payload);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); drain(); });
  socket.on("close", fireClose);
  socket.on("error", fireClose);
  if (head.length) drain();

  return {
    send(data: Buffer) { sendBrowserFrame(socket, 0x2, data); },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") messageCbs.push(cb);
      else closeCbs.push(cb as () => void);
    },
    close: shutdown,
  };
}

/** Upgrade an in-process HID `/ws` socket onto a DeviceSession. Returns false when no session can serve it. */
function attachHidInProcess(
  req: SimReq,
  socket: Socket,
  execToken: string,
  head: Buffer,
  device: string | null,
  initialStreamSettings?: StreamSettings,
): boolean {
  if (!device) return false;
  let session;
  try {
    session = getDeviceSession(device, initialStreamSettings);
  } catch {
    return false;
  }
  if (!writeWebSocketAccept(req, socket, execToken)) return true; // bad request handled
  session.attachHidSocket(rawHidSocket(socket, head));
  return true;
}

// Keep the exec bridge allowlist aligned with preview SSE endpoints.
export function sseStreamPaths(base: string): string[] {
  return [
    `${base}/api/events`,
    `${base}/api/event-log/events`,
    `${base}/grid/api/status/events`,
    `${base}/appstate`,
    `${base}/logs`,
    `${base}/crashes`,
    `${base}/metrics`,
    `${base}/network-capture`,
    `${base}/ax`,
  ];
}

export function previewConfigForState(
  state: ServeSimState,
  base: string,
  execToken: string,
  streamSettingsOrCodec?: StreamSettings | string,
  proxyHelpers = false,
  requirePreviewToken = false,
  shareUrl?: string,
): ServeSimState & {
  basePath: string;
  logsEndpoint: string;
  crashesEndpoint: string;
  appStateEndpoint: string;
  eventLogEndpoint: string;
  eventLogEventsEndpoint: string;
  metricsEndpoint: string;
  captureEndpoint: string;
  axEndpoint: string;
  cameraStatusEndpoint: string;
  devtoolsEndpoint: string;
  streamSettingsEndpoint: string;
  gridApiEndpoint: string;
  gridCatalogEndpoint: string;
  gridStatusEndpoint: string;
  gridStatusEventsEndpoint: string;
  gridStartEndpoint: string;
  gridShutdownEndpoint: string;
  gridMemoryEndpoint: string;
  previewEndpoint: string;
  execToken: string;
  /** Inlined so the first paint has the bezel instead of reflowing into it. */
  chrome: DeviceKitChromeDescriptor | null;
  /** @deprecated Use streamSettings. */
  codec?: string;
  streamSettings?: StreamSettings;
  proxyHelpers?: boolean;
  requireToken?: boolean;
  shareUrl?: string;
} {
  const gridApiBase = (base === "" ? "" : base) + "/grid/api";
  const legacyCodec = typeof streamSettingsOrCodec === "string" ? streamSettingsOrCodec : undefined;
  const streamSettings = typeof streamSettingsOrCodec === "object"
    ? streamSettingsOrCodec
    : httpStreamSettingsFromLegacyCodec(legacyCodec);
  // Every serve-sim's state file is readable here and ?device= is caller-supplied, so neither the
  // token nor the TURN credentials may ride along: that hands one instance's secrets to another.
  const { token: _sessionToken, streamSettings: _foreignStreamSettings, ...publicState } = state;
  return {
    ...publicState,
    basePath: base,
    logsEndpoint: endpoint(base, "/logs", state.device),
    crashesEndpoint: endpoint(base, "/crashes", state.device),
    appStateEndpoint: endpoint(base, "/appstate", state.device),
    eventLogEndpoint: endpoint(base, "/api/event-log", state.device),
    eventLogEventsEndpoint: endpoint(base, "/api/event-log/events", state.device),
    metricsEndpoint: endpoint(base, "/metrics", state.device),
    captureEndpoint: endpoint(base, "/network-capture", state.device),
    axEndpoint: endpoint(base, "/ax", state.device),
    cameraStatusEndpoint: `${base === "/" ? "" : base}/helper/${encodeURIComponent(state.device)}/camera/status`,
    devtoolsEndpoint: endpoint(base, "/devtools", state.device),
    streamSettingsEndpoint: streamSettingsEndpointFrom(state.streamUrl),
    gridApiEndpoint: gridApiBase,
    gridCatalogEndpoint: gridApiBase + "/catalog",
    gridStatusEndpoint: gridApiBase + "/status",
    gridStatusEventsEndpoint: gridApiBase + "/status/events",
    gridStartEndpoint: gridApiBase + "/start",
    gridShutdownEndpoint: gridApiBase + "/shutdown",
    gridMemoryEndpoint: gridApiBase + "/memory",
    previewEndpoint: base === "" ? "/" : base,
    execToken,
    chrome: bootedDeviceChrome(state.device),
    ...(legacyCodec ? { codec: legacyCodec } : {}),
    ...(streamSettings ? { streamSettings } : {}),
    ...(proxyHelpers ? { proxyHelpers: true } : {}),
    ...(requirePreviewToken ? { requireToken: true } : {}),
    ...(shareUrl ? { shareUrl } : {}),
  };
}

async function isLocalPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function existingInspectWebKitBridge(port: number): Promise<WebKitBridge | null> {
  const cdpUrl = `http://127.0.0.1:${port}`;
  try {
    const versionRes = await fetch(`${cdpUrl}/json/version`);
    if (!versionRes.ok) return null;
    const version = await versionRes.json() as CdpHttpVersion;
    if (version.Browser !== "Safari/inspect-webkit") return null;
    return {
      port,
      cdpUrl,
      async listTargets() {
        // Hitting the bridge over HTTP loses the rich fields available to
        // an in-process consumer (appName, inUseByOtherInspector). The id
        // shape `sim:<udid>:<appId>:<pageId>` and the description string
        // `<deviceLabel> (<bundleId>)` are all we have here.
        const listRes = await fetch(`${cdpUrl}/json/list`);
        const targets = await listRes.json() as CdpHttpListEntry[];
        return targets
          .filter((target) => target.id.startsWith("sim:"))
          .map((target) => {
            const idParts = target.id.split(":");
            const udid = idParts[1];
            const bundleId = target.description?.match(/\(([^)]+)\)/)?.[1];
            return {
              id: target.id,
              title: target.title || target.url || "Untitled",
              url: /^https?:/i.test(target.url) ? target.url : "about:blank",
              type: target.type || "page",
              udid,
              bundleId,
            };
          });
      },
    };
  } catch {
    return null;
  }
}

async function ensureInspectWebKitBridge(): Promise<WebKitBridge> {
  if (inspectWebKitBridge) {
    try {
      // Probe so a dead bridge gets retired instead of poisoning every call.
      await (await inspectWebKitBridge).listTargets();
      return inspectWebKitBridge;
    } catch {
      inspectWebKitBridge = null;
    }
  }
  inspectWebKitBridge = (async () => {
    const { startCdpServer } = await import("inspect-webkit");
    for (let port = INSPECT_WEBKIT_START_PORT; port < INSPECT_WEBKIT_START_PORT + 50; port++) {
      if (!(await isLocalPortFree(port))) {
        const existing = await existingInspectWebKitBridge(port);
        if (existing) return existing;
        continue;
      }
      try {
        // Bind explicitly to IPv4 127.0.0.1 so the preview's DevTools
        // websocket proxy has a stable loopback upstream. `localhost` resolves
        // to ::1 first on some setups, which would leave the bridge unreachable.
        const server = await startCdpServer({ host: "127.0.0.1", port }) as Awaited<ReturnType<typeof startCdpServer>> & {
          highlightTarget?(targetId: string, on: boolean): Promise<void>;
          releaseHighlight?(targetId?: string): void;
        };
        return {
          port,
          cdpUrl: `http://127.0.0.1:${port}`,
          async listTargets() {
            return (server.getTargets() as InspectWebKitBridgeTarget[])
              .filter((target) => target.source?.kind === "simulator")
              .map((target) => {
                const url = target.url ?? "";
                return {
                  id: target.targetId,
                  title: target.title || target.appName || url || "Untitled",
                  url: /^https?:/i.test(url) ? url : "about:blank",
                  type: target.type || "page",
                  appName: target.appName,
                  bundleId: target.bundleId,
                  udid: target.source?.id,
                  inUseByOtherInspector: !!target.inUseByOtherInspector,
                };
              });
          },
          highlightTarget: server.highlightTarget?.bind(server),
          releaseHighlight: server.releaseHighlight?.bind(server),
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
          const existing = await existingInspectWebKitBridge(port);
          if (existing) return existing;
          continue;
        }
        throw err;
      }
    }
    throw new Error(`No available inspect-webkit port found in ${INSPECT_WEBKIT_START_PORT}-${INSPECT_WEBKIT_START_PORT + 49}`);
  })().catch((err) => {
    inspectWebKitBridge = null;
    throw err;
  });
  return inspectWebKitBridge;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function forwardedProtoForRequest(req: SimReq): string | undefined {
  return firstHeaderValue(req.headers["x-forwarded-proto"])
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
}

function websocketProtocolForRequest(req: SimReq): "ws" | "wss" {
  return forwardedProtoForRequest(req) === "https" ? "wss" : "ws";
}

function httpProtocolForRequest(req: SimReq): "http" | "https" {
  return forwardedProtoForRequest(req) === "https" ? "https" : "http";
}

function devtoolsFrontendUrl(
  frontendBase: string,
  wsParamName: "ws" | "wss",
  wsTargetBase: string,
  targetId: string,
): string {
  const url = new URL(`${frontendBase}/inspector.html`, "http://serve-sim.local");
  url.searchParams.set(wsParamName, `${wsTargetBase}/page/${encodeURIComponent(targetId)}`);
  return `${url.pathname}${url.search}`;
}

let _html: string | null = null;
/**
 * Best-effort absolute path to the running serve-sim entry script. Used so
 * the in-page Camera tool can `node <path> camera ...` regardless of PATH.
 * Falls back to the literal `serve-sim` if we can't determine a usable path.
 */
function serveSimBinPath(): string {
  try {
    const argv = process.argv;
    if (argv[1] && existsSync(argv[1])) return argv[1];
  } catch {}
  return "serve-sim";
}

function loadHtml(): string {
  if (!_html) {
    _html = Buffer.from(__PREVIEW_HTML_B64__, "base64").toString("utf-8");
  }
  return _html;
}

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
  runtime: string;
}

type GridHelperStatus = Pick<ServeSimState, "port" | "url" | "streamUrl" | "wsUrl">;

type GridCatalogDevice = {
  device: string;
  name: string;
  runtime: string;
  chrome: ReturnType<typeof resolveDeviceKitChrome>;
  placeholderAsset: ReturnType<typeof resolveDevicePlaceholderAsset>;
};

type GridDeviceStatus = {
  device: string;
  state: string;
  helper: GridHelperStatus | null;
};

// DeviceKit lookups are static for a simulator profile. Keep their descriptors
// in-process so catalog page refreshes do not repeatedly rebuild the large
// objects before JSON serialization.
const gridCatalogDeviceCache = new Map<string, { signature: string; device: GridCatalogDevice }>();

function catalogDeviceForSimulator(device: SimctlDevice): GridCatalogDevice {
  const signature = [
    device.name,
    device.runtime,
    device.deviceTypeIdentifier ?? "",
  ].join("\0");
  const cached = gridCatalogDeviceCache.get(device.udid);
  if (cached?.signature === signature) return cached.device;
  const catalogDevice: GridCatalogDevice = {
    device: device.udid,
    name: device.name,
    runtime: device.runtime,
    chrome: resolveDeviceKitChrome(device),
    placeholderAsset: resolveDevicePlaceholderAsset(device),
  };
  gridCatalogDeviceCache.set(device.udid, { signature, device: catalogDevice });
  return catalogDevice;
}

function sortGridSimulators(
  simulators: SimctlDevice[],
  helperByUdid: ReadonlyMap<string, ServeSimState>,
  selectedDevice: string | null,
): SimctlDevice[] {
  const preferredUdid = getPreferredDeviceUdid();
  const familyRank = (name: string): number => {
    if (/iphone/i.test(name)) return 0;
    if (/ipad/i.test(name)) return 1;
    if (/watch/i.test(name)) return 2;
    if (/(apple\s*tv|^tv\b)/i.test(name)) return 3;
    if (/vision|reality/i.test(name)) return 4;
    return 5;
  };
  const stateRank = (device: SimctlDevice): number => {
    if (helperByUdid.has(device.udid)) return 0;
    if (selectedDevice && device.udid === selectedDevice) return 1;
    if (device.state === "Booted") return 2;
    if (device.udid === preferredUdid) return 3;
    return 4;
  };
  const runtimeRank = (runtime: string): number => {
    const match = runtime.match(/-(\d+)-(\d+)/);
    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    return -(major * 1000 + minor);
  };
  return simulators.sort((a, b) =>
    stateRank(a) - stateRank(b) ||
    familyRank(a.name) - familyRank(b.name) ||
    a.name.localeCompare(b.name) ||
    runtimeRank(a.runtime) - runtimeRank(b.runtime),
  );
}

function listAllSimulators(): Promise<SimctlDevice[]> {
  return new Promise((resolve) => {
    execFile(
      "xcrun",
      ["simctl", "list", "devices", "-j"],
      { encoding: "utf-8", timeout: 3_000 },
      (err, stdout) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(stdout) as SimctlAllList;
          const out: SimctlDevice[] = [];
          for (const [runtime, devices] of Object.entries(data.devices)) {
            // Keep this to touch-capable simulator families that serve-sim can
            // frame and inject into. tvOS is intentionally left out for now.
            if (!/SimRuntime\.(iOS|watchOS|visionOS|xrOS)-/i.test(runtime)) continue;
            for (const d of devices) {
              if (d.isAvailable === false) continue;
              out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
            }
          }
          resolve(out);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function readGridSnapshot(selectedDevice: string | null): Promise<{
  simulators: SimctlDevice[];
  helperByUdid: Map<string, ServeSimState>;
}> {
  const [states, simulators] = await Promise.all([
    readServeSimStates(),
    listAllSimulators(),
  ]);
  const helperByUdid = new Map(states.map((state) => [state.device, state] as const));
  return {
    simulators: sortGridSimulators(simulators, helperByUdid, selectedDevice),
    helperByUdid,
  };
}

function gridStatusesForRequest(
  simulators: readonly SimctlDevice[],
  helperByUdid: ReadonlyMap<string, ServeSimState>,
  req: SimReq,
  base: string,
  proxyHelpers: boolean,
): GridDeviceStatus[] {
  return simulators.map((simulator) => {
    const helper = helperByUdid.get(simulator.udid);
    const remoteHelper = helper
      ? rewriteStateForRequestHost(
          helper,
          hostForRequest(req),
          base,
          httpProtocolForRequest(req),
          proxyHelpers,
        )
      : null;
    return {
      device: simulator.udid,
      state: simulator.state,
      helper: remoteHelper
        ? {
            port: remoteHelper.port,
            url: remoteHelper.url,
            streamUrl: remoteHelper.streamUrl,
            wsUrl: remoteHelper.wsUrl,
          }
        : null,
    };
  });
}

// Default per-simulator footprint when we have no running sim to measure
// from — a fresh booted iOS sim with one app launched typically sits in
// the 1.2–1.8 GB range. Used as a fallback only.
const DEFAULT_PER_SIM_BYTES = 1.5 * 1024 * 1024 * 1024;

interface MemoryReport {
  totalBytes: number;
  availableBytes: number;
  runningSimulators: number;
  perSimAvgBytes: number;
  perSimSource: "measured" | "estimated";
  estimatedAdditional: number;
}

function readSystemMemory(): { totalBytes: number; availableBytes: number } {
  try {
    const totalBytes = Number(
      execSync("sysctl -n hw.memsize", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim(),
    );
    const pageSize = Number(
      execSync("sysctl -n hw.pagesize", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1500,
      }).trim(),
    );
    const vmStat = execSync("vm_stat", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    const pages = (re: RegExp) => {
      const m = vmStat.match(re);
      return m ? Number(m[1]) : 0;
    };
    // "Available" mirrors what Activity Monitor treats as reclaimable: free
    // + inactive + speculative pages. Excludes wired and active.
    const availablePages =
      pages(/Pages free:\s+(\d+)/) +
      pages(/Pages inactive:\s+(\d+)/) +
      pages(/Pages speculative:\s+(\d+)/);
    return {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      availableBytes: availablePages * (Number.isFinite(pageSize) ? pageSize : 4096),
    };
  } catch {
    return { totalBytes: 0, availableBytes: 0 };
  }
}

// Sum RSS across every process whose argv path includes a CoreSimulator
// device directory. Groups by UDID so we get a real per-sim footprint that
// covers launchd_sim plus all child processes the runtime spawns.
function readSimulatorMemoryUsage(): { perUdid: Record<string, number>; totalBytes: number } {
  try {
    const output = execSync("ps -axo rss=,args=", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const perUdid: Record<string, number> = {};
    let totalBytes = 0;
    const re = /\/Devices\/([0-9A-F-]{36})\//i;
    for (const raw of output.split("\n")) {
      const line = raw.trimStart();
      if (!line) continue;
      const m = re.exec(line);
      if (!m) continue;
      const rssKb = Number(line.split(/\s+/, 1)[0]);
      if (!Number.isFinite(rssKb)) continue;
      const bytes = rssKb * 1024;
      const udid = m[1]!.toUpperCase();
      perUdid[udid] = (perUdid[udid] ?? 0) + bytes;
      totalBytes += bytes;
    }
    return { perUdid, totalBytes };
  } catch {
    return { perUdid: {}, totalBytes: 0 };
  }
}

function buildMemoryReport(): MemoryReport {
  const { totalBytes, availableBytes } = readSystemMemory();
  const usage = readSimulatorMemoryUsage();
  const runningSimulators = Object.keys(usage.perUdid).length;
  const measuredAvg = runningSimulators > 0
    ? usage.totalBytes / runningSimulators
    : 0;
  // Below ~256MB, the measurement is almost certainly catching a sim mid-boot
  // before its app processes are resident — fall back to the default so we
  // don't over-promise capacity.
  const perSimSource: MemoryReport["perSimSource"] =
    measuredAvg >= 256 * 1024 * 1024 ? "measured" : "estimated";
  const perSimAvgBytes =
    perSimSource === "measured" ? measuredAvg : DEFAULT_PER_SIM_BYTES;
  const estimatedAdditional = perSimAvgBytes > 0
    ? Math.max(0, Math.floor(availableBytes / perSimAvgBytes))
    : 0;
  return {
    totalBytes,
    availableBytes,
    runningSimulators,
    perSimAvgBytes,
    perSimSource,
    estimatedAdditional,
  };
}

export interface SimMiddlewareOptions {
  /** Base path to serve the preview at. Default: "/.sim" */
  basePath?: string;
  /** Pin this preview server to a specific simulator UDID. */
  device?: string;
  /**
   * Per-session bearer token gating the `/exec` shell-exec route.
   * Auto-generated if omitted. The token is injected into the preview HTML
   * so the in-page UI can call `/exec` same-origin; LAN attackers and
   * cross-origin pages cannot read it.
   */
  execToken?: string;
  /** Off by default: a loopback-only server is already reachable to whoever is on the machine. */
  requirePreviewToken?: boolean;
  /** Stream transport and codec settings for the preview. */
  streamSettings?: StreamSettings;
  /**
   * Origins allowed to read this preview cross-origin (e.g. a hosted dashboard).
   * Every route answers with the policy, so the token gate stays the thing that
   * decides access. Loopback is always allowed.
   */
  corsOrigins?: string[];
  frameAncestors?: string[];
  /** Public page the Share button copies instead of this preview's address. */
  shareUrl?: string;
  /** Enable capture for devices started through this middleware. */
  networkCapture?: boolean;
  /** @deprecated Use `streamSettings: { transport: "http", codec }`. */
  codec?: string;
  /**
   * Route the browser's helper stream/control and DevTools sockets through the
   * preview's same-origin `/helper` and `/devtools` proxies instead of the
   * helper's own loopback port — so a single exposed preview port is enough for
   * remote viewers. Requires the mounting server to forward WebSocket `upgrade`
   * events to {@link SimMiddleware.handleUpgrade}. Standalone `serve-sim`
   * enables this; plain `app.use(simMiddleware(...))` mounts leave it off (and
   * keep direct helper URLs) unless they also wire upgrades. See the README's
   * "Embed in your dev server" section.
   */
  proxyHelpers?: boolean;
  /** Test hook for supplying a fake inspect-webkit bridge. */
  inspectWebKitBridge?: () => Promise<WebKitBridge>;
}

function httpStreamSettingsFromLegacyCodec(codec: string | undefined): StreamSettings | undefined {
  if (codec === "auto" || codec === "h264" || codec === "mjpeg") {
    return { transport: "http", codec };
  }
  return undefined;
}


export function handleLogsRequest(
  req: SimReq,
  res: SimRes,
  state: ServeSimState | null,
  rawUrl: string,
  cache: LogBufferCache = logBufferCache
): void {
  if (!state) {
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "No serve-sim device" }));
    return;
  }

  const params = new URL(rawUrl, "http://127.0.0.1").searchParams;
  const scope = params.get("scope") ?? "all";
  if (scope !== "all" && scope !== "user-apps") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid log scope. Use all or user-apps." }));
    return;
  }
  res.setHeader("X-Serve-Sim-Log-Scope", scope);
  const intQuery = (name: string): number | undefined => {
    const raw = params.get(name)?.trim();
    const n = Number(raw);
    return raw && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const since = intQuery("since");
  const limit = intQuery("limit");
  const snapshot = params.get("snapshot");
  const wantsJson =
    snapshot === null
      ? (req.headers.accept ?? "").includes("application/json")
      : booleanParam(params, "snapshot");
  const wantsEnvelope = booleanParam(params, "envelope");
  const wantsFollow = booleanParam(params, "follow");

  if (wantsJson) {
    const buffer = wantsFollow ? cache.ensure(state.device, scope) : cache.peek(state.device, scope);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        device: state.device,
        latestSeq: buffer?.latestSeq ?? 0,
        oldestSeq: buffer?.oldestSeq ?? 0,
        bufferedBytes: buffer?.byteLength ?? 0,
        status: buffer?.status ?? "stopped",
        streamError: buffer?.error ?? null,
        lines: buffer?.read({ since, limit }) ?? [],
      })
    );
    return;
  }

  const buffer = cache.ensure(state.device, scope);
  const stream = openSseStream(req, res);

  const frame = (line: LogLine): string =>
    "data: " +
    (wantsEnvelope ? JSON.stringify({ seq: line.seq, at: line.at, raw: line.raw }) : line.raw) +
    "\n\n";

  let lastSent = since ?? 0;
  for (const line of buffer.read({ since, limit })) {
    if (!stream.isOpen()) break;
    stream.write(frame(line));
    lastSent = line.seq;
  }

  stream.onClose(
    buffer.subscribeBatch(
      (lines) => {
        let chunk = "";
        for (const line of lines) {
          if (line.seq <= lastSent) continue;
          lastSent = line.seq;
          chunk += frame(line);
        }
        if (chunk) stream.write(chunk);
      },
      () => {
        if (stream.isOpen()) res.end();
      }
    )
  );
}

async function selectDeviceAndReap(selectedDevice: string | null): Promise<ServeSimState | null> {
  const states = await readServeSimStates();
  const state = selectServeSimState(states, selectedDevice);
  const live = states.map((s) => s.device);
  crashRuntime.prune(live);
  logBufferCache.prune(live);
  return state;
}

/**
 * Connect-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/logs    — simctl logs, JSON snapshot or SSE (bearer token)
 *   GET  {basePath}/crashes — crash reports (bearer token)
 *   GET  {basePath}/ax      — SSE stream of normalized accessibility snapshots
 */
export function handleMetricsRequest(
  req: SimReq,
  res: SimRes,
  state: ServeSimState | null,
  samplerCache: MetricsSamplerCache = metricsSamplerCache,
  tracker: ForegroundTrackerCache = foregroundTracker,
): void {
  if (!state) {
    res.writeHead(404);
    res.end("No serve-sim device");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    ...NO_STORE,
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");
  // Keep the foreground tail warm for this stream's lifetime so the sampler can scope to the
  // current app even when no /appstate client is open.
  const foreground = tracker.subscribe(state.device);
  const { meta, unsubscribe } = samplerCache.subscribe(state.device, (sample) => {
    if (!res.writableEnded) res.write("data: " + JSON.stringify(sample) + "\n\n");
  });
  res.write("event: meta\ndata: " + JSON.stringify(meta) + "\n\n");
  // Heartbeat keeps an idle stream alive through buffering proxies.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(":\n\n");
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    foreground.unsubscribe();
  });
}

/** Capture SSE (read-only; does not start/stop capture). */
export function handleNetworkCaptureRequest(
  req: SimReq,
  res: SimRes,
  state: ServeSimState | null,
  runtime: CaptureRuntime = captureRuntime,
): void {
  if (!state) {
    res.writeHead(404, NO_STORE);
    res.end("No serve-sim device");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    ...NO_STORE,
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  const { meta, unsubscribe } = runtime.subscribe(state.device, (event) => {
    if (!res.writableEnded) res.write("data: " + JSON.stringify(event) + "\n\n");
  });

  res.write("data: " + JSON.stringify({ type: "meta", meta }) + "\n\n");
  for (const request of runtime.storeFor(state.device)?.list() ?? []) {
    if (res.writableEnded) break;
    // In-flight rows (null status) replay as started.
    const type = request.status == null && request.failure == null ? "started" : "finished";
    res.write("data: " + JSON.stringify({ type, request }) + "\n\n");
  }

  // Re-verify injection on open + heartbeat (restart drops boot injection).
  void runtime.refreshForDevice(state.device);
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(":\n\n");
    void runtime.refreshForDevice(state.device);
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

/** On-demand headers/bodies (omitted from the live stream). */
export function handleCaptureBodyRequest(
  req: SimReq,
  res: SimRes,
  state: ServeSimState | null,
  id: string,
  runtime: CaptureRuntime = captureRuntime,
): void {
  const store = state ? runtime.storeFor(state.device) : null;
  const body = store?.body(id) ?? null;
  if (!body) {
    res.writeHead(404, { "Content-Type": "application/json", ...NO_STORE });
    res.end(JSON.stringify({ error: "No captured body for that request" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", ...NO_STORE });
  res.end(JSON.stringify(body));
}

export function simMiddleware(options?: SimMiddlewareOptions): SimMiddleware {
  const streamSettings = options?.streamSettings ?? httpStreamSettingsFromLegacyCodec(options?.codec);
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");
  const helperPrefix = helperProxyPrefix(base);
  const devtoolsPrefix = devtoolsProxyPrefix(base);
  const proxyHelpers = options?.proxyHelpers ?? false;
  const getInspectWebKitBridge = options?.inspectWebKitBridge ?? ensureInspectWebKitBridge;
  // Per-process random token. Anyone who can read the preview HTML same-origin
  // can call /exec; cross-origin pages and LAN clients cannot, because they
  // can't read this value (it's only injected into the preview page's config).
  const execToken = options?.execToken ?? randomBytes(32).toString("base64url");
  const requirePreviewToken = options?.requirePreviewToken ?? false;
  const corsOrigins = [...(options?.corsOrigins ?? [])];
  const frameAncestors = options?.frameAncestors ?? [];
  const shareUrl = options?.shareUrl;
  // The proxied DevTools frontend sits behind the same cookie, so its document needs the policy too.
  const framePolicyHeaders: Record<string, string> = requirePreviewToken
    ? { "Content-Security-Policy": frameAncestorsPolicy(frameAncestors) }
    : {};
  const networkCapture = options?.networkCapture ?? false;

  crashRuntime.arm();

  // Simulator-settings requests run in-process (just the underlying simctl /
  // ax-tool spawn) instead of round-tripping a full `node <cli>` exec per
  // sidebar interaction.
  /** Validation messages are the caller's own input. A child's failure carries host paths. */
  const sanitizeUiFailure = async <T,>(work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (err) {
      console.error("serve-sim ui request failed:", err);
      throw new Error("the simulator rejected this UI request");
    }
  };

  const handleUiRequest: UiRequestHandler = async (payload) => {
    const p = (payload ?? {}) as { device?: string; option?: string; value?: string };
    // Must start alphanumeric and stay bounded: a leading "-" is parsed as a flag by simctl.
    if (typeof p.device !== "string" || !/^[0-9A-Za-z][0-9A-Za-z-]{0,255}$/.test(p.device)) {
      throw new Error("missing or invalid device udid");
    }
    if (p.option === undefined) {
      return { status: await sanitizeUiFailure(getUiStatus(p.device)) };
    }
    if (!Object.hasOwn(UI_OPTIONS, p.option)) throw new Error(`unknown option: ${p.option}`);
    const value = typeof p.value === "string" ? normalizeUiValue(p.option, p.value) : null;
    if (value === null) throw new Error(`invalid value for ${p.option}: ${p.value}`);
    await sanitizeUiFailure(setUiOption(p.device, p.option, value));
    try {
      recordEventLogEvent({
        device: p.device,
        source: "ui",
        kind: "ui-setting",
        action: p.option,
        status: "ok",
        summary: `UI ${p.option} ${value}`,
        details: { option: p.option, value },
      });
    } catch {
      // Event-log recording is diagnostic; it must not fail the UI request.
    }
    return { ok: true };
  };
/** Reachable without the session token: liveness probes cannot carry one. */
  const UNGATED_PATHS = ["/healthz", "/readyz"];
  // Capture routes always require authentication, including future subroutes.
  const ALWAYS_GATED_PREFIX = "/network-capture";

  const connectMiddleware = (async (req: SimReq, res: SimRes, next?: SimNext) => {
    const rawUrl: string = req.url ?? "";
    const qIndex = rawUrl.indexOf("?");
    const url = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const ownPath = url === base || url.startsWith(`${base}/`);
    // Whole-middleware, so a new route is reachable cross-origin without opting in.
    if (ownPath) {
      // Unconditional, including when the origin is refused: a cached copy carrying no policy
      // would otherwise be replayed to an origin that is allowed one.
      res.setHeader("Vary", "Origin");
      const corsHeaders = corsAllowOriginHeaders(req.headers.origin, corsOrigins);
      for (const [name, value] of Object.entries(corsHeaders)) res.setHeader(name, value);
    }
    // A preflight carries no cookie and no token, so it has to be answered before the gate.
    if (ownPath && req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const requestedDevice = queryDevice(rawUrl);
    const selectedDevice = requestedDevice ?? options?.device ?? null;
    const devtoolsFrontendBase = base === "/" ? "/devtools-frontend" : `${base}/devtools-frontend`;

    // Gated as a whole rather than per route, so a new route is protected by default.
    if (
      !UNGATED_PATHS.some((path) => url === base + path)
      && !assertPreviewAccess(req, res, execToken, {
        required: requirePreviewToken || url.startsWith(base + ALWAYS_GATED_PREFIX),
        basePath: base,
        htmlHeaders: framePolicyHeaders,
        allowQueryToken: !url.startsWith(base + ALWAYS_GATED_PREFIX),
      })
    ) {
      return;
    }

    if (url.startsWith(base + ALWAYS_GATED_PREFIX) && !assertCaptureAccess(req, res)) {
      return;
    }

    // Capture routes only read; a write-shaped request gets 405 rather than a read response.
    if (url.startsWith(base + ALWAYS_GATED_PREFIX)) {
      const method = (req.method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD", ...NO_STORE });
        res.end(JSON.stringify({ error: "Network capture routes accept GET and HEAD only." }));
        return;
      }
    }

    const helperTarget = helperProxyTarget(rawUrl, helperPrefix);
    if (helperTarget) {
      const device = helperTarget.device ?? selectedDevice;
      // The device's helper endpoints are served from an in-process
      // NativeCapture/NativeHid DeviceSession.
      if (serveHelperInProcess(req, res, device, helperTarget.upstreamPath, streamSettings)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No serve-sim device");
      return;
    }

    // Same-origin proxy for Chrome DevTools frontend assets. Loading the
    // appspot-hosted frontend directly works as a top-level tab, but is flaky
    // inside embedded browser iframes. Serving it from the preview origin keeps
    // the frontend's relative assets and CSP on the local page.
    if (url === devtoolsFrontendBase || url.startsWith(`${devtoolsFrontendBase}/`)) {
      const assetPath = url === devtoolsFrontendBase
        ? "inspector.html"
        : url.slice(devtoolsFrontendBase.length + 1);
      // Reject path-traversal segments before they reach the upstream URL.
      if (assetPath.split("/").some((seg) => seg === "..")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid asset path");
        return;
      }
      try {
        // The gate accepts `?token=` here, so forward the rest of the query but never that.
        const upstreamQuery = new URLSearchParams(qIndex === -1 ? "" : rawUrl.slice(qIndex + 1));
        upstreamQuery.delete("token");
        const upstreamSuffix = upstreamQuery.size === 0 ? "" : `?${upstreamQuery.toString()}`;
        const upstream = await fetch(
          `https://chrome-devtools-frontend.appspot.com/serve_rev/@${DEVTOOLS_FRONTEND_REV}/${assetPath}${upstreamSuffix}`,
        );
        const contentType = upstream.headers.get("content-type");
        const isDocument = contentType?.startsWith("text/html") ?? false;
        const headers: Record<string, string> = {
          // A cached copy would otherwise outlive the policy it was fetched under.
          "Cache-Control": isDocument ? "no-store" : "public, max-age=604800",
          ...(isDocument ? framePolicyHeaders : {}),
        };
        if (contentType) headers["Content-Type"] = contentType;
        res.writeHead(upstream.status, headers);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(err instanceof Error ? err.message : "Failed to load DevTools frontend");
      }
      return;
    }

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      let html = loadHtml();

      if (!state) {
        // Empty-state UI still polls /exec (boot/list helpers), so the page
        // needs the bearer token even before a helper attaches. Inject a
        // minimal config with just the basePath + token.
        const minimal = JSON.stringify({
          basePath: base,
          execToken,
          ...(shareUrl ? { shareUrl } : {}),
        });
        html = html.replace(
          "<!--__SIM_PREVIEW_CONFIG__-->",
          `<script>window.__SIM_PREVIEW__=${minimal}</script>`,
        );
      }

      if (state) {
        const remoteState = rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers);
        const config = JSON.stringify(
          previewConfigForState(remoteState, base, execToken, streamSettings, proxyHelpers, requirePreviewToken, shareUrl),
        );
        const configScript = `<script>window.__SIM_PREVIEW__=${config}</script>`;
        html = html.replace("<!--__SIM_PREVIEW_CONFIG__-->", configScript);
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...framePolicyHeaders,
      });
      res.end(html);
      return;
    }

    // Memory capacity estimate: how much room is left to boot more sims.
    if (url === base + "/grid/api/memory") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(buildMemoryReport()));
      return;
    }

    if (url === base + "/grid/api/devicekit-chrome") {
      serveDeviceKitChromeAsset(new URL(rawUrl || "/", "http://serve-sim.local"), res);
      return;
    }

    if (url === base + "/grid/api/device-placeholder-asset") {
      serveDevicePlaceholderAsset(new URL(rawUrl || "/", "http://serve-sim.local"), res);
      return;
    }

    if (url === base + "/grid/api/devicekit-model") {
      serveDeviceKitModelAsset(req, res);
      return;
    }

    // Static simulator metadata. The browser keeps this catalog in memory and
    // receives state/helper changes through the compact status feed below.
    if (url === base + "/grid/api/catalog") {
      const { simulators } = await readGridSnapshot(selectedDevice);
      const total = simulators.length;
      const { limit, offset } = parseGridPaging(rawUrl);
      const page = limit == null ? simulators : simulators.slice(offset, offset + limit);
      const body = JSON.stringify({
        devices: page.map(catalogDeviceForSimulator),
        total,
        offset: limit == null ? 0 : offset,
        limit: limit ?? total,
      });
      const etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, {
          "Cache-Control": "private, no-cache",
          ETag: etag,
        });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-cache",
        ETag: etag,
      });
      res.end(body);
      return;
    }

    const computeGridStatuses = async (): Promise<string> => {
      const { simulators, helperByUdid } = await readGridSnapshot(selectedDevice);
      return JSON.stringify({
        statuses: gridStatusesForRequest(
          simulators,
          helperByUdid,
          req,
          base,
          proxyHelpers,
        ),
      });
    };

    // Compact point-in-time form used only while waiting for a start action.
    if (url === base + "/grid/api/status") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(await computeGridStatuses());
      return;
    }

    // Change-only live grid state. It travels through the existing control
    // WebSocket, so it does not consume another long-lived browser connection.
    if (url === base + "/grid/api/status/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      let closed = false;
      let computing = false;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      let watcher: FSWatcher | null = null;
      let watcherRetry: ReturnType<typeof setTimeout> | null = null;
      let statusPoll: ReturnType<typeof setInterval> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      req.on("close", () => {
        closed = true;
        if (debounce) clearTimeout(debounce);
        if (watcherRetry) clearTimeout(watcherRetry);
        if (statusPoll) clearInterval(statusPoll);
        if (heartbeat) clearInterval(heartbeat);
        watcher?.close();
      });

      let lastSent = await computeGridStatuses();
      if (closed || res.writableEnded) return;
      res.write("data: " + lastSent + "\n\n");
      const sendIfChanged = async () => {
        if (closed || computing || res.writableEnded) return;
        computing = true;
        try {
          const next = await computeGridStatuses();
          if (next === lastSent || closed || res.writableEnded) return;
          lastSent = next;
          res.write("data: " + next + "\n\n");
        } finally {
          computing = false;
        }
      };

      // Filesystem notifications make helper start/stop immediate; the slow
      // poll catches simctl changes made by Xcode or Simulator.app.
      const onFsEvent = () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          void sendIfChanged();
        }, 150);
      };
      const ensureWatcher = () => {
        if (closed || res.writableEnded || watcher || watcherRetry) return;
        watcherRetry = setTimeout(() => {
          watcherRetry = null;
          if (closed || res.writableEnded || watcher) return;
          try {
            watcher = watch(stateDir(), onFsEvent);
            watcher.on("error", () => {
              watcher?.close();
              watcher = null;
              ensureWatcher();
            });
            void sendIfChanged();
          } catch {
            ensureWatcher();
          }
        }, 250);
      };
      ensureWatcher();
      statusPoll = setInterval(() => void sendIfChanged(), 3_000);
      heartbeat = setInterval(() => {
        if (closed || res.writableEnded) return;
        res.write(":\n\n");
        ensureWatcher();
      }, 15_000);
      return;
    }

    // Grid JSON: every supported simulator, annotated with running helper info if any.
    if (url === base + "/grid/api") {
      const { simulators, helperByUdid } = await readGridSnapshot(selectedDevice);
      const total = simulators.length;
      const { limit, offset } = parseGridPaging(rawUrl);
      const page = limit == null ? simulators : simulators.slice(offset, offset + limit);
      const statuses = gridStatusesForRequest(
        page,
        helperByUdid,
        req,
        base,
        proxyHelpers,
      );
      const devices = page.map((device, index) => ({
        ...catalogDeviceForSimulator(device),
        state: statuses[index]!.state,
        helper: statuses[index]!.helper,
      }));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      // `total` lets the client show "X of Y" and know when to stop paging;
      // older clients that read only `devices` are unaffected.
      res.end(JSON.stringify({ devices, total, offset: limit == null ? 0 : offset, limit: limit ?? total }));
      return;
    }

    // Shutdown a booted simulator. Any running helper for the device is reaped
    // by readServeSimStates() on the next status sample (it kills helpers
    // whose backing simulator is no longer in the booted set).
    if (url === base + "/grid/api/shutdown" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", async () => {
        let udid = "";
        try { udid = (JSON.parse(body) as ShutdownRequestBody).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
        // Stop our own in-process capture for this device first (no-op if it
        // isn't streamed here). This frees the native session immediately
        // rather than waiting for the next poll's reaper to notice.
        closeDeviceSession(udid);
        // Drop the snapshot so the next status sample re-queries simctl
        // and prunes any helper bound to this now-shutdown device.
        bootedSnapshot = { at: 0, booted: null, names: new Map(), deviceTypes: new Map() };
        execFile("xcrun", ["simctl", "shutdown", udid], { timeout: 30_000 }, async (err, _stdout, stderr) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              error: stderr?.toString().trim() || err.message,
            }));
            return;
          }
          await disableNetworkCaptureForStoppedDevice(udid);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      return;
    }

    // Start streaming a device in-process (auto-boots if needed). The preview
    // server serves its /helper routes directly — no spawned helper.
    if (url === base + "/grid/api/start" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer | string) => {
        body += typeof chunk === "string" ? chunk : chunk.toString();
      });
      req.on("end", () => {
        let udid = "";
        try { udid = (JSON.parse(body) as StartRequestBody).udid ?? ""; } catch {}
        if (!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Invalid or missing udid" }));
          return;
        }
        const port = req.socket.localPort ?? 0;
        void startDeviceInProcess(
          udid,
          port,
          base,
          streamSettings,
          requirePreviewToken ? execToken : undefined,
          () => enableNetworkCaptureForStartedDevice(udid, networkCapture),
        ).then((error) => {
          if (res.writableEnded) return;
          if (error) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          }
        });
      });
      return;
    }

    // JSON API: start the inspect-webkit CDP bridge and list WebKit targets
    // for the selected simulator. The bridge itself serves /json/list and
    // /devtools/page/:id on localhost; the preview adds iframe-safe frontend
    // URLs so the browser UI can embed Chrome DevTools.
    if (url === base + "/devtools") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No serve-sim device" }));
        return;
      }
      try {
        const bridge = await getInspectWebKitBridge();
        const bridgeTargets = await bridge.listTargets();
        // Proxy mode routes the inspector socket through the preview's
        // same-origin `/devtools` proxy; otherwise the browser talks to the
        // bridge's loopback port directly (the pre-proxy behavior).
        const wsProtocol = proxyHelpers ? websocketProtocolForRequest(req) : "ws";
        const wsTargetBase = proxyHelpers
          ? `${hostForRequest(req) ?? `127.0.0.1:${bridge.port}`}${devtoolsPrefix}`
          : `127.0.0.1:${bridge.port}/devtools`;
        // inspect-webkit@0.0.3 only exposes `sim:<webinspectord-pid>` for
        // simulator targets, which can't be reconciled against a sim UDID.
        // Surface every booted sim's targets (Safari Develop-menu behavior)
        // until inspect-webkit grows a real UDID we can filter on.
        const targets = bridgeTargets.map((target) => ({
          ...target,
          webSocketDebuggerUrl: `${wsProtocol}://${wsTargetBase}/page/${encodeURIComponent(target.id)}`,
          devtoolsFrontendUrl: devtoolsFrontendUrl(devtoolsFrontendBase, wsProtocol, wsTargetBase, target.id),
        }));
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({
          port: bridge.port,
          targets,
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: err instanceof Error ? err.message : "Failed to start inspect-webkit",
        }));
      }
      return;
    }

    // POST /devtools/release — drop hover-highlight CDP sessions so we don't
    // sit on a WIR slot when the picker is dismissed (or the tab is closed).
    // Optional body { targetId } releases just one; empty body releases all.
    if (url === base + "/devtools/release" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed: ReleaseRequestBody = body ? JSON.parse(body) : {};
          const bridge = await getInspectWebKitBridge();
          bridge.releaseHighlight?.(parsed.targetId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to release",
          }));
        }
      });
      return;
    }

    // POST /devtools/highlight — flash an inspectable target in the
    // simulator the way Safari's Develop menu hover does. Body shape:
    // { targetId: string, on: boolean }.
    if (url === base + "/devtools/highlight" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", async () => {
        try {
          const { targetId, on } = JSON.parse(body || "{}") as HighlightRequestBody;
          if (!targetId) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing targetId" }));
            return;
          }
          const bridge = await getInspectWebKitBridge();
          if (!bridge.highlightTarget) {
            res.writeHead(501, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "highlightTarget not supported by inspect-webkit" }));
            return;
          }
          await bridge.highlightTarget(targetId, !!on);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: err instanceof Error ? err.message : "Failed to highlight target",
          }));
        }
      });
      return;
    }

    if (url === base + "/healthz") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url === base + "/readyz") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ status: "starting" }));
        return;
      }
      try {
        await getDeviceSession(state.device, streamSettings).start();
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ status: "ready", device: state.device }));
      } catch {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ status: "starting" }));
      }
      return;
    }

    // JSON API: serve-sim state
    if (url === base + "/api") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      // The web UI polls /api every ~2s, so logging every hit floods the
      // debug stream with identical lines. Only log when the selection
      // result changes.
      const apiLogKey = `${selectedDevice ?? "(any)"}|${states.length}|${
        state ? `${state.device}@${state.port}` : "none"
      }`;
      if (apiLogKey !== lastApiLogKey) {
        lastApiLogKey = apiLogKey;
        debugMw(
          "GET /api selectedDevice=%s states=%d chose=%s",
          selectedDevice ?? "(any)",
          states.length,
          state ? `${state.device}@${state.port}` : "none",
        );
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      const remoteState = state ? rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers) : null;
      res.end(
        JSON.stringify(
          remoteState
            ? previewConfigForState(remoteState, base, execToken, streamSettings, proxyHelpers, requirePreviewToken, shareUrl)
            : null,
        ),
      );
      return;
    }

    // Still-PNG capture via `simctl io <udid> screenshot`. Consumed by the
    // Expo Device Hub dashboard's save-screenshot action (the serve-sim web UI
    // shells out over exec-ws instead, so it never hits this route). Uses the
    // ?device= selection with a booted-simulator fallback.
    if (url === base + "/api/screenshot") {
      if (req.method !== "POST") {
        res.writeHead(405, {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        });
        res.end("method not allowed");
        return;
      }
      let udid = selectedDevice;
      if (udid && !isSimulatorUdid(udid)) {
        res.writeHead(400, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ ok: false, error: "Invalid simulator device ID" }));
        return;
      }
      if (!udid) {
        const booted = await getBootedUdids();
        udid = (booted && [...booted][0]) ?? null;
      }
      if (!udid) {
        res.writeHead(400, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ ok: false, error: "No booted simulator to screenshot" }));
        return;
      }
      // simctl only writes to a file, so round-trip through a private tmp path
      // instead of streaming; captures are a few MB at most.
      const file = join(tmpdir(), `serve-sim-screenshot-${randomBytes(8).toString("hex")}.png`);
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            "xcrun",
            ["simctl", "io", udid, "screenshot", file],
            { timeout: 5_000 },
            (err, _stdout, stderr) => {
              if (err) reject(Object.assign(err, { stderr: stderr?.toString() }));
              else resolve();
            },
          );
        });
        const png = await readFile(file);
        res.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "image/png",
        });
        res.end(png);
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        const message =
          (typeof stderr === "string" && stderr.trim()) ||
          (err instanceof Error ? err.message : String(err));
        res.writeHead(500, {
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ ok: false, error: message }));
      } finally {
        // Best-effort cleanup; the PNG is already in memory by now.
        await unlink(file).catch(() => {});
      }
      return;
    }

    // JSON API: recent simulator action log. This is intentionally in-memory and
    // bounded; it is for live debugging/agent observability, not archival audit.
    if (url === base + "/api/event-log") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        events: readEventLog({
          device: requestedDevice,
          sinceId: eventLogSinceId(rawUrl),
          limit: eventLogLimit(rawUrl),
        }),
      }));
      return;
    }

    // SSE: action log stream. Sends a snapshot first, then individual new
    // entries. The exec-ws control channel proxies this route for the browser UI.
    if (url === base + "/api/event-log/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      res.write("data: " + JSON.stringify({
        events: readEventLog({
          device: requestedDevice,
          sinceId: eventLogSinceId(rawUrl),
          limit: eventLogLimit(rawUrl),
        }),
      }) + "\n\n");

      const unsubscribe = subscribeEventLog((event) => {
        if (requestedDevice && event.device !== requestedDevice) return;
        if (res.writableEnded) return;
        res.write("data: " + JSON.stringify({ event }) + "\n\n");
      });
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(":\n\n");
      }, 15000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // SSE: serve-sim state stream. Push replacement for the web UI's old ~1.5s
    // /api poll — the PreviewConfig only changes when a helper boots/shuts down
    // or the device selection changes, so we watch the state dir and emit only
    // on change instead of re-sending identical JSON on a fixed interval.
    if (url === base + "/api/events") {
      const computeConfig = async (): Promise<string> => {
        const states = await readServeSimStates();
        const state = selectServeSimState(states, selectedDevice);
        const remoteState = state ? rewriteStateForRequestHost(state, hostForRequest(req), base, httpProtocolForRequest(req), proxyHelpers) : null;
        return JSON.stringify(
          remoteState
            ? previewConfigForState(remoteState, base, execToken, streamSettings, proxyHelpers, requirePreviewToken, shareUrl)
            : null,
        );
      };

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      let lastSent = await computeConfig();
      res.write("data: " + lastSent + "\n\n");

      let closed = false;
      const sendIfChanged = async () => {
        if (closed || res.writableEnded) return;
        const next = await computeConfig();
        if (next === lastSent) return;
        lastSent = next;
        res.write("data: " + next + "\n\n");
      };

      // Debounce filesystem events: a helper boot rewrites the state file a few
      // times in quick succession, and selectServeSimState also shells out to
      // refresh booted devices, so coalesce bursts into one recompute.
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const onFsEvent = () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          sendIfChanged();
        }, 150);
      };

      let watcher: FSWatcher | null = null;
      let watcherRetry: ReturnType<typeof setTimeout> | null = null;
      const ensureWatcher = () => {
        if (closed || res.writableEnded || watcher || watcherRetry) return;
        watcherRetry = setTimeout(() => {
          watcherRetry = null;
          if (closed || res.writableEnded || watcher) return;
          try {
            watcher = watch(stateDir(), onFsEvent);
            watcher.on("error", () => {
              watcher?.close();
              watcher = null;
              ensureWatcher();
            });
            sendIfChanged();
          } catch {
            ensureWatcher();
          }
        }, 250);
      };
      ensureWatcher();

      // Keep the connection alive through buffering proxies + catch any change
      // an fs event missed (e.g. dir created after we failed to watch it).
      const heartbeat = setInterval(() => {
        if (closed || res.writableEnded) return;
        res.write(":\n\n");
        ensureWatcher();
      }, 15000);

      req.on("close", () => {
        closed = true;
        if (debounce) clearTimeout(debounce);
        if (watcherRetry) clearTimeout(watcherRetry);
        clearInterval(heartbeat);
        watcher?.close();
      });
      return;
    }

    if (url === base + "/crashes" || url === base + "/crashes/") {
      const state = await selectDeviceAndReap(selectedDevice);
      await handleCrashesRequestAfter(
        () => crashRuntime.start({ deferToRetry: true }).catch(() => {}),
        req,
        res,
        state,
        rawUrl
      );
      return;
    }

    if (url.startsWith(base + "/crashes/")) {
      const rawId = url.slice((base + "/crashes/").length);
      let id: string;
      try {
        id = decodeURIComponent(rawId);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              `Malformed percent-escape in the crash id (${rawId}). Copy the id verbatim from ` +
              "GET {base}/crashes.",
          })
        );
        return;
      }
      const state = await selectDeviceAndReap(selectedDevice);
      const params = new URL(rawUrl, "http://127.0.0.1").searchParams;
      await handleCrashReportRequest(
        req,
        res,
        state,
        id,
        params.get("occurrence"),
        undefined,
        undefined,
        params.get("key")
      );
      return;
    }

    if (url === base + "/logs") {
      handleLogsRequest(req, res, await selectDeviceAndReap(selectedDevice), rawUrl);
      return;
    }

    // SSE: normalized accessibility snapshot stream
    if (url === base + "/ax") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");
      axStreamerCache.prune(states.map((s) => s.device));
      const ax = axStreamerCache.get(state.device);
      const removeClient = ax.addClient(res);
      req.on("close", removeClient);
      return;
    }

    // SSE of the user app's live CPU/memory: an `event: meta` frame (schema,
    // udid, hostCores, cadence), then one `data:` line per sample.
    if (url === base + "/metrics") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      handleMetricsRequest(req, res, state, metricsSamplerCache);
      return;
    }

    if (url === base + "/network-capture") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      handleNetworkCaptureRequest(req, res, state, captureRuntime);
      return;
    }

    if (url.startsWith(base + "/network-capture/")) {
      const rawId = url.slice((base + "/network-capture/").length);
      let id: string;
      try {
        id = decodeURIComponent(rawId);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...NO_STORE });
        res.end(
          JSON.stringify({
            error:
              `Malformed percent-escape in the capture id (${rawId}). Copy the id verbatim from ` +
              "the {base}/network-capture stream.",
          }),
        );
        return;
      }
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      handleCaptureBodyRequest(req, res, state, id, captureRuntime);
      return;
    }

    // SSE: foreground-app change stream. Emits `{bundleId, pid}` events
    // parsed from SpringBoard's "Setting process visibility to: Foreground"
    // log line. Filtering is done here (not in the browser) so the SSE stream
    // stays narrow and the client can listen without rate-limit concerns.
    if (url === base + "/appstate") {
      const states = await readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        res.writeHead(404);
        res.end("No serve-sim device");
        return;
      }
      const udid = state.device;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":\n\n");

      // SpringBoard's foreground feed is edge-triggered, so a fresh subscriber sees nothing until
      // the next app switch. The shared tracker seeds itself from the AX bridge on start, so replay
      // its current app (once known) before streaming changes.
      let lastApp: ForegroundApp | null = null;
      let generation = 0;
      const emit = async (app: ForegroundApp) => {
        // Dedup on bundleId and pid: the tracker emits same-bundle relaunches with a fresh pid, and
        // clients need the live pid.
        if (res.writableEnded || (app.bundleId === lastApp?.bundleId && app.pid === lastApp.pid)) return;
        lastApp = app;
        // detectReactNative is awaited, so a later switch can resolve first; only write if no newer
        // emit has started, otherwise a slow lookup could overwrite the client with a stale app.
        const generationAtStart = ++generation;
        const isReactNative = await detectReactNative(udid, app.bundleId);
        if (!res.writableEnded && generationAtStart === generation) {
          res.write("data: " + JSON.stringify({ bundleId: app.bundleId, pid: app.pid, isReactNative }) + "\n\n");
        }
      };
      const subscription = foregroundTracker.subscribe(udid, (app) => void emit(app));
      const current = foregroundTracker.peek(udid);
      if (current) void emit(current);
      req.on("close", () => subscription.unsubscribe());
      return;
    }

    // Not ours — pass through
    if (next) return next();
  }) as ConnectMiddleware;
  connectMiddleware.handleUpgrade = (req: SimReq, socket: Socket, head: Buffer) => {
    // Upgrades skip the HTTP request path, and the HID and devtools sockets carry no token of
    // their own, so gate them here too.
    if (
      !assertUpgradeAccess(
        upgradeAuthHeaders(req.headers),
        execToken,
        { required: requirePreviewToken },
      )
    ) {
      socket.destroy();
      return;
    }
    const rawUrl = req.url ?? "";
    const selectedDevice = queryDevice(rawUrl) ?? options?.device ?? null;
    const helperTarget = helperProxyTarget(rawUrl, helperPrefix);
    const devtoolsTarget = devtoolsProxyTarget(rawUrl, devtoolsPrefix);
    if (devtoolsTarget) {
      (async () => {
        try {
          const bridge = await getInspectWebKitBridge();
          bridgeWebSocketFrames(
            req,
            socket,
            head,
            `ws://127.0.0.1:${bridge.port}${devtoolsTarget.upstreamPath}`,
            execToken,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to start inspect-webkit";
          socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}`);
        }
      })();
      return;
    }
    if (!helperTarget) {
      socket.destroy();
      return;
    }
    const device = helperTarget.device ?? selectedDevice;
    if (helperTarget.upstreamPath === "/ws") {
      // HID input is delivered to the in-process DeviceSession.
      if (attachHidInProcess(req, socket, execToken, head, device, streamSettings)) return;
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  };
  // Off the browser's per-origin connection pool, so preview tabs holding MJPEG and SSE streams
  // can't starve actions. Hosts mounting this middleware forward `upgrade` events here.
  const fetchMiddleware = (async (request: Request) => {
    return connectToFetch(connectMiddleware, request);
  }) as SimMiddleware;

  const execWebSocketHandler = createExecWebSocketHandler({
    path: `${base}/exec-ws`,
    execToken,
    corsOrigins,
    ssePrefixes: sseStreamPaths(base),
    onUiRequest: handleUiRequest,
    serveSimBinPath: serveSimBinPath(),
    onActionResult: (action, params, result) => recordActionEvent(action, params, result),
    onSseRequest(path, websocketRequest) {
      const url = new URL(path, websocketRequest.url);
      const origin = websocketRequest.headers.get("origin");
      const site = websocketRequest.headers.get("sec-fetch-site");
      // The exec channel already authenticated, so its fan-out carries the token past the gate. It
      // keeps the socket's origin, so a same-origin-only route still sees who is asking.
      return fetchMiddleware(new Request(url, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${execToken}`,
          ...(origin ? { origin } : {}),
          ...(site ? { "sec-fetch-site": site } : {}),
        },
      }));
    },
  });

  fetchMiddleware.handleWebSocket = (request: Request, websocket: UpgradeHandlerWebSocket): boolean => {
    // Before any refusal below can close it: an unhandled error from a peer that keeps sending
    // would exit the process.
    websocket.on("error", () => websocket.close());
    // Embedded hosts forward accepted sockets and bypass the request gate. The exec channel
    // re-checks the token itself; the helper HID socket does not.
    if (
      !assertUpgradeAccess(
        upgradeAuthHeaders(request),
        execToken,
        { required: requirePreviewToken },
      )
    ) {
      websocket.close();
      return true;
    }
    if (execWebSocketHandler(request, websocket)) return true;
    if (claimHelperHidSocket(request, websocket, {
      helperProxyTarget: (rawUrl) => helperProxyTarget(rawUrl, helperPrefix),
      fallbackDevice: options?.device ?? null,
      resolveSession: (device) => getDeviceSession(device, streamSettings),
    })) return true;
    return false;
  };

  // WebSocket upgrades owned by the preview: the authenticated exec/control
  // channel plus same-origin helper/devtools proxy sockets.
  fetchMiddleware.handleUpgrade = (req: SimReq, socket: Socket, head: Buffer) => {
    connectMiddleware.handleUpgrade?.(req, socket, head);
  };
  return fetchMiddleware;
}
