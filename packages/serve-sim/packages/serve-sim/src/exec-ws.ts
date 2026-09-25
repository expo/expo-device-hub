import { MAX_CAMERA_FRAME_BYTES } from "./camera-frames";
import {
  messageToString,
  requestHost,
  type SseRequestHandler,
} from "./exec-ws-utils";
import { isWebOrigin, originMatches, type UpgradeHandlerWebSocket } from "./middleware-utils";
import { InvalidHostActionError, runHostActionAsync } from "./host-actions";
import {
  TOKEN_SUBPROTOCOL_PREFIX,
  acceptedTokenSubprotocol,
  safeEqualString,
} from "./session-auth";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries typed simulator actions, simulator-settings requests, and multiplexed SSE
// subscriptions, so each tab needs just one pooled connection (the video
// stream) plus this socket.
//
// The middleware owns the protocol below, but not the HTTP upgrade. Hosts pass
// an already-accepted websocket into `handleWebSocket`; the bundled Node
// runtime does that with `ws`, while other web runtimes can provide their own
// socket object with the same small shape.
//
// Wire protocol (all JSON text frames):
//   client → {token}                  first frame, when no token subprotocol was offered
//   server → {ready:true}             auth accepted
//   client → {id, action, params}      run one typed simulator action
//   server → {id, stdout, stderr, exitCode}
//   client → {id, ui:{…}}             simulator-settings request (in-process,
//   server → {id, …} | {id, error}     no shell round-trip)
//   client → {sub, path}              subscribe to a same-origin SSE route
//   server → {sub, data}              raw SSE bytes for that subscription
//   server → {sub, end:true}          upstream closed
//   client → {unsub: sub}             cancel a subscription
//
// Binary camera frames: opcode 1, one-byte UDID length, UTF-8 UDID, encoded JPEG.
// Opcode 2 uses the same header without a payload to stop this socket’s feed.
// Frames are dropped when the helper cannot keep up; they have no replies.

const AUTH_TIMEOUT_MS = 10_000;
// A shareable link must not spawn unbounded work: a subscription holds a stream or watcher and an
// action spawns a process, so both are capped per socket.
const MAX_SUBSCRIPTIONS_PER_SOCKET = 16;
const MAX_ACTIONS_IN_FLIGHT_PER_SOCKET = 8;

const MAX_STOPPED_CAMERAS_PER_SOCKET = 64;
const BINARY_CAMERA_FRAME = 1;
const BINARY_CAMERA_STOP = 2;
const BINARY_DEVICE_BYTES = 36;

export interface BinaryCameraFrame {
  udid: string;
  frame: Buffer;
}

function binaryCameraDevice(data: Buffer): string | null {
  if (data.length < 2 + BINARY_DEVICE_BYTES || data[1] !== BINARY_DEVICE_BYTES) return null;
  const udid = data.toString("utf8", 2, 2 + BINARY_DEVICE_BYTES);
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(udid) ? udid : null;
}

export function parseBinaryCameraFrame(data: Buffer): BinaryCameraFrame | null {
  if (data[0] !== BINARY_CAMERA_FRAME) return null;
  const frameStart = 2 + BINARY_DEVICE_BYTES;
  if (data.length <= frameStart || data.length - frameStart > MAX_CAMERA_FRAME_BYTES) return null;
  const udid = binaryCameraDevice(data);
  return udid ? { udid, frame: data.subarray(frameStart) } : null;
}

interface ExecMessage {
  token?: string;
  id?: number;
  action?: string;
  params?: unknown;
  ui?: unknown;
  sub?: number;
  path?: string;
  unsub?: number;
}

/** In-process handler for `{id, ui}` requests; resolves to the reply body. */
export type UiRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;
export type ActionResultHandler = (
  action: string,
  params: Record<string, unknown> | undefined,
  result: { stdout: string; stderr: string; exitCode: number },
  // Null once the socket closed: it can no longer send frames, so it must not claim the feed.
  owner: symbol | null,
) => void;

interface ExecChannelOptions {
  path: string;
  execToken: string;
  /** Origins passed to `--cors-origin`. Loopback is not implied here, unlike the CORS policy. */
  corsOrigins?: readonly string[];
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
  onActionResult?: ActionResultHandler;
  /** False means ownership was lost; temporary delivery drops still return true. */
  onCameraFrame?: (udid: string, frame: Buffer, owner: symbol) => boolean;
  /** May run again after an in-flight action finishes; releasing ownership must be idempotent. */
  onCameraClose?: (owner: symbol) => void;
  onCameraStop?: (udid: string, owner: symbol) => void;
  /** Routes an authenticated subscription back through the owning middleware. */
  onSseRequest?: SseRequestHandler;
  serveSimBinPath?: string;
}

function wireExecSocket(
  ws: UpgradeHandlerWebSocket,
  request: Request,
  opts: ExecChannelOptions,
  runAction: typeof runHostActionAsync,
): void {
  let closed = false;
  const cameraOwner = Symbol("camera socket");
  const stoppedCameras = new Set<string>();
  const subscriptions = new Map<number, { destroy: () => void }>();
  let actionsInFlight = 0;
  // A ui request spawns simctl or ax just as an action does, so both draw on the same ceiling.
  const reserveAction = (id: unknown): boolean => {
    if (actionsInFlight >= MAX_ACTIONS_IN_FLIGHT_PER_SOCKET) {
      send({ id, error: "too many actions in flight on this connection" });
      return false;
    }
    actionsInFlight += 1;
    return true;
  };
  const ssePrefixes = opts.ssePrefixes ?? [];

  const send = (value: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };

  const offered = request.headers.get("sec-websocket-protocol") ?? undefined;
  let authed = acceptedTokenSubprotocol({ "sec-websocket-protocol": offered }, opts.execToken) !== null;
  if (!authed && offered?.includes(TOKEN_SUBPROTOCOL_PREFIX)) {
    ws.close();
    return;
  }

  const authTimer = setTimeout(() => {
    if (!authed) ws.close();
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();
  if (authed) {
    clearTimeout(authTimer);
    send({ ready: true });
  }

  const subscribe = (sub: number, path: string) => {
    // Every other refusal answers; a silent one leaves the client's subscription pending forever.
    if (subscriptions.has(sub)) {
      send({ sub, end: true, error: "subscription id already in use on this connection" });
      return;
    }
    if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      send({ sub, end: true, error: "too many subscriptions on this connection" });
      return;
    }
    // Only this middleware's own SSE routes, and only for an authed socket.
    const pathOnly = path.split("?")[0]!;
    if (!path.startsWith("/") || !ssePrefixes.some((p) => pathOnly === p)) {
      send({ sub, end: true, error: "path not allowed" });
      return;
    }
    if (!opts.onSseRequest) {
      send({ sub, end: true, error: "sse requests not supported" });
      return;
    }

    let active = true;
    let endSent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const sendEnd = (error?: string) => {
      if (endSent) return;
      endSent = true;
      send(error ? { sub, end: true, error } : { sub, end: true });
    };
    const subscription = {
      destroy() {
        active = false;
        void reader?.cancel().catch(() => {});
      },
    };
    subscriptions.set(sub, subscription);

    void (async () => {
      try {
        const response = await opts.onSseRequest!(path, request);
        if (!active) {
          // `reader` was never taken, and cancelling the body is the only thing that tells the
          // route to tear down: a subrequest here has no socket whose close it could notice.
          void response?.body?.cancel().catch(() => {});
          return;
        }
        if (!response?.body) {
          sendEnd();
          return;
        }
        const textDecoder = new TextDecoder();
        reader = response.body.getReader();
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          send({ sub, data: textDecoder.decode(value, { stream: true }) });
        }

        // Flush bytes held back mid-multibyte-sequence when the stream ends.
        if (active) {
          const tail = textDecoder.decode();
          if (tail) send({ sub, data: tail });
        }
      } catch {
        if (active) sendEnd();
        return;
      } finally {
        active = false;
        if (reader) {
          try { reader.releaseLock(); } catch {}
        }
        if (subscriptions.get(sub) === subscription) {
          subscriptions.delete(sub);
          sendEnd();
        }
      }
    })();
  };

  ws.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (!authed) return;
      const packet = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (packet[0] === BINARY_CAMERA_STOP && packet.length === 2 + BINARY_DEVICE_BYTES) {
        const udid = binaryCameraDevice(packet);
        if (udid) opts.onCameraStop?.(udid, cameraOwner);
        return;
      }
      const parsed = parseBinaryCameraFrame(packet);
      if (parsed && opts.onCameraFrame?.(parsed.udid, parsed.frame, cameraOwner) === false &&
          !stoppedCameras.has(parsed.udid)) {
        if (stoppedCameras.size === MAX_STOPPED_CAMERAS_PER_SOCKET) {
          ws.close();
          return;
        }
        stoppedCameras.add(parsed.udid);
        send({ cameraStopped: parsed.udid });
      }
      return;
    }
    let msg: ExecMessage;
    try {
      msg = JSON.parse(messageToString(data)) as ExecMessage;
    } catch {
      return;
    }
    if (!authed) {
      if (typeof msg.token === "string" && safeEqualString(msg.token, opts.execToken)) {
        authed = true;
        clearTimeout(authTimer);
        send({ ready: true });
      } else {
        ws.close();
      }
      return;
    }
    if (typeof msg.unsub === "number") {
      subscriptions.get(msg.unsub)?.destroy();
      subscriptions.delete(msg.unsub);
      return;
    }
    if (typeof msg.sub === "number" && typeof msg.path === "string") {
      subscribe(msg.sub, msg.path);
      return;
    }
    if (typeof msg.id === "number" && msg.ui !== undefined) {
      const { id } = msg;
      if (!opts.onUiRequest) {
        send({ id, error: "ui requests not supported" });
        return;
      }
      if (!reserveAction(id)) return;
      opts
        .onUiRequest(msg.ui)
        .then((reply) => send({ id, ...reply }))
        .catch((e: unknown) => send({ id, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          actionsInFlight -= 1;
        });
      return;
    }
    if (typeof msg.id !== "number") {
      return;
    }
    if (typeof msg.action !== "string") {
      // The client keeps a pending promise per id with no timeout, so an unanswered frame hangs it.
      send({ id: msg.id, error: "unsupported request" });
      return;
    }
    const { id, action } = msg;
    if (!reserveAction(id)) return;
    const params = msg.params as Record<string, unknown> | undefined;
    runAction(msg, opts.serveSimBinPath ?? "serve-sim")
      .then((result) => {
        try {
          opts.onActionResult?.(action, params, result, closed ? null : cameraOwner);
          if (result.exitCode === 0 && params?.source === "stream" && typeof params.udid === "string" &&
              (action === "camera.inject" || action === "camera.switch")) {
            stoppedCameras.delete(params.udid);
          }
        } catch (e) {
          console.error("serve-sim action result hook failed:", e);
        }
        send({ id, ...result });
      })
      .catch((e: unknown) => {
        if (!(e instanceof InvalidHostActionError)) {
          console.error(`serve-sim action ${action} failed:`, e);
        }
        send({ id, error: e instanceof InvalidHostActionError ? e.message : "action failed" });
      })
      .finally(() => {
        actionsInFlight -= 1;
      });
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    opts.onCameraClose?.(cameraOwner);
    clearTimeout(authTimer);
    for (const sub of subscriptions.values()) sub.destroy();
    subscriptions.clear();
  };
  ws.on("error", () => {
    cleanup();
    ws.close();
  });
  ws.on("close", cleanup);
}

function isAllowedExecOrigin(
  origin: string,
  request: Request,
  corsOrigins: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!isWebOrigin(parsed)) return false;
  if (parsed.host === requestHost(request)) return true;
  return corsOrigins.some((allowed) => originMatches(allowed, parsed));
}

/**
 * Websocket handler for `<basePath>/exec-ws`. Returns true when the request was
 * for the exec channel, false when the caller should close or route it.
 */
export function createExecWebSocketHandler(opts: ExecChannelOptions) {
  const cameraActions = new Map<string, Promise<void>>();
  const runAction: typeof runHostActionAsync = (msg, binPath) => {
    const { action, params } = msg;
    const udid = params && typeof params === "object" && "udid" in params ? params.udid : null;
    if ((action !== "camera.inject" && action !== "camera.switch" && action !== "camera.stopWebcam") ||
        typeof udid !== "string") {
      return runHostActionAsync(msg, binPath);
    }
    const result = (cameraActions.get(udid) ?? Promise.resolve())
      .then(() => runHostActionAsync(msg, binPath));
    const settled = result.then(() => {}, () => {});
    cameraActions.set(udid, settled);
    void settled.then(() => {
      if (cameraActions.get(udid) === settled) cameraActions.delete(udid);
    });
    return result;
  };
  return function handleWebSocket(request: Request, websocket: UpgradeHandlerWebSocket): boolean {
    const url = new URL(request.url);
    if (url.pathname !== opts.path && url.pathname !== `${opts.path}/`) return false;

    // Browsers always send Origin on upgrades, so this keeps another site's page off the channel.
    const origin = request.headers.get("origin");
    if (origin && !isAllowedExecOrigin(origin, request, opts.corsOrigins ?? [])) {
      websocket.close();
      return true;
    }

    wireExecSocket(websocket, request, opts, runAction);
    return true;
  };
}
