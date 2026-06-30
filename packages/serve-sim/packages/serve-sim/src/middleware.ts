import { readdirSync, readFileSync, existsSync, unlinkSync, watch, type FSWatcher } from "fs";
import { readFile, unlink } from "fs/promises";
import { execSync, spawn, exec, execFile, type ChildProcess, type ExecException, type ExecFileOptions, type PromiseWithChild } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { createServer as createNetServer } from "net";
import type { IncomingMessage } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import { createAxStreamerCache } from "./ax";
import { debugMw } from "./debug";
import {
  createExecWebSocketHandler,
  type ExecWebSocket,
  type UiRequestHandler,
} from "./exec-ws";
import { UI_OPTIONS, getUiStatus, normalizeUiValue, setUiOption } from "./ui-settings";

// Injected at build time as a base64-encoded string via `define`
declare const __PREVIEW_HTML_B64__: string;
const STATE_DIR = join(tmpdir(), "serve-sim");
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

type WebKitBridge = {
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
  devices: Record<string, Array<{ udid: string; state: string }>>;
};

type SimctlAllList = {
  devices: Record<string, Array<Omit<SimctlDevice, "runtime">>>;
};

type ShutdownRequestBody = { udid?: string };
type StartRequestBody = { udid?: string };
type ReleaseRequestBody = { targetId?: string };
type HighlightRequestBody = { targetId?: string; on?: boolean };
type ExecRequestBody = { command?: string };

export interface ServeSimState {
  pid: number;
  port: number;
  device: string;
  url: string;
  streamUrl: string;
  wsUrl: string;
}

const axStreamerCache = createAxStreamerCache();

// Hard cap on the SSE line-assembly buffer for child-process stdout.
// A malformed log entry without a newline can't grow this beyond 1 MB;
// the partial line is dropped rather than retained indefinitely.
const SSE_LINE_BUFFER_LIMIT = 1024 * 1024;
let inspectWebKitBridge: Promise<WebKitBridge> | null = null;

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

// Processes that SpringBoard logs as "Foreground" but are not the visible
// user-facing app — widgets, extensions, background services. Emitting
// these to the client causes the app indicator to flicker as the user
// actually-foreground app switches mid-launch.
const NON_UI_BUNDLE_RE = /(WidgetRenderer|ExtensionHost|\.extension(\.|$)|Service|PlaceholderApp|InCallService|CallUI|InCallUI|com\.apple\.Preferences\.Cellular|com\.apple\.purplebuddy|com\.apple\.chrono|com\.apple\.shuttle|com\.apple\.usernotificationsui)/i;

function isUserFacingBundle(bundleId: string): boolean {
  return !NON_UI_BUNDLE_RE.test(bundleId);
}

export function parseForegroundAppLogMessage(message: string): { bundleId: string; pid: number } | null {
  // e.g. "[app<com.apple.mobilesafari>:43117] Setting process visibility to: Foreground"
  const match = /\[app<([^>]+)>:(\d+)\] Setting process visibility to: Foreground/.exec(message);
  if (!match) return null;
  return { bundleId: match[1]!, pid: parseInt(match[2]!, 10) };
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
// readServeSimStates() is called on every /api and every page load.
let bootedSnapshot: { at: number; booted: Set<string> | null } = { at: 0, booted: null };
function getBootedUdids(): Set<string> | null {
  const now = Date.now();
  if (bootedSnapshot.booted && now - bootedSnapshot.at < 1500) {
    return bootedSnapshot.booted;
  }
  try {
    const output = execSync("xcrun simctl list devices booted -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as SimctlBootedList;
    const booted = new Set<string>();
    for (const runtime of Object.values(data.devices)) {
      for (const device of runtime) {
        if (device.state === "Booted") booted.add(device.udid);
      }
    }
    bootedSnapshot = { at: now, booted };
    return booted;
  } catch {
    return null;
  }
}

function readServeSimStates(): ServeSimState[] {
  let files: string[];
  try {
    files = readdirSync(STATE_DIR).filter(
      (f) => f.startsWith("server-") && f.endsWith(".json"),
    );
  } catch {
    return [];
  }
  const booted = getBootedUdids();
  const states: ServeSimState[] = [];
  for (const f of files) {
    const path = join(STATE_DIR, f);
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
      if (booted && !booted.has(state.device)) {
        debugMw(
          "recycling stale helper pid=%d (device %s no longer booted)",
          state.pid,
          state.device,
        );
        try { process.kill(state.pid, "SIGTERM"); } catch {}
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
 * True for a well-formed simulator UDID — the canonical UUID shape `simctl`
 * reports. Guards the grid/screenshot routes before they shell out to `xcrun
 * simctl <udid>`. (The UI-settings route accepts a looser id form on purpose.)
 */
function isSimulatorUdid(value: string | null | undefined): value is string {
  return value != null && /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(value);
}

/** Resolved value of {@link execFileAsync}. */
interface ExecAsyncReturns {
  stdout: string;
  stderr: string;
}

/**
 * Promise-returning `execFile` that still exposes the spawned process on
 * `.child` — the same contract as `util.promisify(execFile)`, including
 * surfacing `stdout`/`stderr` on the rejected error. Lets the screenshot route
 * `await` the `simctl` capture instead of hand-wrapping the callback form.
 */
function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions = {},
): PromiseWithChild<ExecAsyncReturns> {
  let child!: ChildProcess;
  const promise = new Promise<ExecAsyncReturns>((resolve, reject) => {
    child = execFile(file, args, options, (error, stdout, stderr) => {
      // stdout/stderr are typed `string | Buffer` (options could set encoding);
      // normalize to string for the default text contract.
      if (error) reject(Object.assign(error, { stdout: stdout.toString(), stderr: stderr.toString() }));
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  }) as PromiseWithChild<ExecAsyncReturns>;
  promise.child = child;
  return promise;
}

function endpoint(base: string, path: string, device: string): string {
  const value = `${base}${path}`;
  return `${value}?device=${encodeURIComponent(device)}`;
}

/**
 * Rewrite the helper URLs in a state so they point at the hostname the request
 * came in on. The helper binds on `*:<port>`, so once the host portion matches
 * the dev-server origin, a remote viewer (LAN, or tunnel exposing the helper
 * port under the same hostname) can reach the stream. Loopback callers get
 * the state untouched.
 */
export function rewriteStateForRequestHost(
  state: ServeSimState,
  hostHeader: string | undefined,
): ServeSimState {
  if (!hostHeader) return state;
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

export function previewConfigForState(
  state: ServeSimState,
  base: string,
  serveSimBin: string,
  execToken: string,
): ServeSimState & {
  basePath: string;
  logsEndpoint: string;
  appStateEndpoint: string;
  axEndpoint: string;
  devtoolsEndpoint: string;
  serveSimBin: string;
  gridApiEndpoint: string;
  gridStartEndpoint: string;
  gridShutdownEndpoint: string;
  gridMemoryEndpoint: string;
  previewEndpoint: string;
  execToken: string;
} {
  const gridApiBase = (base === "" ? "" : base) + "/grid/api";
  return {
    ...state,
    basePath: base,
    logsEndpoint: endpoint(base, "/logs", state.device),
    appStateEndpoint: endpoint(base, "/appstate", state.device),
    axEndpoint: endpoint(base, "/ax", state.device),
    devtoolsEndpoint: endpoint(base, "/devtools", state.device),
    serveSimBin,
    gridApiEndpoint: gridApiBase,
    gridStartEndpoint: gridApiBase + "/start",
    gridShutdownEndpoint: gridApiBase + "/shutdown",
    gridMemoryEndpoint: gridApiBase + "/memory",
    previewEndpoint: base === "" ? "/" : base,
    execToken,
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
        // Bind explicitly to IPv4 127.0.0.1 to match what bridgeWsHost emits
        // (and what the DevTools frontend CSP whitelists). `localhost` resolves
        // to ::1 first on some setups, which would leave the iframe's
        // ws://127.0.0.1:9222 connection refused.
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

function devtoolsFrontendUrl(frontendBase: string, wsHost: string, targetId: string): string {
  const url = new URL(`${frontendBase}/inspector.html`, "http://serve-sim.local");
  url.searchParams.set("ws", `${wsHost}/devtools/page/${targetId}`);
  return `${url.pathname}${url.search}`;
}

// The inspect-webkit bridge binds locally. Always emit `127.0.0.1` rather
// than `localhost` for the iframe's WS URL: the chrome-devtools-frontend
// inspector.html ships a CSP whose connect-src only whitelists
// `ws://127.0.0.1:*` (plus `'self'`, which doesn't cover the bridge's
// different port). A `ws://localhost:9222/...` connection from the iframe
// gets CSP-blocked and surfaces as "WebSocket disconnected."
// Non-local hostnames fall back to 127.0.0.1 since the bridge isn't
// reachable from off-host anyway.
function bridgeWsHost(_reqHost: string | undefined, bridgePort: number): string {
  return `127.0.0.1:${bridgePort}`;
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
  runtime: string;
}

function listAllSimulators(): SimctlDevice[] {
  try {
    const output = execSync("xcrun simctl list devices -j", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    });
    const data = JSON.parse(output) as SimctlAllList;
    const out: SimctlDevice[] = [];
    for (const [runtime, devices] of Object.entries(data.devices)) {
      // Keep this to touch-capable simulator families that serve-sim can frame
      // and inject into. tvOS is intentionally left out for now.
      if (!/SimRuntime\.(iOS|watchOS|visionOS|xrOS)-/i.test(runtime)) continue;
      for (const d of devices) {
        if (d.isAvailable === false) continue;
        out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
      }
    }
    return out;
  } catch {
    return [];
  }
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

/**
 * Locate the `serve-sim` CLI binary so the grid can spawn helpers via
 * `serve-sim --detach <udid>`. Tries, in order:
 *   1. argv[0] if it ends in `serve-sim` (we're running inside the
 *      compiled standalone binary, which IS the CLI)
 *   2. `serve-sim` on PATH (npm-installed / bun-installed CLI)
 * Returns the resolved command + args ready for spawn.
 */
function resolveServeSimCommand(): { command: string; baseArgs: string[] } | null {
  // 1. Compiled standalone binary: argv[0] is the serve-sim binary itself.
  if (process.argv[0] && /(^|\/)serve-sim$/.test(process.argv[0])) {
    return { command: process.argv[0], baseArgs: [] };
  }
  // 2. Running the JS bundle directly: `node /path/to/serve-sim.js`.
  if (process.argv[1] && /(^|\/)serve-sim\.js$/.test(process.argv[1])) {
    return { command: process.argv[0]!, baseArgs: [process.argv[1]!] };
  }
  // 3. Global install: serve-sim is on PATH.
  try {
    const path = execSync("command -v serve-sim", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_500,
    }).trim();
    if (path) return { command: path, baseArgs: [] };
  } catch {}
  return null;
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
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  // `application/json; charset=utf-8` etc. — only the media type matters.
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json";
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type SseSink = {
  readonly closed: boolean;
  write(chunk: string): void;
  close(): void;
};

function requestHost(request: Request, url: URL): string | undefined {
  return request.headers.get("host") ?? url.host ?? undefined;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // Allow a cross-origin client (e.g. the Expo Hub dashboard on another
  // dev-server port) to read these JSON routes (/api, /grid/api, …).
  if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function textResponse(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain; charset=utf-8");
  }
  return new Response(value, { ...init, headers });
}

function noStoreJsonResponse(value: unknown, status = 200): Response {
  return jsonResponse(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function sseResponse(setup: (sink: SseSink) => void | (() => void)): Response {
  let cleanup: (() => void) | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        try { cleanup?.(); } catch {}
        try { controller.close(); } catch {}
      };
      const sink: SseSink = {
        get closed() {
          return closed;
        },
        write(chunk: string) {
          if (closed) return;
          try {
            controller.enqueue(textEncoder.encode(chunk));
          } catch {
            close();
          }
        },
        close,
      };

      try {
        cleanup = setup(sink) ?? undefined;
      } catch (error) {
        closed = true;
        controller.error(error);
      }
    },
    cancel() {
      if (closed) return;
      closed = true;
      try { cleanup?.(); } catch {}
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // Allow a cross-origin client (Expo Hub on another dev-server port) to
      // read the SSE side-channels (/logs, /ax, /appstate, /api/events).
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function readTextBody(request: Request, maxBytes?: number): Promise<
  { ok: true; text: string } | { ok: false; response: Response }
> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (maxBytes !== undefined && size > maxBytes) {
        await reader.cancel().catch(() => {});
        return {
          ok: false,
          response: jsonResponse(
            { stdout: "", stderr: "Payload Too Large", exitCode: 1 },
            { status: 413 },
          ),
        };
      }
      text += textDecoder.decode(value, { stream: true });
    }
    text += textDecoder.decode();
    return { ok: true, text };
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fetch-style middleware that serves the simulator preview UI.
 *
 * Routes handled under `basePath` (default `/.sim`):
 *   GET  {basePath}         — the preview HTML page
 *   GET  {basePath}/api     — serve-sim state JSON
 *   GET  {basePath}/logs    — SSE stream of simctl logs
 *   GET  {basePath}/ax      — SSE stream of normalized accessibility snapshots
 */
export function simMiddleware(options?: SimMiddlewareOptions) {
  const base = (options?.basePath ?? "/.sim").replace(/\/+$/, "");
  // Per-process random token. Anyone who can read the preview HTML same-origin
  // can call /exec; cross-origin pages and LAN clients cannot, because they
  // can't read this value (it's only injected into the preview page's config).
  const execToken = options?.execToken ?? randomBytes(32).toString("base64url");

  // Simulator-settings requests run in-process (just the underlying simctl /
  // ax-tool spawn) instead of round-tripping a full `node <cli>` exec per
  // sidebar interaction.
  const handleUiRequest: UiRequestHandler = async (payload) => {
    const p = (payload ?? {}) as { device?: string; option?: string; value?: string };
    if (typeof p.device !== "string" || !/^[0-9A-Za-z-]+$/.test(p.device)) {
      throw new Error("missing or invalid device udid");
    }
    if (p.option === undefined) {
      return { status: await getUiStatus(p.device) };
    }
    if (!UI_OPTIONS[p.option]) throw new Error(`unknown option: ${p.option}`);
    const value = typeof p.value === "string" ? normalizeUiValue(p.option, p.value) : null;
    if (value === null) throw new Error(`invalid value for ${p.option}: ${p.value}`);
    await setUiOption(p.device, p.option, value);
    return { ok: true };
  };

  const middleware = async (request: Request): Promise<Response | undefined> => {
    const requestUrl = new URL(request.url, "http://serve-sim.local");
    const rawUrl = `${requestUrl.pathname}${requestUrl.search}`;
    const qIndex = rawUrl.indexOf("?");
    const url = requestUrl.pathname;
    const host = requestHost(request, requestUrl);
    const selectedDevice = queryDevice(rawUrl) ?? options?.device ?? null;
    const devtoolsFrontendBase = base === "/" ? "/devtools-frontend" : `${base}/devtools-frontend`;

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
        return textResponse("Invalid asset path", { status: 400 });
      }
      try {
        const upstream = await fetch(
          `https://chrome-devtools-frontend.appspot.com/serve_rev/@${DEVTOOLS_FRONTEND_REV}/${assetPath}${qIndex === -1 ? "" : rawUrl.slice(qIndex)}`,
        );
        const headers: Record<string, string> = {
          "Cache-Control": "public, max-age=604800",
        };
        const contentType = upstream.headers.get("content-type");
        if (contentType) headers["Content-Type"] = contentType;
        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (err) {
        return textResponse(
          err instanceof Error ? err.message : "Failed to load DevTools frontend",
          { status: 502 },
        );
      }
    }

    // Serve the preview page
    if (url === base || url === base + "/") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      let html = loadHtml();

      if (!state) {
        // Empty-state UI still polls /exec (boot/list helpers), so the page
        // needs the bearer token even before a helper attaches. Inject a
        // minimal config with just the basePath + token.
        const minimal = JSON.stringify({ basePath: base, execToken });
        html = html.replace(
          "<!--__SIM_PREVIEW_CONFIG__-->",
          `<script>window.__SIM_PREVIEW__=${minimal}</script>`,
        );
      }

      if (state) {
        const remoteState = rewriteStateForRequestHost(state, host);
        const config = JSON.stringify(previewConfigForState(remoteState, base, serveSimBinPath(), execToken));
        const configScript = `<script>window.__SIM_PREVIEW__=${config}</script>`;
        html = html.replace("<!--__SIM_PREVIEW_CONFIG__-->", configScript);
      }

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    // Memory capacity estimate: how much room is left to boot more sims.
    if (url === base + "/grid/api/memory") {
      return noStoreJsonResponse(buildMemoryReport());
    }

    // Grid JSON: every supported simulator, annotated with running helper info if any.
    if (url === base + "/grid/api") {
      const states = readServeSimStates();
      const helperByUdid = new Map(states.map((s) => [s.device, s] as const));
      const sims = listAllSimulators();
      const devices = sims.map((d) => {
        const helper = helperByUdid.get(d.udid);
        const remoteHelper = helper ? rewriteStateForRequestHost(helper, host) : null;
        return {
          device: d.udid,
          name: d.name,
          runtime: d.runtime,
          state: d.state,
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
      // Stable order: family (iPhone, iPad, Watch, TV, Vision, other) →
      // state (helper > booted > shutdown) → alpha. Keeps the most
      // commonly used devices visible without scrolling.
      const familyRank = (name: string): number => {
        if (/iphone/i.test(name)) return 0;
        if (/ipad/i.test(name)) return 1;
        if (/watch/i.test(name)) return 2;
        if (/(apple\s*tv|^tv\b)/i.test(name)) return 3;
        if (/vision|reality/i.test(name)) return 4;
        return 5;
      };
      const stateRank = (x: typeof devices[number]) =>
        x.helper ? 0 : x.state === "Booted" ? 1 : 2;
      devices.sort((a, b) =>
        familyRank(a.name) - familyRank(b.name) ||
        stateRank(a) - stateRank(b) ||
        a.name.localeCompare(b.name),
      );
      return noStoreJsonResponse({ devices });
    }

    // Shutdown a booted simulator. Any running helper for the device is reaped
    // by readServeSimStates() on the next /grid/api poll (it kills helpers
    // whose backing simulator is no longer in the booted set).
    if (url === base + "/grid/api/shutdown" && request.method === "POST") {
      const body = await request.text();
      let udid = "";
      try { udid = (JSON.parse(body) as ShutdownRequestBody).udid ?? ""; } catch {}
      if (!isSimulatorUdid(udid)) {
        return jsonResponse({ ok: false, error: "Invalid or missing udid" }, { status: 400 });
      }
      // Drop the snapshot so the next /grid/api call re-queries simctl
      // and prunes any helper bound to this now-shutdown device.
      bootedSnapshot = { at: 0, booted: null };
      return new Promise<Response>((resolve) => {
        execFile("xcrun", ["simctl", "shutdown", udid], { timeout: 30_000 }, (err, _stdout, stderr) => {
          if (err) {
            resolve(jsonResponse({
              ok: false,
              error: stderr?.toString().trim() || err.message,
            }, { status: 500 }));
            return;
          }
          resolve(jsonResponse({ ok: true }));
        });
      });
    }

    // Spawn a serve-sim helper (auto-boots if needed).
    if (url === base + "/grid/api/start" && request.method === "POST") {
      const body = await request.text();
      let udid = "";
      try { udid = (JSON.parse(body) as StartRequestBody).udid ?? ""; } catch {}
      if (!isSimulatorUdid(udid)) {
        return jsonResponse({ ok: false, error: "Invalid or missing udid" }, { status: 400 });
      }
      const resolved = resolveServeSimCommand();
      if (!resolved) {
        return jsonResponse({
          ok: false,
          error: "serve-sim CLI not found in PATH. Install it (npm i -g serve-sim) and retry.",
        }, { status: 500 });
      }
      return new Promise<Response>((resolve) => {
        const child = spawn(
          resolved.command,
          [...resolved.baseArgs, "--detach", udid],
          { stdio: ["ignore", "pipe", "pipe"], detached: false },
        );
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
        child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
        // A cold iOS simulator can take 60-90s to reach `bootstatus -b`
        // readiness; the prior 60s ceiling was killing serve-sim mid-boot
        // and the helper never got a chance to spawn, so the click ended
        // with an error and no state file. 3 minutes is a comfortable
        // upper bound that covers slow first-boots without leaving a
        // wedged child around indefinitely.
        const timer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
        }, 180_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) {
            resolve(jsonResponse({ ok: true, stdout: stdout.trim() }));
          } else {
            resolve(jsonResponse({
              ok: false,
              error: stderr.trim() || stdout.trim() || `serve-sim exited with code ${code}`,
            }, { status: 500 }));
          }
        });
      });
    }

    // JSON API: start the inspect-webkit CDP bridge and list WebKit targets
    // for the selected simulator. The bridge itself serves /json/list and
    // /devtools/page/:id on localhost; the preview adds iframe-safe frontend
    // URLs so the browser UI can embed Chrome DevTools.
    if (url === base + "/devtools") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return jsonResponse({ error: "No serve-sim device" }, { status: 404 });
      }
      try {
        const bridge = await ensureInspectWebKitBridge();
        const bridgeTargets = await bridge.listTargets();
        const wsHost = bridgeWsHost(host, bridge.port);
        // inspect-webkit@0.0.3 only exposes `sim:<webinspectord-pid>` for
        // simulator targets, which can't be reconciled against a sim UDID.
        // Surface every booted sim's targets (Safari Develop-menu behavior)
        // until inspect-webkit grows a real UDID we can filter on.
        const targets = bridgeTargets.map((target) => ({
          ...target,
          webSocketDebuggerUrl: `ws://${wsHost}/devtools/page/${encodeURIComponent(target.id)}`,
          devtoolsFrontendUrl: devtoolsFrontendUrl(devtoolsFrontendBase, wsHost, target.id),
        }));
        return noStoreJsonResponse({
          port: bridge.port,
          targets,
        });
      } catch (err) {
        return jsonResponse({
          error: err instanceof Error ? err.message : "Failed to start inspect-webkit",
        }, { status: 500 });
      }
    }

    // POST /devtools/release — drop hover-highlight CDP sessions so we don't
    // sit on a WIR slot when the picker is dismissed (or the tab is closed).
    // Optional body { targetId } releases just one; empty body releases all.
    if (url === base + "/devtools/release" && request.method === "POST") {
      try {
        const body = await request.text();
        const parsed: ReleaseRequestBody = body ? JSON.parse(body) : {};
        const bridge = await ensureInspectWebKitBridge();
        bridge.releaseHighlight?.(parsed.targetId);
        return jsonResponse({});
      } catch (err) {
        return jsonResponse({
          error: err instanceof Error ? err.message : "Failed to release",
        }, { status: 500 });
      }
    }

    // POST /devtools/highlight — flash an inspectable target in the
    // simulator the way Safari's Develop menu hover does. Body shape:
    // { targetId: string, on: boolean }.
    if (url === base + "/devtools/highlight" && request.method === "POST") {
      try {
        const { targetId, on } = JSON.parse(await request.text() || "{}") as HighlightRequestBody;
        if (!targetId) {
          return jsonResponse({ error: "Missing targetId" }, { status: 400 });
        }
        const bridge = await ensureInspectWebKitBridge();
        if (!bridge.highlightTarget) {
          return jsonResponse({ error: "highlightTarget not supported by inspect-webkit" }, { status: 501 });
        }
        await bridge.highlightTarget(targetId, !!on);
        return jsonResponse({});
      } catch (err) {
        return jsonResponse({
          error: err instanceof Error ? err.message : "Failed to highlight target",
        }, { status: 500 });
      }
    }

    // JSON API: serve-sim state
    if (url === base + "/api") {
      const states = readServeSimStates();
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
      const remoteState = state ? rewriteStateForRequestHost(state, host) : null;
      return noStoreJsonResponse(remoteState ? previewConfigForState(remoteState, base, serveSimBinPath(), execToken) : null);
    }

    // Capture a PNG of the simulator via `simctl io <udid> screenshot`
    if (url === base + "/api/screenshot") {
      if (request.method !== "GET" && request.method !== "POST") {
        return textResponse("method not allowed", { status: 405 });
      }
      const booted = getBootedUdids();
      const udid = selectedDevice ?? (booted ? [...booted][0] : null);
      if (!isSimulatorUdid(udid)) {
        return jsonResponse({ ok: false, error: "No booted simulator to screenshot" }, { status: 400 });
      }
      const file = join(tmpdir(), `serve-sim-screenshot-${randomBytes(8).toString("hex")}.png`);
      try {
        await execFileAsync("xcrun", ["simctl", "io", udid, "screenshot", file], { timeout: 30_000 });
        const png = await readFile(file);
        return new Response(new Uint8Array(png), {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        const stderr = (err as { stderr?: unknown }).stderr;
        const message =
          (typeof stderr === "string" && stderr.trim()) ||
          (err instanceof Error ? err.message : String(err));
        return jsonResponse({ ok: false, error: message }, { status: 500 });
      } finally {
        // Best-effort cleanup; the PNG is already in memory by now.
        await unlink(file).catch(() => {});
      }
    }

    // SSE: serve-sim state stream. Push replacement for the web UI's old ~1.5s
    // /api poll — the PreviewConfig only changes when a helper boots/shuts down
    // or the device selection changes, so we watch the state dir and emit only
    // on change instead of re-sending identical JSON on a fixed interval.
    if (url === base + "/api/events") {
      const computeConfig = (): string => {
        const states = readServeSimStates();
        const state = selectServeSimState(states, selectedDevice);
        const remoteState = state ? rewriteStateForRequestHost(state, host) : null;
        return JSON.stringify(
          remoteState ? previewConfigForState(remoteState, base, serveSimBinPath(), execToken) : null,
        );
      };

      return sseResponse((sink) => {
        sink.write(":\n\n");

        let lastSent = computeConfig();
        sink.write("data: " + lastSent + "\n\n");

        const sendIfChanged = () => {
          if (sink.closed) return;
          const next = computeConfig();
          if (next === lastSent) return;
          lastSent = next;
          sink.write("data: " + next + "\n\n");
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
          if (sink.closed || watcher || watcherRetry) return;
          watcherRetry = setTimeout(() => {
            watcherRetry = null;
            if (sink.closed || watcher) return;
            try {
              watcher = watch(STATE_DIR, onFsEvent);
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
          if (sink.closed) return;
          sink.write(":\n\n");
          ensureWatcher();
        }, 15000);

        return () => {
          if (debounce) clearTimeout(debounce);
          if (watcherRetry) clearTimeout(watcherRetry);
          clearInterval(heartbeat);
          watcher?.close();
        };
      });
    }

    // SSE: normalized accessibility snapshot stream
    if (url === base + "/ax") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return textResponse("No serve-sim device", { status: 404 });
      }
      return sseResponse((sink) => {
        sink.write(":\n\n");
        axStreamerCache.prune(states.map((s) => s.device));
        const ax = axStreamerCache.get(state.device, state.port);
        return ax.addClient({ write: (chunk) => sink.write(chunk) });
      });
    }

    // POST /exec — run a shell command on the host. Gated by a per-process
    // bearer token injected only into the same-origin preview HTML, with
    // Content-Type + Origin checks to block CORS-simple CSRF (a malicious
    // page POSTing `text/plain` JSON to a dev server bound to a public iface)
    // and LAN attackers who can reach the port but can't read the token.
    if ((url === base + "/exec" || url === base + "/exec/") && request.method === "POST") {
      // 1. Reject anything that isn't a JSON request, killing the
      //    `enctype="text/plain"` CORS-simple form-POST path.
      if (!isJsonContentType(request.headers.get("content-type") ?? undefined)) {
        return jsonResponse(
          { stdout: "", stderr: "Unsupported Media Type", exitCode: 1 },
          { status: 415 },
        );
      }
      // 2. If the browser supplied an Origin, require it match this server.
      //    Same-origin XHR from the preview page sets Origin to our own URL;
      //    a cross-origin page's Origin won't match.
      const origin = request.headers.get("origin");
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== host) {
            return jsonResponse(
              { stdout: "", stderr: "Cross-origin request blocked", exitCode: 1 },
              { status: 403 },
            );
          }
        } catch {
          return jsonResponse(
            { stdout: "", stderr: "Invalid Origin", exitCode: 1 },
            { status: 403 },
          );
        }
      }
      // 3. Require the per-session bearer token. Cross-origin pages cannot
      //    read it from window.__SIM_PREVIEW__; non-browser callers must
      //    have copied it from the CLI output.
      const authHeader = request.headers.get("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      if (!match || !safeEqualString(match[1]!.trim(), execToken)) {
        return jsonResponse(
          { stdout: "", stderr: "Unauthorized", exitCode: 1 },
          { status: 401 },
        );
      }
      const bodyResult = await readTextBody(request, 4 * 1024 * 1024);
      if (!bodyResult.ok) return bodyResult.response;
      let command = "";
      try {
        command = (JSON.parse(bodyResult.text) as ExecRequestBody).command ?? "";
      } catch {}
      if (!command) {
        return jsonResponse(
          { stdout: "", stderr: "Missing command", exitCode: 1 },
          { status: 400 },
        );
      }
      return new Promise<Response>((resolve) => {
        exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve(jsonResponse({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            exitCode: err ? (err as ExecException).code ?? 1 : 0,
          }));
        });
      });
    }

    // SSE: simctl log stream
    if (url === base + "/logs") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return textResponse("No serve-sim device", { status: 404 });
      }
      const udid = state.device;
      return sseResponse((sink) => {
        sink.write(":\n\n");

        const child: ChildProcess = spawn("xcrun", [
          "simctl", "spawn", udid, "log", "stream",
          "--style", "ndjson",
          "--level", "info",
        ], { stdio: ["ignore", "pipe", "ignore"] });

        let buf = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) sink.write("data: " + line + "\n\n");
          }
          // Drop a runaway partial line so a malformed/never-terminated
          // log entry can't grow `buf` without bound.
          if (buf.length > SSE_LINE_BUFFER_LIMIT) buf = "";
        });

        child.on("error", () => sink.close());
        child.on("close", () => sink.close());
        return () => {
          child.stdout?.destroy();
          child.kill();
        };
      });
    }

    // SSE: foreground-app change stream. Emits `{bundleId, pid}` events
    // parsed from SpringBoard's "Setting process visibility to: Foreground"
    // log line. Filtering is done here (not in the browser) so the SSE stream
    // stays narrow and the client can listen without rate-limit concerns.
    if (url === base + "/appstate") {
      const states = readServeSimStates();
      const state = selectServeSimState(states, selectedDevice);
      if (!state) {
        return textResponse("No serve-sim device", { status: 404 });
      }
      const udid = state.device;
      return sseResponse((sink) => {
        sink.write(":\n\n");

        // Bootstrap: SpringBoard's log feed is edge-triggered, so a fresh
        // subscriber would otherwise see nothing until the user re-foregrounds
        // an app (the bug: tools couldn't reconnect after a page reload). Ask
        // the helper's AX bridge for the current frontmost app via
        // `proc_pidpath`+Info.plist resolution and emit it before tailing.
        let lastBundle = "";
        void (async () => {
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 1500);
            const r = await fetch(`http://127.0.0.1:${state.port}/foreground`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!r.ok) return;
            const info = await r.json() as { bundleId?: string; pid?: number };
            if (!info.bundleId || !isUserFacingBundle(info.bundleId)) return;
            if (sink.closed) return;
            lastBundle = info.bundleId;
            const isReactNative = await detectReactNative(udid, info.bundleId);
            if (sink.closed) return;
            sink.write("data: " + JSON.stringify({ bundleId: info.bundleId, pid: info.pid, isReactNative }) + "\n\n");
          } catch {
            // Helper may be coming up — log tail will fill in once anything moves.
          }
        })();

        const child: ChildProcess = spawn("xcrun", [
          "simctl", "spawn", udid, "log", "stream",
          "--style", "ndjson",
          "--level", "info",
          "--predicate",
          'process == "SpringBoard" AND eventMessage CONTAINS "Setting process visibility to: Foreground"',
        ], { stdio: ["ignore", "pipe", "ignore"] });

        const emitApp = async (bundleId: string, pid?: number) => {
          if (!isUserFacingBundle(bundleId)) return;
          if (bundleId === lastBundle) return;
          lastBundle = bundleId;
          const isReactNative = await detectReactNative(udid, bundleId);
          if (!sink.closed) {
            sink.write("data: " + JSON.stringify({ bundleId, pid, isReactNative }) + "\n\n");
          }
        };

        let buf = "";
        child.stdout!.on("data", (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg: string;
            try { msg = JSON.parse(line).eventMessage ?? ""; } catch { continue; }
            const event = parseForegroundAppLogMessage(msg);
            if (!event) continue;
            emitApp(event.bundleId, event.pid);
          }
          if (buf.length > SSE_LINE_BUFFER_LIMIT) buf = "";
        });

        child.on("error", () => sink.close());
        child.on("close", () => sink.close());
        return () => {
          child.stdout?.destroy();
          child.kill();
        };
      });
    }

    return undefined;
  };

  // WebSocket exec channel — same auth/origin policy as POST /exec, but off
  // the browser's per-origin HTTP connection pool so multiple preview tabs
  // (each holding MJPEG + SSE streams) can't starve exec actions. Hosts own
  // the protocol upgrade and pass the accepted websocket here.
  return Object.assign(middleware, {
    handleWebSocket: createExecWebSocketHandler({
      path: `${base}/exec-ws`,
      execToken,
      ssePrefixes: [
        `${base}/api/events`,
        `${base}/appstate`,
        `${base}/logs`,
        `${base}/ax`,
      ],
      onUiRequest: handleUiRequest,
      onSseRequest(path, websocketRequest) {
        const url = new URL(path, `http://${websocketRequest.headers.host ?? "localhost"}`);
        return middleware(new Request(url, {
          headers: { accept: "text/event-stream" },
        }));
      },
    }),
  } satisfies {
    handleWebSocket(req: IncomingMessage, websocket: ExecWebSocket): boolean;
  });
}
