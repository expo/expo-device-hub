import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ServerWebSocket } from "bun";
import { listAllDevices, screencapPng } from "./adb.ts";
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
import { startScrcpy, type ScrcpySession } from "./scrcpy.ts";
import { dispatch, parseGesture, resetVideoPacket, type Gesture, type Screen } from "./input.ts";
import { parseGeoFix, setEmulatorLocationAsync, type GeoFix } from "./location.ts";
import { parseRoutePlaybackRequest, RoutePlayback } from "./route-playback.ts";
import { SessionRecorder } from "./session-recorder.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(__dirname, "..", "dist", "ui");

export type ServerOpts = {
  serial: string;
  port: number;
  maxFps?: number;
  bitRate?: number;
  maxSize?: number;
  keyFrameInterval?: number;
};

type SessionStatus = "streaming" | "stopped" | "error";

type WsData = { id: number; frameMeta: boolean; handle?: Client };

type Client = {
  id: number;
  ws: ServerWebSocket<WsData>;
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

export async function startServer(opts: ServerOpts) {
  const session: ScrcpySession = await startScrcpy({
    serial: opts.serial,
    maxFps: opts.maxFps,
    bitRate: opts.bitRate,
    maxSize: opts.maxSize,
    keyFrameInterval: opts.keyFrameInterval,
  });
  console.log(
    `scrcpy ready: ${session.meta.deviceName} • ${session.meta.codecId} • ${session.meta.width}×${session.meta.height}`,
  );

  const clients = new Set<Client>();
  const screen: Screen = { width: session.meta.width, height: session.meta.height };
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
      bufferedBytes: client.ws.getBufferedAmount(),
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
        c.ws.close(code, reason);
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

  const sendJson = (ws: ServerWebSocket<WsData>, value: unknown) => {
    try {
      ws.send(JSON.stringify(value));
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
    await dispatch(session.controlSocket, gesture, screen);
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
      session.controlSocket.write(resetVideoPacket());
    } catch {}
  };

  const dropUntilKeyFrame = (client: Client) => {
    client.droppedFrames++;
    totalDroppedFrames++;
    client.awaitingKeyFrame = true;
    console.warn(
      `client ${client.id} backpressure: dropping frames until keyframe (buffered ${client.ws.getBufferedAmount()} B, ${client.droppedFrames} dropped)`,
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

    const buffered = client.ws.getBufferedAmount();
    if (buffered > CLOSE_CLIENT_BUFFERED_BYTES) {
      console.warn(
        `client ${client.id} too slow: closing (buffered ${buffered} B > ${CLOSE_CLIENT_BUFFERED_BYTES} B, ${client.droppedFrames} dropped)`,
      );
      clients.delete(client);
      try {
        client.ws.close(1013, "client too slow");
      } catch {}
      return;
    }
    if (buffered > DROP_FRAME_BUFFERED_BYTES) {
      dropUntilKeyFrame(client);
      return;
    }
    const sent = client.ws.send(data);
    if (sent === -1) {
      client.backpressureEvents++;
      totalBackpressureEvents++;
      dropUntilKeyFrame(client);
      return;
    }
    if (sent === 0) {
      clients.delete(client);
      return;
    }
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
          if (!stopRequested) markTerminal("error", "scrcpy video stream ended");
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

  session.proc.once("exit", (code, signal) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
    }
  });
  session.controlSocket.once("error", (err) => {
    if (!stopRequested && status === "streaming") {
      markTerminal("error", `scrcpy control socket error: ${err.message}`);
    }
  });

  let nextId = 1;
  const server = Bun.serve<WsData>({
    port: opts.port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      if (url.pathname === "/api") {
        return Response.json({
          serial: opts.serial,
          device: session.meta.deviceName,
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

      if (url.pathname === "/ws") {
        if (status !== "streaming") {
          return new Response(JSON.stringify(health()), {
            status: 503,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        const frameMeta = url.searchParams.get("frame-meta") === "1";
        const ok = srv.upgrade(req, { data: { id: nextId++, frameMeta } });
        if (ok) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }

      const reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
      if (reqPath.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(join(UI_DIR, reqPath));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const handle: Client = {
          id: ws.data.id,
          ws,
          frameMeta: ws.data.frameMeta,
          sentFrames: 0,
          droppedFrames: 0,
          backpressureEvents: 0,
          awaitingKeyFrame: true,
        };
        clients.add(handle);
        ws.data.handle = handle;
        requestVideoReset("client opened");
      },
      message(ws, raw) {
        if (typeof raw !== "string") return;
        if (raw.length > MAX_WS_MESSAGE_BYTES) {
          ws.close(1009, "message too large");
          return;
        }
        try {
          if (status !== "streaming") throw new Error(`session is ${status}`);
          const payload = JSON.parse(raw);
          const acknowledge = wantsAck(payload);
          if (isResetVideoRequest(payload)) {
            requestVideoReset("client requested keyframe");
            if (acknowledge) sendJson(ws, { ok: true });
            return;
          }
          const msg = parseGesture(payload);
          void dispatchGesture(msg, "ws", shouldRecord(payload))
            .then(() => {
              if (acknowledge) sendJson(ws, { ok: true });
            })
            .catch((err) => sendJson(ws, { ok: false, error: String(err) }));
        } catch (err) {
          sendJson(ws, { ok: false, error: String(err) });
        }
      },
      close(ws) {
        if (ws.data.handle) clients.delete(ws.data.handle);
      },
    },
  });

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
    server.stop(true);
    session.close();
  };

  return { server, session, stop };
}

export type StartedServer = Awaited<ReturnType<typeof startServer>>;
export type { ScrcpySession };
