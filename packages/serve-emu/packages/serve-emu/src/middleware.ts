import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { listAllDevices, listDevices, screencapPng } from "./adb.ts";
import { getAccessibilitySnapshot } from "./accessibility.ts";
import {
  clearAppData,
  forceStopApp,
  grantPermission,
  importMediaFile,
  installApk,
  launchApp,
} from "./app-management.ts";
import { getForegroundApp } from "./app-info.ts";
import { getNightMode, isNightMode, setNightMode } from "./ui-mode.ts";
import { startSession, type EmuBackend, type EmuSession } from "./session.ts";
import { parseGesture, type Gesture } from "./input.ts";
import { parseGeoFix, setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { parseRoutePlaybackRequest, RoutePlayback } from "./route-playback.ts";
import { SessionRecorder } from "./session-recorder.ts";
import type { StreamSocket } from "./stream-socket.ts";

export { fromBunSocket, fromWsSocket } from "./stream-socket.ts";
export type { StreamSocket, WsWebSocketLike } from "./stream-socket.ts";
export { pickDevice } from "./adb.ts";
export type { ScrcpySession } from "./scrcpy.ts";
export type { EmuBackend, EmuSession } from "./session.ts";

const here = dirname(fileURLToPath(import.meta.url));
// `src/middleware.ts` and `dist/middleware.mjs` both resolve to `<pkg>/dist/ui`.
const UI_DIR = join(here, "..", "dist", "ui");

export type AppOptions = {
  serial: string;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
  /**
   * Video/input backend: "scrcpy" (default, works everywhere) or "grpc"
   * (emulator-only host-side capture; falls back to scrcpy when unavailable).
   * Defaults to the SERVE_EMU_BACKEND environment variable.
   */
  backend?: EmuBackend;
};

type SessionStatus = "streaming" | "stopped" | "error";

type Client = {
  id: number;
  socket: StreamSocket;
  frameMeta: boolean;
  sentFrames: number;
  droppedFrames: number;
  backpressureEvents: number;
  awaitingKeyFrame: boolean;
};

const MAX_WS_MESSAGE_BYTES = 16 * 1024;
const DROP_FRAME_BUFFERED_BYTES = 512 * 1024;
const CLOSE_CLIENT_BUFFERED_BYTES = 16 * 1024 * 1024;
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;
const VIDEO_RESET_COOLDOWN_MS = 1500;
const STALE_VIDEO_RESET_MS = 2500;
const MAX_JSON_BODY_BYTES = 8 * 1024;
const MAX_ROUTE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOGCAT_QUERY_BYTES = 200;
// After a device's scrcpy start fails, wait this long before retrying so a
// flapping device doesn't get hammered on every request.
const SPAWN_RETRY_COOLDOWN_MS = 5_000;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Serve a file from the built UI directory. Returns `null` when the path does
 * not map to a real file so callers can fall back to a 404. The UI shell is
 * device-independent, so the router serves it without a device attached.
 */
function serveStaticFile(pathname: string): Response | null {
  const reqPath = pathname === "/" ? "/index.html" : pathname;
  if (reqPath.includes("..")) return null;
  const filePath = join(UI_DIR, reqPath);
  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return new Response(new Uint8Array(readFileSync(filePath)), {
      headers: { "Content-Type": contentTypeFor(filePath) },
    });
  }
  return null;
}

/**
 * Build a transport-agnostic serve-emu app for one device: starts scrcpy, owns
 * the client set + video fan-out, and exposes a fetch-style `handleRequest` plus
 * an `attachWebSocket` for the H.264/gesture channel. `server.ts` (Bun) and the
 * Expo DevTools plugin both mount these onto their own transport.
 */
export async function createApp(opts: AppOptions) {
  const session: EmuSession = await startSession({
    serial: opts.serial,
    maxFps: opts.maxFps,
    bitRate: opts.bitRate,
    maxSize: opts.maxSize,
    keyFrameInterval: opts.keyFrameInterval,
    backend: opts.backend,
  });

  const clients = new Set<Client>();
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  let status: SessionStatus = "streaming";
  let lastError: string | null = null;
  let stoppedAt: string | null = null;
  let stopRequested = false;
  let frameCount = 0;
  let configPacketCount = 0;
  let lastFrameMs = 0;
  let totalDroppedFrames = 0;
  let totalBackpressureEvents = 0;
  let sourceFps = 0;
  let lastFpsFrameCount = 0;
  let videoResetRequests = 0;
  let lastVideoResetAt: string | null = null;
  let lastVideoResetReason: string | null = null;
  let lastVideoResetMs = 0;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastLocation: (GeoFix & { appliedAt: string }) | null = null;
  let nextClientId = 1;
  const sessionRecorder = new SessionRecorder();
  const routePlayback = new RoutePlayback({
    applyLocation: (fix) => setEmulatorLocationAsync(opts.serial, fix),
    onLocation: (fix) => {
      lastLocation = fix;
    },
  });

  const health = () => ({
    ok: status === "streaming",
    status,
    serial: opts.serial,
    device: session.meta.deviceName,
    transport: session.transport,
    codec: session.meta.codecId,
    size: { width: session.meta.width, height: session.meta.height },
    clients: clients.size,
    frames: frameCount,
    sourceFps,
    configPackets: configPacketCount,
    droppedFrames: totalDroppedFrames,
    backpressureEvents: totalBackpressureEvents,
    videoResetRequests,
    lastVideoResetAt,
    lastVideoResetReason,
    location: lastLocation,
    route: routePlayback.snapshot(),
    session: sessionRecorder.snapshot(),
    clientsDetail: Array.from(clients, (client) => ({
      id: client.id,
      frameMeta: client.frameMeta,
      sentFrames: client.sentFrames,
      droppedFrames: client.droppedFrames,
      backpressureEvents: client.backpressureEvents,
      bufferedBytes: client.socket.bufferedAmount,
      awaitingKeyFrame: client.awaitingKeyFrame,
    })),
    startedAt,
    stoppedAt,
    lastFrameAt: lastFrameMs > 0 ? new Date(lastFrameMs).toISOString() : null,
    lastError,
  });

  const closeClients = (code: number, reason: string) => {
    for (const c of clients) {
      try {
        c.socket.close(code, reason);
      } catch {}
    }
    clients.clear();
  };

  const markTerminal = (nextStatus: Exclude<SessionStatus, "streaming">, reason: string) => {
    if (status !== "streaming") return;
    status = nextStatus;
    lastError = reason;
    stoppedAt = new Date().toISOString();
    if (watchdog) clearInterval(watchdog);
    routePlayback.close();
    session.close();
    closeClients(nextStatus === "error" ? 1011 : 1000, reason);
  };

  const sendJson = (socket: StreamSocket, value: unknown) => {
    try {
      socket.send(JSON.stringify(value));
    } catch {}
  };

  const withFrameMeta = (
    frameData: Buffer,
    frame: { pts: bigint; isKey: boolean },
    config: Buffer | null,
  ): Buffer => {
    const configBytes = config?.length ?? 0;
    const out = Buffer.allocUnsafe(FRAME_META_HEADER_BYTES + configBytes + frameData.length);
    out.writeUInt32BE(FRAME_META_MAGIC, 0);
    out.writeUInt8(FRAME_META_VERSION, 4);
    out.writeUInt8(frame.isKey ? FRAME_FLAG_KEY : 0, 5);
    out.writeUInt16BE(0, 6);
    out.writeBigUInt64BE(frame.pts, 8);
    if (config) config.copy(out, FRAME_META_HEADER_BYTES);
    frameData.copy(out, FRAME_META_HEADER_BYTES + configBytes);
    return out;
  };

  const withConfig = (frameData: Buffer, config: Buffer | null): Buffer => {
    if (!config) return frameData;
    const out = Buffer.allocUnsafe(config.length + frameData.length);
    config.copy(out, 0);
    frameData.copy(out, config.length);
    return out;
  };

  const wantsAck = (value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
    return (value as Record<string, unknown>).ack !== false;
  };

  const isResetVideoRequest = (value: unknown) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "reset-video";

  const readJsonBody = async (req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<unknown> => {
    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) throw new Error("request body too large");
    return req.json();
  };

  const shouldRecord = (value: unknown) =>
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).record !== false;

  const dispatchGesture = async (gesture: Gesture, source: string, record = true) => {
    if (status !== "streaming") throw new Error(`session is ${status}`);
    await session.sendGesture(gesture);
    if (record) sessionRecorder.recordGesture(gesture, source);
  };

  const applyLocation = async (fix: GeoFix, source: string, record = true) => {
    routePlayback.stop();
    await setEmulatorLocationAsync(opts.serial, fix);
    lastLocation = { ...fix, appliedAt: new Date().toISOString() };
    if (record) sessionRecorder.recordLocation(fix, source);
    return lastLocation;
  };

  const resolvePackagePids = (packageName: string): Set<string> => {
    if (!/^[A-Za-z0-9_.:-]+$/.test(packageName)) return new Set();
    const r = spawnSync("adb", ["-s", opts.serial, "shell", "pidof", packageName], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (r.status !== 0) return new Set();
    return new Set(r.stdout.trim().split(/\s+/).filter(Boolean));
  };

  const logcatStream = (url: URL) => {
    const packageName = (url.searchParams.get("package") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES);
    const search = (url.searchParams.get("search") ?? "").trim().slice(0, MAX_LOGCAT_QUERY_BYTES).toLowerCase();
    const proc = spawn("adb", ["-s", opts.serial, "logcat", "-v", "threadtime"]);
    const encoder = new TextEncoder();
    let pidSet = packageName ? resolvePackagePids(packageName) : new Set<string>();
    let pidTimer: ReturnType<typeof setInterval> | null = null;
    let buffer = "";

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, value: unknown) => {
          try {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`),
            );
          } catch {}
        };
        const matches = (line: string) => {
          if (search && !line.toLowerCase().includes(search)) return false;
          if (!packageName) return true;
          const parts = line.trim().split(/\s+/, 5);
          const pid = parts[2];
          return (pid && pidSet.has(pid)) || line.includes(packageName);
        };
        const consume = (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line && matches(line)) send("log", { line, at: new Date().toISOString() });
          }
        };

        send("ready", {
          serial: opts.serial,
          package: packageName || null,
          pids: Array.from(pidSet),
          search: search || null,
        });
        if (packageName) {
          pidTimer = setInterval(() => {
            pidSet = resolvePackagePids(packageName);
          }, 5_000);
        }
        proc.stdout.on("data", consume);
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString("utf8").trim();
          if (text) send("error", { line: text, at: new Date().toISOString() });
        });
        proc.once("exit", (code, signal) => {
          send("close", { code, signal });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
        proc.once("error", (err) => {
          send("error", { line: err.message, at: new Date().toISOString() });
          try {
            controller.close();
          } catch {}
          if (pidTimer) clearInterval(pidTimer);
        });
      },
      cancel() {
        if (pidTimer) clearInterval(pidTimer);
        try {
          proc.kill("SIGTERM");
        } catch {}
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        // Allow a cross-origin client (e.g. the Expo Hub dashboard served from a
        // different dev-server port) to consume the logcat feed via EventSource.
        "Access-Control-Allow-Origin": "*",
      },
    });
  };

  const gestureEndpoint = async (req: Request, type: Gesture["type"], source: string) => {
    try {
      const payload = await readJsonBody(req);
      const gesture = parseGesture(
        typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? { ...payload, type }
          : payload,
      );
      await dispatchGesture(gesture, source, shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const keyEndpoint = async (req: Request) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("key payload must be an object");
      }
      const key = (payload as Record<string, unknown>).key;
      const gesture =
        key === "back" || key === "home" || key === "recents" || key === "power"
          ? parseGesture({ type: key })
          : parseGesture({ ...payload, type: "key" });
      await dispatchGesture(gesture, "rest:key", shouldRecord(payload));
      return Response.json({ ok: true });
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const appJsonEndpoint = async (
    req: Request,
    action: (payload: Record<string, unknown>) => unknown,
  ) => {
    try {
      const payload = await readJsonBody(req);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("payload must be an object");
      }
      const result = action(payload as Record<string, unknown>);
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const installEndpoint = async (req: Request) => {
    try {
      const form = await req.formData();
      const file = form.get("apk");
      if (!(file instanceof File)) throw new Error("multipart field apk must be a file");
      return Response.json(await installApk(opts.serial, file));
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const fileImportEndpoint = async (req: Request) => {
    try {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("multipart field file must be a file");
      return Response.json(await importMediaFile(opts.serial, file));
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      );
    }
  };

  const requestVideoReset = (reason: string) => {
    const now = Date.now();
    if (now - lastVideoResetMs < VIDEO_RESET_COOLDOWN_MS) return;
    lastVideoResetMs = now;
    videoResetRequests++;
    lastVideoResetAt = new Date(now).toISOString();
    lastVideoResetReason = reason;
    try {
      session.resetVideo();
    } catch {}
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    console.warn(
      `client ${client.id} backpressure: dropping frames until keyframe (buffered ${client.socket.bufferedAmount} B, ${client.droppedFrames} dropped)`,
    );
    requestVideoReset("client backpressure");
  };

  const sendFrame = (client: Client, data: Buffer, isKeyFrame: boolean) => {
    if (client.awaitingKeyFrame) {
      if (!isKeyFrame) {
        client.droppedFrames++;
        totalDroppedFrames++;
        return;
      }
      client.awaitingKeyFrame = false;
    }

    const buffered = client.socket.bufferedAmount;
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      console.warn(
        `client ${client.id} too slow: closing (buffered ${buffered} B > ${CLOSE_CLIENT_BUFFERED_BYTES} B, ${client.droppedFrames} dropped)`,
      );
      clients.delete(client);
      try {
        client.socket.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    client.socket.send(data);
    client.sentFrames++;
  };
  // Cache the SPS+PPS bytes that scrcpy emits as a standalone "config" packet
  // and inline them in front of every keyframe so each WS message is a
  // self-contained Access Unit the browser can hand straight to WebCodecs.
  let cachedConfig: Buffer | null = null;

  (async () => {
    try {
      while (!stopRequested) {
        const f = await session.readFrame();
        if (!f) {
          if (!stopRequested) markTerminal("error", "video stream ended");
          break;
        }
        if (f.isConfig) {
          cachedConfig = f.data;
          configPacketCount++;
          continue;
        }
        frameCount++;
        lastFrameMs = Date.now();
        const config = f.isKey ? cachedConfig : null;
        let rawOut: Buffer | null = null;
        let framedOut: Buffer | null = null;
        for (const c of clients) {
          if (c.awaitingKeyFrame && !f.isKey) {
            c.droppedFrames++;
            totalDroppedFrames++;
            continue;
          }
          const out = c.frameMeta
            ? (framedOut ??= withFrameMeta(f.data, f, config))
            : (rawOut ??= withConfig(f.data, config));
          sendFrame(c, out, f.isKey);
        }
      }
    } catch (err) {
      if (!stopRequested) markTerminal("error", String(err));
    }
  })();

  watchdog = setInterval(() => {
    sourceFps = frameCount - lastFpsFrameCount;
    lastFpsFrameCount = frameCount;
    if (status !== "streaming" || clients.size === 0) return;
    const lastFrameSeenMs = lastFrameMs || startedMs;
    if (Date.now() - lastFrameSeenMs > STALE_VIDEO_RESET_MS) {
      requestVideoReset("source stream stalled");
    }
  }, 1000);

  session.onFatal((reason) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", reason);
    }
  });

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/api") {
      return Response.json({
        serial: opts.serial,
        device: session.meta.deviceName,
        transport: session.transport,
        codec: session.meta.codecId,
        size: { width: session.meta.width, height: session.meta.height },
        status,
        clients: clients.size,
      });
    }

    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({
          ok: true,
          currentSerial: opts.serial,
          devices: listAllDevices().map((device) => ({
            ...device,
            current: device.serial === opts.serial,
          })),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/health") {
      return Response.json(health(), { status: status === "streaming" ? 200 : 503 });
    }

    if (url.pathname === "/api/logcat") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      return logcatStream(url);
    }

    if (url.pathname === "/api/screenshot") {
      if (req.method !== "GET" && req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        const png = screencapPng(opts.serial);
        if (url.searchParams.get("format") === "base64") {
          return Response.json({
            ok: true,
            mimeType: "image/png",
            data: png.toString("base64"),
          });
        }
        return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/foreground") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json({ ok: true, app: getForegroundApp(opts.serial) });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/accessibility") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return Response.json(getAccessibilitySnapshot(opts.serial));
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/uimode") {
      if (req.method === "GET") {
        try {
          return Response.json({ ok: true, night: getNightMode(opts.serial) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "POST") {
        try {
          const payload = await readJsonBody(req);
          const night =
            typeof payload === "object" && payload !== null && !Array.isArray(payload)
              ? (payload as Record<string, unknown>).night
              : undefined;
          if (!isNightMode(night)) {
            throw new Error('night must be one of "yes", "no", or "auto"');
          }
          return Response.json({ ok: true, night: setNightMode(opts.serial, night) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/tap") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "tap", "rest:tap");
    }

    if (url.pathname === "/api/swipe") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "swipe", "rest:swipe");
    }

    if (url.pathname === "/api/text") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return gestureEndpoint(req, "text", "rest:text");
    }

    if (url.pathname === "/api/key") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return keyEndpoint(req);
    }

    if (url.pathname === "/api/session") {
      if (req.method === "GET") return Response.json(sessionRecorder.snapshot());
      if (req.method === "DELETE") return Response.json({ ok: true, session: sessionRecorder.clear() });
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/session/replay") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        const multiplier =
          typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? Number((payload as Record<string, unknown>).multiplier ?? 1)
            : 1;
        const replay = sessionRecorder.replay(
          {
            dispatchGesture: (gesture) => dispatchGesture(gesture, "session:replay", false),
            setLocation: async (fix) => {
              await applyLocation(fix, "session:replay", false);
            },
          },
          multiplier,
        );
        void replay.catch(() => {});
        return Response.json({ ok: true, session: sessionRecorder.snapshot() });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    if (url.pathname === "/api/session/replay/stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return Response.json({ ok: true, session: sessionRecorder.stopReplay() });
    }

    if (url.pathname === "/api/apps/install") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return installEndpoint(req);
    }

    if (url.pathname === "/api/files/import") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return fileImportEndpoint(req);
    }

    if (url.pathname === "/api/apps/launch") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        launchApp(
          opts.serial,
          String(payload.packageName ?? ""),
          typeof payload.activity === "string" && payload.activity.trim()
            ? payload.activity
            : undefined,
        ),
      );
    }

    if (url.pathname === "/api/apps/clear") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        clearAppData(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/force-stop") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        forceStopApp(opts.serial, String(payload.packageName ?? "")),
      );
    }

    if (url.pathname === "/api/apps/grant") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      return appJsonEndpoint(req, (payload) =>
        grantPermission(
          opts.serial,
          String(payload.packageName ?? ""),
          String(payload.permission ?? ""),
        ),
      );
    }

    if (url.pathname === "/api/location") {
      if (req.method === "GET") {
        return Response.json({
          serial: opts.serial,
          emulator: /^emulator-\d+$/.test(opts.serial),
          location: lastLocation,
        });
      }
      if (req.method === "POST") {
        try {
          const fix = parseGeoFix(await readJsonBody(req));
          lastLocation = await applyLocation(fix, "rest:location");
          return Response.json({ ok: true, location: lastLocation });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route") {
      if (req.method === "GET") {
        return Response.json(routePlayback.snapshot());
      }
      if (req.method === "POST") {
        try {
          const route = parseRoutePlaybackRequest(await readJsonBody(req, MAX_ROUTE_BODY_BYTES));
          return Response.json({ ok: true, route: await routePlayback.start(route) });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          );
        }
      }
      if (req.method === "DELETE") {
        return Response.json({ ok: true, route: routePlayback.stop() });
      }
      return new Response("method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/route/control") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        const payload = await readJsonBody(req);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("control payload must be an object");
        }
        const action = (payload as Record<string, unknown>).action;
        if (action === "pause") return Response.json({ ok: true, route: routePlayback.pause() });
        if (action === "resume") return Response.json({ ok: true, route: routePlayback.resume() });
        if (action === "stop") return Response.json({ ok: true, route: routePlayback.stop() });
        throw new Error("action must be pause, resume, or stop");
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 400 },
        );
      }
    }

    return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
  };

  /**
   * Register a freshly-connected video/gesture client. The caller owns the
   * transport upgrade and passes a {@link StreamSocket} plus the `frame-meta`
   * flag (whether to prefix each frame with the SEMU metadata header).
   */
  const attachWebSocket = (socket: StreamSocket, meta: { frameMeta: boolean }): void => {
    if (status !== "streaming") {
      socket.close(1013, `session is ${status}`);
      return;
    }
    const client: Client = {
      id: nextClientId++,
      socket,
      frameMeta: meta.frameMeta,
      sentFrames: 0,
      droppedFrames: 0,
      backpressureEvents: 0,
      awaitingKeyFrame: true,
    };
    clients.add(client);
    requestVideoReset("client opened");

    socket.onMessage((raw) => {
      if (raw.length > MAX_WS_MESSAGE_BYTES) {
        socket.close(1009, "message too large");
        return;
      }
      try {
        if (status !== "streaming") throw new Error(`session is ${status}`);
        const payload = JSON.parse(raw);
        const acknowledge = wantsAck(payload);
        if (isResetVideoRequest(payload)) {
          requestVideoReset("client requested keyframe");
          if (acknowledge) sendJson(socket, { ok: true });
          return;
        }
        const msg = parseGesture(payload);
        void dispatchGesture(msg, "ws", shouldRecord(payload))
          .then(() => {
            if (acknowledge) sendJson(socket, { ok: true });
          })
          .catch((err) => sendJson(socket, { ok: false, error: String(err) }));
      } catch (err) {
        sendJson(socket, { ok: false, error: String(err) });
      }
    });

    socket.onClose(() => {
      clients.delete(client);
    });
  };

  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (status === "streaming") {
      status = "stopped";
      stoppedAt = new Date().toISOString();
    }
    closeClients(1001, "server stopping");
    if (watchdog) clearInterval(watchdog);
    routePlayback.close();
    session.close();
  };

  return {
    session,
    isStreaming: () => status === "streaming",
    health,
    handleRequest,
    attachWebSocket,
    stop,
  };
}

export type EmuApp = Awaited<ReturnType<typeof createApp>>;

export type RouterDefaults = Partial<AppOptions>;

/**
 * Multi-device router. Owns a lazily-populated `Map<serial, EmuApp>` and routes
 * each request to the app for its `?device=<serial>` query (falling back to the
 * first available device when absent). The UI shell and the `/api/devices`
 * fleet listing are served without requiring any device. Both `server.ts` (Bun)
 * and the Expo DevTools plugin mount this onto their own transport, so the
 * device-routing logic lives here once rather than in each transport.
 */
export function createRouter(defaults: RouterDefaults = {}) {
  const apps = new Map<string, EmuApp>();
  const pending = new Map<string, Promise<EmuApp>>();
  const failureAt = new Map<string, number>();

  // Resolve the serial a request targets: an explicit (connected) `?device=`,
  // else the configured default if still attached, else the first online
  // device. Throws only when *no* device is attached — multiple devices is
  // never an error (we just take the first), so the UI always opens cleanly.
  const resolveSerial = (requested?: string | null): string => {
    const online = listDevices();
    if (requested) {
      if (!online.some((d) => d.serial === requested)) {
        throw new Error(`device ${requested} is not connected`);
      }
      return requested;
    }
    if (defaults.serial && online.some((d) => d.serial === defaults.serial)) {
      return defaults.serial;
    }
    const first = online[0];
    if (!first) {
      throw new Error("No booted Android device found. Start an emulator or attach a device.");
    }
    return first.serial;
  };

  // Get (or lazily start) the app for a serial. A dead session is torn down so
  // the next call re-initializes; repeated start failures are throttled.
  const getApp = (serial: string): Promise<EmuApp> => {
    const existing = apps.get(serial);
    if (existing) {
      if (existing.isStreaming()) return Promise.resolve(existing);
      try {
        existing.stop();
      } catch {}
      apps.delete(serial);
    }
    const inFlight = pending.get(serial);
    if (inFlight) return inFlight;
    if (Date.now() - (failureAt.get(serial) ?? 0) < SPAWN_RETRY_COOLDOWN_MS) {
      return Promise.reject(
        new Error(`serve-emu start for ${serial} is cooling down after a failure`),
      );
    }
    const promise = (async () => {
      const created = await createApp({ ...defaults, serial });
      apps.set(serial, created);
      return created;
    })();
    pending.set(serial, promise);
    promise.then(
      () => pending.delete(serial),
      () => {
        pending.delete(serial);
        failureAt.set(serial, Date.now());
      },
    );
    return promise;
  };

  // Resolve + start in one step.
  const ensure = async (requested?: string | null): Promise<{ serial: string; app: EmuApp }> => {
    const serial = resolveSerial(requested);
    return { serial, app: await getApp(serial) };
  };

  const devicesResponse = (): Response => {
    let defaultSerial: string | null = null;
    try {
      defaultSerial = resolveSerial(null);
    } catch {
      defaultSerial = null;
    }
    return Response.json({
      ok: true,
      defaultSerial,
      devices: listAllDevices().map((device) => ({
        ...device,
        streaming: apps.get(device.serial)?.isStreaming() ?? false,
      })),
    });
  };

  const handleRequest = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Fleet endpoint — lists every adb device, so it is not device-scoped.
    if (url.pathname === "/api/devices") {
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      try {
        return devicesResponse();
      } catch (err) {
        return Response.json({ ok: false, error: errMsg(err) }, { status: 400 });
      }
    }

    // Device-scoped endpoints are `/api`, `/api/*` (other than the fleet listing
    // handled above), and `/health`. Everything else is the device-independent
    // UI shell — serve it (and its 404s) without starting a device, so the page
    // loads before one is selected or attached.
    const deviceScoped =
      url.pathname === "/api" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/health";
    if (!deviceScoped) {
      return serveStaticFile(url.pathname) ?? new Response("not found", { status: 404 });
    }

    // Everything else operates on a single device.
    let app: EmuApp;
    try {
      app = (await ensure(url.searchParams.get("device"))).app;
    } catch (err) {
      return Response.json({ ok: false, error: errMsg(err) }, { status: 503 });
    }
    return app.handleRequest(req);
  };

  // Attach a video/gesture socket to an already-resolved, already-started
  // device. The transport ensures the serial before upgrading and passes it
  // here, so the app should exist; close defensively if it raced away.
  const attachWebSocket = (
    socket: StreamSocket,
    opts: { serial: string; frameMeta: boolean },
  ): void => {
    const app = apps.get(opts.serial);
    if (!app) {
      socket.close(1011, "device not ready");
      return;
    }
    app.attachWebSocket(socket, { frameMeta: opts.frameMeta });
  };

  const stopAll = () => {
    for (const app of apps.values()) {
      try {
        app.stop();
      } catch {}
    }
    apps.clear();
  };

  return { resolveSerial, getApp, ensure, handleRequest, attachWebSocket, stopAll };
}

export type EmuRouter = ReturnType<typeof createRouter>;
