/**
 * In-process device session — the replacement for the spawned serve-sim-bin
 * helper. One session per booted simulator owns a NativeCapture + NativeHid and
 * serves the same wire endpoints the helper's HTTP server did, byte-for-byte:
 *
 *   /stream.mjpeg  multipart/x-mixed-replace JPEG fan-out (?raw=1 → octet-stream)
 *   /stream.avcc   length-prefixed AVCC envelopes (seed + decoder config replay)
 *   /stream-settings runtime encoder configuration
 *   /ws            binary HID input protocol ([tag][JSON]) → NativeHid
 *   /config        { width, height, orientation }
 *   /health        { status: "ok" }
 *   /ax            axe-shaped accessibility JSON (one-shot)
 *   /foreground    { bundleId, pid }
 *
 * Replaces the helper's HTTP/client layer; the framing here mirrors the
 * original byte-for-byte so the existing browser client is unchanged.
 */
import type { IncomingMessage, ServerResponse } from "http";
import {
  NativeCapture,
  NativeHid,
  Orientation,
  axDescribeAsync,
  axFrontmostAsync,
  type MjpegFrame,
  type NativeScreenInfo,
  type NativeUnsubscribe,
} from "./native";
import { isSoftwareKeyboardVisible } from "./ax";
import { debugKeyboard } from "./debug";
import { isHingeAngle, type HingeAngleResult } from "./hinge-angle";
import { validatePanelRoute } from "./panel-route";
import { isHingeControlCommand, hingeControlState, hingePoseOrientation, isTableModeAvailable, type HingeControlCommand, type HingePose, type HingePhysicalOrientation } from "./hinge-control";
import { clearDeviceOptionState, setUiOption } from "./ui-settings";
import { eventLogEventForHidMessage, formatEventLogPoint, recordEventLogEvent, updateEventLogEvent } from "./event-log";
import {
  MAX_WEBRTC_SIGNALING_BODY_BYTES,
  WebRtcSignalingError,
  parseWebRtcCloseRequest,
  parseWebRtcOffer,
  parseWebRtcStatsSessionId,
} from "./webrtc-signaling";
import {
  normalizeStreamEncoderSettings,
  parseStreamEncoderSettingsPatch,
  streamControlSettingsFrom,
  streamEncoderSettingsFrom,
  streamEncoderSettingsForTransport,
  type StreamEncoderSettings,
  type StreamPlaybackSettings,
  type StreamSettings,
} from "./stream-settings";

/**
 * Minimal WebSocket surface the HID input channel needs. Satisfied by both the
 * `ws` library and the raw-socket adapter the middleware uses under Bun (where
 * `ws`'s server-side handshake doesn't flush). Messages arrive as binary
 * `[tag][JSON]` frames; `send` writes a binary frame.
 */
export interface HidSocket {
  send(data: Buffer): void;
  on(event: "message", cb: (data: Buffer) => void): void;
  on(event: "close" | "error", cb: () => void): void;
  close(): void;
}

// AVCC seed tag (StreamFormat.AVCCEnvelope.seedTag). description/keyframe/delta
// envelopes are framed natively; only the on-connect JPEG seed is built here.
const AVCC_SEED_TAG = 0x04;

// WS server→client screen-config push (ClientManager.wsMsgConfig).
const WS_MSG_CONFIG = 0x82;

const MJPEG_TRAILER = Buffer.from("\r\n", "ascii");
const TOUCH_TAP_MAX_DISTANCE = 0.004;

type TouchGestureLog = {
  eventId?: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moveCount: number;
  edge?: number;
};

function touchGestureSummary(gesture: TouchGestureLog): string {
  return `Drag ${formatEventLogPoint(gesture.startX, gesture.startY)} -> ${formatEventLogPoint(gesture.lastX, gesture.lastY)}`;
}

function touchGestureMoved(gesture: TouchGestureLog): boolean {
  const dx = gesture.lastX - gesture.startX;
  const dy = gesture.lastY - gesture.startY;
  return Math.hypot(dx, dy) > TOUCH_TAP_MAX_DISTANCE;
}

function newTouchGesture(payload: { x: number; y: number; edge?: number }): TouchGestureLog {
  return {
    startX: payload.x,
    startY: payload.y,
    lastX: payload.x,
    lastY: payload.y,
    moveCount: 0,
    edge: payload.edge,
  };
}

function mjpegHeader(jpegLength: number): Buffer {
  return Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpegLength}\r\n\r\n`, "ascii");
}

function avccSeed(jpeg: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(5 + jpeg.length);
  out.writeUInt32BE(jpeg.length + 1, 0); // length covers the tag byte + payload
  out[4] = AVCC_SEED_TAG;
  out.set(jpeg, 5);
  return out;
}

const ORIENTATION_BY_NAME: Record<string, number> = {
  portrait: Orientation.portrait,
  portrait_upside_down: Orientation.portraitUpsideDown,
  landscape_left: Orientation.landscapeLeft,
  landscape_right: Orientation.landscapeRight,
};

function waitForDrain(res: ServerResponse): Promise<void> {
  if (res.writableEnded || res.destroyed || !res.writableNeedDrain) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

function writeRetainedChunk(res: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (res.writableEnded || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("close", done);
    res.once("error", done);
    try {
      res.write(chunk, done);
    } catch {
      done();
    }
  });
}

function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
  bodyTooLargeError = new WebRtcSignalingError(
    "WebRTC signaling body is too large",
    413,
    "body_too_large",
  ),
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        fail(bodyTooLargeError);
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("aborted", () => fail(new WebRtcSignalingError("Request aborted", 400, "request_aborted")));
    req.on("error", fail);
  });
}

function isJsonRequest(req: IncomingMessage): boolean {
  const value = req.headers["content-type"];
  const contentType = Array.isArray(value) ? value[0] : value;
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseJsonBody(body: Buffer, code: string): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new WebRtcSignalingError("Malformed JSON request body", 400, code);
  }
}

type PanelCapture = {
  screenId: 1 | 3;
  capture: NativeCapture;
  start: Promise<void>;
  responses: Set<ServerResponse>;
  sessions: Set<string>;
  stopped: boolean;
};

export class DeviceSession {
  private readonly capture: NativeCapture;
  private readonly panels = new Map<number, PanelCapture>();
  private readonly panelRequests = new Set<ServerResponse>();
  private readonly hid: NativeHid;
  private captureStart?: Promise<void>;
  private phase: "unstarted" | "running" | "stopped" = "unstarted";

  private width = 0;
  private height = 0;
  private orientation = "portrait";
  private supportsHingeAngle?: boolean;
  private hingeAngle?: number;
  private hingePose: HingePose | null = null;
  private tableMode?: boolean;
  private hingePhysicalOrientation?: HingePhysicalOrientation;
  private hingeControlUpdate: Promise<void> = Promise.resolve();
  private nativeScreen?: NativeScreenInfo;
  private screenRefresh?: Promise<boolean>;
  private screenRefreshRequested = false;
  private unsubscribeScreenChanges?: NativeUnsubscribe;
  private screenRefreshTimer?: ReturnType<typeof setTimeout>;

  private latestJpegBuffer: Buffer | null = null;
  private latestJpegLength = 0;
  private readonly hidSockets = new Set<HidSocket>();
  private touchGestureLog?: TouchGestureLog;
  private readonly transport: StreamPlaybackSettings["transport"];
  private encoderSettings: StreamEncoderSettings;
  private streamSettingsUpdate: Promise<void> = Promise.resolve();
  private softwareKeyboardHidden = false;
  private softwareKeyboardSync: Promise<void> = Promise.resolve();
  private softwareKeyboardSyncPending = false;
  private softwareKeyboardPendingVisible: boolean | undefined;

  constructor(public readonly udid: string, initialStreamSettings?: StreamSettings) {
    const streamSettings = streamControlSettingsFrom(initialStreamSettings);
    this.transport = streamSettings.transport;
    this.encoderSettings = streamEncoderSettingsFrom(streamSettings);
    this.hid = new NativeHid(udid);
    this.capture = new NativeCapture(udid, this.encoderSettings);
    clearDeviceOptionState(udid);
  }

  /** Begin capture. Throws if the device isn't booted. Idempotent. */
  start(): Promise<void> {
    if (this.phase === "running") return this.captureStart ?? Promise.resolve();
    if (this.phase === "stopped") return Promise.reject(new Error("Capture session is stopped"));
    this.phase = "running";
    this.captureStart = this.capture.start().then(async () => {
      const unsubscribe = await this.capture.subscribeScreenChanges(async () => {
        if (this.phase !== "running") return;
        try {
          if (await this.refreshScreenSizeFromNative()) this.broadcastConfig();
        } catch { /* The periodic refresh retries transient read failures. */ }
      });
      if (this.phase !== "running") { await unsubscribe(); return; }
      this.unsubscribeScreenChanges = unsubscribe;
      if (await this.refreshScreenSizeFromNative()) this.broadcastConfig();
      this.scheduleScreenRefresh();
      // Discover fold controls without delaying the first frame or inventing
      // an initial angle when CoreDevice has not reported one.
      void this.hid.supportsHingeAngle().then((supported) => {
        if (this.phase !== "running") return;
        this.supportsHingeAngle = supported;
        this.broadcastConfig();
      });
    });
    return this.captureStart;
  }

  close(): void {
    if (this.phase !== "running") return;
    this.phase = "stopped";
    clearTimeout(this.screenRefreshTimer);
    this.screenRefreshTimer = undefined;
    void this.unsubscribeScreenChanges?.().catch(() => {});
    this.unsubscribeScreenChanges = undefined;
    for (const ws of this.hidSockets) ws.close();
    this.hidSockets.clear();
    for (const res of this.panelRequests) res.destroy();
    for (const panel of this.panels.values()) this.stopPanel(panel);
    void this.capture.stop().catch(() => {});
  }

  // ── Frame handling ───────────────────────────────────────────────────────

  private onSharedMjpegFrame(frame: MjpegFrame): void {
    const { width, height, data: jpeg } = frame;
    this.updateScreenSize(width, height);

    if (!this.latestJpegBuffer || this.latestJpegBuffer.length < jpeg.length) {
      const currentCapacity = this.latestJpegBuffer?.length ?? 0;
      this.latestJpegBuffer = Buffer.allocUnsafe(Math.max(jpeg.length, currentCapacity * 2));
    }
    this.latestJpegBuffer.set(jpeg, 0);
    this.latestJpegLength = jpeg.length;
  }

  private async waitForCapture(): Promise<void> {
    await this.captureStart;
    if (this.phase !== "running") throw new Error("Capture session is stopped");
  }

  private latestJpeg(): Buffer | null {
    if (!this.latestJpegBuffer) return null;
    return this.latestJpegBuffer.subarray(0, this.latestJpegLength);
  }

  /**
   * Write one multipart JPEG part (header + JPEG + trailing CRLF) as a **single
   * `write()`** — the whole part is concatenated into one buffer first.
   *
   * The previous version emitted three separate writes (header, JPEG, trailing
   * `\r\n`). Under Bun that corrupted ~1 frame in 20: the 2-byte trailer chunk
   * got misordered relative to the neighbouring parts as it passed through the
   * fetch bridge's ReadableStream + `Readable.fromWeb().pipe()`, landing between
   * the next part's header and its JPEG (Node's stream ordering never tripped on
   * it). One valid-but-malformed part is enough — a browser's native multipart
   * `<img>` decoder can't resync past it and freezes on the first corrupt frame.
   * One buffer per frame means there are no sub-frame chunk boundaries left to
   * reorder. It also copies `jpeg`, so we no longer depend on the native frame
   * buffer staying valid past the call. Awaiting drain provides backpressure.
   */
  private async writeMjpegFrame(res: ServerResponse, jpeg: Uint8Array): Promise<void> {
    if (res.writableEnded || res.destroyed) return;
    const header = mjpegHeader(jpeg.length);
    const frame = Buffer.allocUnsafe(header.length + jpeg.length + MJPEG_TRAILER.length);
    header.copy(frame, 0);
    frame.set(jpeg, header.length);
    MJPEG_TRAILER.copy(frame, header.length + jpeg.length);
    res.write(frame);
    await waitForDrain(res);
  }

  // ── HTTP handlers ────────────────────────────────────────────────────────

  /** Fixed-panel feeds share the existing transport implementation, never HID state. */
  async handlePanel(req: IncomingMessage, res: ServerResponse, screenId: number, endpoint: string): Promise<void> {
    const isStream = endpoint === "stream.mjpeg" || endpoint === "stream.avcc";
    const createsCapture = isStream || endpoint === "webrtc/offer";
    const route = validatePanelRoute(screenId, endpoint, req.method);
    if ("error" in route) { this.sendJson(res, route.status, { error: route.error }); return; }
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (isStream && this.transport === "webrtc") { this.sendTransportLocked(res); return; }
    // Install body listeners before capture startup yields: Fetch requests may
    // deliver their entire body while the native panel is still opening.
    const body = createsCapture && !isStream
      ? readRequestBody(req, MAX_WEBRTC_SIGNALING_BODY_BYTES)
      : endpoint === "webrtc/close" ? readRequestBody(req, 4 * 1024) : undefined;
    void body?.catch(() => {});
    let panel: PanelCapture | undefined;
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      this.panelRequests.delete(res);
      panel?.responses.delete(res);
      if (panel) this.releasePanelIfIdle(panel);
    };
    this.panelRequests.add(res);
    req.once("aborted", () => { release(); res.destroy(); });
    res.once("close", release);
    res.once("finish", release);
    res.once("error", release);
    try {
      await this.waitForCapture();
      if (!(this.supportsHingeAngle ?? await this.hid.supportsHingeAngle())) {
        this.sendJson(res, 409, { error: "panel_streams_unsupported" }); return;
      }
      // New panel captures must see the latest completed encoder-settings transaction.
      for (;;) {
        const pending = this.streamSettingsUpdate;
        await pending;
        if (pending === this.streamSettingsUpdate) break;
      }
      if (closed || this.phase !== "running") return;
      panel = this.panels.get(screenId);
      if (!panel && createsCapture) {
        const capture = new NativeCapture(this.udid, this.encoderSettings, screenId);
        panel = { screenId: route.screenId, capture, start: capture.start(), responses: new Set(), sessions: new Set(), stopped: false };
        this.panels.set(screenId, panel);
      }
      if (!panel) {
        if (endpoint === "webrtc/close") { res.writeHead(204); res.end(); }
        else this.sendJson(res, 404, { error: "panel_stream_not_running" });
        return;
      }
      panel.responses.add(res);
      await panel.start;
      if (closed || panel.stopped) return;
      if (endpoint === "stream.mjpeg") this.handleMjpeg(req, res, panel);
      else if (endpoint === "stream.avcc") this.handleAvcc(req, res, panel);
      else if (endpoint === "webrtc/offer") await this.handleWebRTCOffer(req, res, panel, body);
      else if (endpoint === "webrtc/close") await this.handleWebRTCClose(req, res, panel, body);
      else await this.handleWebRTCStats(req, res, panel);
    } catch {
      release();
      if (!res.headersSent && !res.destroyed) this.sendJson(res, 503, { error: "panel_stream_unavailable" });
      else res.destroy();
    }
  }

  private releasePanelIfIdle(panel: PanelCapture): void {
    if (!panel.responses.size && !panel.sessions.size) this.stopPanel(panel);
  }

  private stopPanel(panel: PanelCapture): void {
    if (panel.stopped) return;
    panel.stopped = true;
    if (this.panels.get(panel.screenId) === panel) this.panels.delete(panel.screenId);
    for (const res of panel.responses) res.destroy();
    panel.responses.clear();
    void panel.start.catch(() => {}).then(async () => {
      await Promise.allSettled([...panel.sessions].map((id) => panel.capture.closeWebRTCSession(id)));
      panel.sessions.clear();
      await panel.capture.stop();
    }).catch(() => {});
  }

  handleMjpeg(req: IncomingMessage, res: ServerResponse, panel?: PanelCapture): void {
    const capture = panel?.capture ?? this.capture;
    if (this.transport === "webrtc") {
      this.sendTransportLocked(res);
      return;
    }
    const raw = new URL(req.url ?? "", "http://x").searchParams.get("raw") === "1";
    res.writeHead(200, {
      "Content-Type": raw ? "application/octet-stream" : "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...(panel ? { "X-Screen-Id": String(panel.screenId) } : {}),
    });

    void (async () => {
      let cleanup = () => {};
      let closed = false;
      const handleClose = () => {
        closed = true;
        cleanup();
      };
      req.once("aborted", handleClose);
      res.once("close", handleClose);
      res.once("error", handleClose);
      try {
        await this.waitForCapture();
        if (closed || res.writableEnded || res.destroyed) return;
        const latestJpeg = panel ? null : this.latestJpeg();
        if (latestJpeg) {
          // `latestJpeg` is a view into the shared latest-frame cache, which the
          // native callback overwrites in place. writeMjpegFrame copies it into
          // the outgoing buffer synchronously (before its first await), so the
          // view can't be mutated mid-flush — no snapshot copy needed here.
          await this.writeMjpegFrame(res, latestJpeg);
        }
        const unsubscribe = await capture.subscribeMjpeg(async (frame) => {
          if (!panel) this.onSharedMjpegFrame(frame);
          await waitForDrain(res);
          if (!res.writableEnded && !res.destroyed) {
            await this.writeMjpegFrame(res, frame.data);
          }
        });
        let unsubscribed = false;
        cleanup = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          void unsubscribe().catch(() => {});
        };
        if (closed || res.writableEnded || res.destroyed) cleanup();
      } catch {
        cleanup();
        res.destroy();
      }
    })();
  }

  handleAvcc(req: IncomingMessage, res: ServerResponse, panel?: PanelCapture): void {
    const capture = panel?.capture ?? this.capture;
    if (this.transport === "webrtc") {
      this.sendTransportLocked(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      ...(panel ? { "X-Screen-Id": String(panel.screenId) } : {}),
    });

    void (async () => {
      let cleanup = () => {};
      let closed = false;
      const handleClose = () => {
        closed = true;
        cleanup();
      };
      req.once("aborted", handleClose);
      res.once("close", handleClose);
      res.once("error", handleClose);
      try {
        await this.waitForCapture();
        if (closed || res.writableEnded || res.destroyed) return;
        let streamStarted = false;
        let stopSeedRequested = false;
        let unsubscribeSeed: NativeUnsubscribe | undefined;
        const stopSeed = () => {
          stopSeedRequested = true;
          const unsubscribe = unsubscribeSeed;
          unsubscribeSeed = undefined;
          if (unsubscribe) void unsubscribe().catch(() => {});
        };
        cleanup = stopSeed;

        // Whichever codec produces first opens the response. A cached or
        // one-shot JPEG gives AVCC clients an immediate paint and keeps the
        // endpoint responsive on hosts where VideoToolbox cannot encode H.264.
        // The JPEG subscription is cancelled as soon as either seed or AVCC
        // data arrives, so it adds no steady-state encoding cost.
        const latestJpeg = panel ? null : this.latestJpeg();
        if (latestJpeg) {
          streamStarted = true;
          res.write(avccSeed(latestJpeg));
        } else {
          unsubscribeSeed = await capture.subscribeMjpeg(async (frame) => {
            if (streamStarted || res.writableEnded || res.destroyed) {
              stopSeed();
              return;
            }
            if (!panel) this.onSharedMjpegFrame(frame);
            streamStarted = true;
            res.write(avccSeed(frame.data));
            stopSeed();
          });
          if (stopSeedRequested) stopSeed();
        }

        if (closed || res.writableEnded || res.destroyed) {
          stopSeed();
          return;
        }

        const unsubscribeAvcc = await capture.subscribeAvcc(async (frame) => {
          if (!panel) this.updateScreenSize(frame.width, frame.height);
          if (!streamStarted) {
            streamStarted = true;
            stopSeed();
          }
          await waitForDrain(res);
          if (!res.writableEnded && !res.destroyed) {
            await writeRetainedChunk(res, frame.data);
          }
        });
        let unsubscribed = false;
        cleanup = () => {
          if (unsubscribed) return;
          unsubscribed = true;
          stopSeed();
          void unsubscribeAvcc().catch(() => {});
        };
        if (closed || res.writableEnded || res.destroyed) cleanup();
      } catch {
        cleanup();
        res.destroy();
      }
    })();
  }

  handleConfig(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, this.screenConfig());
  }

  handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    this.sendJson(res, 200, { status: "ok" });
  }

  async handleStreamSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "GET") {
      await this.streamSettingsUpdate;
      if (!res.writableEnded && !res.destroyed) {
        this.sendJson(
          res,
          200,
          streamEncoderSettingsForTransport(this.encoderSettings, this.transport),
        );
      }
      return;
    }
    if (req.method !== "PATCH") {
      this.sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (!isJsonRequest(req)) {
      this.sendJson(res, 415, { error: "unsupported_media_type" });
      return;
    }

    try {
      const body = await readRequestBody(
        req,
        16 * 1024,
        new WebRtcSignalingError("Stream settings body is too large", 413, "body_too_large"),
      );
      const patch = parseStreamEncoderSettingsPatch(
        parseJsonBody(body, "invalid_stream_settings"),
        this.transport,
      );
      if (!patch) {
        throw new WebRtcSignalingError(
          "Invalid stream settings",
          400,
          "invalid_stream_settings",
        );
      }
      const settings = await this.updateStreamSettings(patch);
      if (!res.writableEnded && !res.destroyed) {
        this.sendJson(
          res,
          200,
          streamEncoderSettingsForTransport(settings, this.transport),
        );
      }
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const status = error instanceof WebRtcSignalingError ? error.status : 500;
      const code = error instanceof WebRtcSignalingError ? error.code : "stream_settings_failed";
      this.sendJson(res, status, { error: code });
    }
  }

  private updateStreamSettings(
    patch: Partial<StreamEncoderSettings>,
  ): Promise<StreamEncoderSettings> {
    const update = this.streamSettingsUpdate.then(async () => {
      const next = normalizeStreamEncoderSettings(
        { ...this.encoderSettings, ...patch },
        this.encoderSettings,
      );
      await this.capture.updateStreamSettings(next);
      await Promise.all([...this.panels.values()].map(async (panel) => {
        await panel.start;
        if (!panel.stopped) await panel.capture.updateStreamSettings(next);
      }));
      this.encoderSettings = next;
      return next;
    });
    this.streamSettingsUpdate = update.then(() => {}, () => {});
    return update;
  }

  async handleWebRTCOffer(req: IncomingMessage, res: ServerResponse, panel?: PanelCapture, pendingBody?: Promise<Buffer>): Promise<void> {
    const capture = panel?.capture ?? this.capture;
    let sessionId: string | undefined;
    let sessionEstablished = false;
    let cancellation: Promise<void> | undefined;
    const cancelSession = (): Promise<void> => {
      if (!sessionId) return Promise.resolve();
      cancellation ??= capture.closeWebRTCSession(sessionId).finally(() => {
        panel?.sessions.delete(sessionId!);
        if (panel) this.releasePanelIfIdle(panel);
      });
      return cancellation;
    };
    const handleResponseClose = () => {
      // `close` also fires after a normal response. Only cancel when the socket
      // disappeared before Node finished flushing the SDP answer.
      if (!res.writableFinished) void cancelSession();
    };
    res.once("close", handleResponseClose);

    try {
      if (req.method !== "POST") {
        throw new WebRtcSignalingError("WebRTC offers require POST", 405, "method_not_allowed");
      }
      if (!isJsonRequest(req)) {
        throw new WebRtcSignalingError("WebRTC offers require application/json", 415, "unsupported_media_type");
      }
      const body = await (pendingBody ?? readRequestBody(req, MAX_WEBRTC_SIGNALING_BODY_BYTES));
      const offer = parseWebRtcOffer(parseJsonBody(body, "invalid_offer"));
      sessionId = offer.sessionId;
      await this.waitForCapture();
      if (!panel && await this.refreshScreenSizeFromNative()) this.broadcastConfig();
      const answer = await capture.handleWebRTCOffer(offer);
      panel?.sessions.add(sessionId);
      sessionEstablished = true;
      if (res.writableEnded || res.destroyed) {
        // A disconnect can cancel before native signaling resolves. Close
        // again after the answer so a late-created native session cannot leak.
        await cancellation;
        cancellation = undefined;
        await cancelSession();
        return;
      }
      this.sendJson(res, 200, answer);
    } catch (err) {
      if (sessionEstablished) await cancelSession();
      if (res.writableEnded || res.destroyed) return;
      const busy = err instanceof Error &&
        err.message.includes("WebRTC signaling already in progress");
      const status = err instanceof WebRtcSignalingError ? err.status : busy ? 409 : 500;
      const code = err instanceof WebRtcSignalingError
        ? err.code
        : busy
          ? "webrtc_session_busy"
          : "webrtc_offer_failed";
      this.sendJson(res, status, {
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (res.writableFinished) res.off("close", handleResponseClose);
    }
  }

  async handleWebRTCClose(req: IncomingMessage, res: ServerResponse, panel?: PanelCapture, pendingBody?: Promise<Buffer>): Promise<void> {
    try {
      if (req.method !== "POST") {
        throw new WebRtcSignalingError("WebRTC close requires POST", 405, "method_not_allowed");
      }
      const body = await (pendingBody ?? readRequestBody(req, 4 * 1024));
      const request = parseWebRtcCloseRequest(parseJsonBody(body, "invalid_close_request"));
      await (panel?.capture ?? this.capture).closeWebRTCSession(request.sessionId);
      panel?.sessions.delete(request.sessionId);
      if (panel) this.releasePanelIfIdle(panel);
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      const status = err instanceof WebRtcSignalingError ? err.status : 400;
      const code = err instanceof WebRtcSignalingError ? err.code : "invalid_close_request";
      this.sendJson(res, status, {
        error: code,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async handleWebRTCStats(req: IncomingMessage, res: ServerResponse, panel?: PanelCapture): Promise<void> {
    if (req.method !== "GET") {
      this.sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    try {
      const sessionId = parseWebRtcStatsSessionId(
        new URL(req.url ?? "", "http://x").searchParams.get("sessionId"),
      );
      const stats = await (panel?.capture ?? this.capture).webRTCSenderStats(sessionId);
      if (res.writableEnded || res.destroyed) return;
      this.sendJson(res, 200, stats);
    } catch (err) {
      if (err instanceof WebRtcSignalingError) {
        if (res.writableEnded || res.destroyed) return;
        this.sendJson(res, err.status, {
          error: err.code,
          message: err.message,
        });
        return;
      }
      // Logged, not returned: the message can name a host path.
      console.error(
        `WebRTC stats unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (res.writableEnded || res.destroyed) return;
      this.sendJson(res, 503, { error: "webrtc_stats_unavailable" });
    }
  }

  handleAx(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axDescribeAsync(this.udid), "ax_unavailable");
  }

  handleForeground(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.serveAxJson(res, () => axFrontmostAsync(this.udid), "foreground_unavailable");
  }

  /** Run a native AX probe and stream its JSON, or 503 with `errorCode` if it's not ready. */
  private async serveAxJson(res: ServerResponse, probe: () => Promise<string>, errorCode: string): Promise<void> {
    try {
      const json = await probe();
      if (res.writableEnded) return;
      this.sendJsonString(res, 200, json);
    } catch (err) {
      if (res.writableEnded) return;
      this.sendJson(res, 503, {
        error: errorCode,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── HID WebSocket ────────────────────────────────────────────────────────

  attachHidSocket(ws: HidSocket): void {
    this.hidSockets.add(ws);
    const cfg = this.configFrame();
    if (cfg) ws.send(cfg); // seed dimensions/orientation, replacing the old poll
    ws.on("message", (data: Buffer) => this.handleHidMessage(Buffer.isBuffer(data) ? data : Buffer.from(data), ws));
    ws.on("close", () => this.detachHidSocket(ws));
    ws.on("error", () => this.detachHidSocket(ws));
  }

  private detachHidSocket(ws: HidSocket): void {
    this.hidSockets.delete(ws);
    if (this.hidSockets.size === 0) {
      this.queueSoftwareKeyboardSync(true);
      // Reconnect the hardware keyboard once no client needs the on-screen one,
      // so the sim isn't left disconnected after everyone leaves.
      void setUiOption(this.udid, "hardware-keyboard", "on").catch(() => {});
    }
  }

  private async handleHidMessage(data: Buffer, ws: HidSocket): Promise<void> {
    if (data.length < 1) return;
    try {
      // Capture startup identifies the active display and configures HID's
      // target before the first gesture can be delivered.
      await this.waitForCapture();
    } catch {
      return;
    }
    const tag = data[0];
    const body = data.length > 1 ? data.subarray(1) : null;
    const json = <T>(): T | null => {
      if (!body) return null;
      try {
        return JSON.parse(body.toString("utf8")) as T;
      } catch {
        return null;
      }
    };
    const W = this.width;
    const H = this.height;

    switch (tag) {
      case 0x03: {
        const m = json<{ type: string; x: number; y: number; edge?: number }>();
        if (m) {
          this.recordTouchEvent(m);
          this.hid.touch(m.type as "begin" | "move" | "end", m.x, m.y, W, H, m.edge ?? 0);
        }
        break;
      }
      case 0x04: {
        const m = json<{ button: string; page?: number; usage?: number; phase?: string }>();
        if (!m) break;
        this.recordHidEvent(tag, m);
        if (m.page != null && m.usage != null) {
          this.hid.buttonHid(m.page, m.usage, (m.phase as "down" | "up" | "press") ?? "press");
        } else {
          this.hid.button(m.button);
        }
        break;
      }
      case 0x05: {
        const m = json<{ type: string; x1: number; y1: number; x2: number; y2: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.multiTouch(m.type as "begin" | "move" | "end", m.x1, m.y1, m.x2, m.y2, W, H);
        }
        break;
      }
      case 0x06: {
        const m = json<{ type: string; usage: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.key(m.type as "down" | "up", m.usage);
        }
        break;
      }
      case 0x07: {
        const m = json<{ orientation: string }>();
        if (!m) break;
        const operation = this.hingeControlUpdate.then(async () => {
          const value = ORIENTATION_BY_NAME[m.orientation];
          if (this.phase !== "running" || value == null || !await this.hid.orientation(value)) return;
          this.recordHidEvent(tag, m);
          if (this.supportsHingeAngle) {
            // Rotation is panel-relative; only a named pose establishes the
            // physical orientation needed to determine Table Mode eligibility.
            this.hingePose = null;
            this.hingePhysicalOrientation = undefined;
            this.tableMode = false;
            // Apps may lock their interface. Keep native readback authoritative.
            await this.refreshScreenSizeFromNative();
            this.broadcastConfig();
          } else if (m.orientation !== this.orientation) {
            this.orientation = m.orientation;
            this.broadcastConfig();
          }
        });
        this.hingeControlUpdate = operation.catch(() => {});
        await operation;
        break;
      }
      case 0x08: {
        const m = json<{ option: string; enabled: boolean }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.caDebug(m.option, m.enabled);
        }
        break;
      }
      case 0x09:
        this.recordHidEvent(tag, {});
        this.hid.memoryWarning();
        break;
      case 0x0a: {
        const m = json<{ delta: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.digitalCrown(m.delta);
        }
        break;
      }
      case 0x0b: {
        // Payload deltas are a fraction of the display; scale to device pixels.
        const m = json<{ dx: number; dy: number; x?: number; y?: number }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.hid.scroll(m.dx * W, m.dy * H, W, H, m.x, m.y);
        }
        break;
      }
      case 0x0c:
        this.recordHidEvent(tag, {});
        this.hid.softwareKeyboard();
        break;
      case 0x0d: {
        const m = json<{ visible: boolean }>();
        if (m) {
          this.recordHidEvent(tag, m);
          this.queueSoftwareKeyboardSync(m.visible);
        }
        break;
      }
      case 0x0e: {
        // A touch client disconnects the hardware keyboard so the guest shows
        // its on-screen keyboard; desktop clients never send this.
        const m = json<{ enabled: boolean }>();
        if (m) {
          this.recordHidEvent(tag, m);
          void setUiOption(this.udid, "hardware-keyboard", m.enabled ? "on" : "off").catch(() => {});
        }
        break;
      }
      case 0x0f: {
        const m = json<{ angle: unknown }>();
        let result: HingeAngleResult;
        if (!isHingeAngle(m?.angle)) {
          result = { ok: false, error: "Hinge angle must be a number from 0 to 180 degrees." };
        } else {
          const angle = m.angle;
          const ok = await this.queueHingeControl({ control: "angle", value: angle });
          if (ok) this.recordHidEvent(tag, { angle });
          result = ok
            ? { ok: true, angle }
            : { ok: false, angle, error: "Simulator could not change the hinge angle." };
        }
        try {
          ws.send(Buffer.concat([Buffer.from([0x8f]), Buffer.from(JSON.stringify(result))]));
        } catch {
          // The requester can disconnect while the simulator applies the angle.
        }
        break;
      }
      case 0x10: {
        const message = json<{ requestId?: unknown; command?: unknown }>();
        const requestId = message?.requestId;
        const command = message?.command;
        let ok = false;
        let error: string | undefined;
        if (typeof requestId !== "number" || !Number.isSafeInteger(requestId) || requestId <= 0 || !isHingeControlCommand(command)) {
          error = "Invalid hinge control request.";
        } else {
          ok = await this.queueHingeControl(command);
          if (ok) this.recordHidEvent(tag, command);
          else error = "Simulator could not change the device pose.";
        }
        try { ws.send(Buffer.concat([Buffer.from([0x90]), Buffer.from(JSON.stringify({ requestId, ok, ...(error ? { error } : {}) }))])); }
        catch { /* The requester may disconnect during the native operation. */ }
        break;
      }
    }
  }

  /** Keep pose sequences ordered across sliders, presets, and legacy CLI clients. */
  private queueHingeControl(command: HingeControlCommand): Promise<boolean> {
    const operation = this.hingeControlUpdate.then(async () => {
      if (this.phase !== "running") return false;
      if (command.control === "table" && command.value && !isTableModeAvailable(this.hingeAngle, this.hingePhysicalOrientation)) return false;
      const ok = command.control === "pose" ? await this.hid.setHingePose(command.value)
        : command.control === "table" ? await this.hid.setTableMode(command.value)
        : await this.hid.setHingeAngle(command.value);
      if (ok) {
        const state = hingeControlState(command);
        this.supportsHingeAngle = true;
        if (state.hingeAngle !== undefined) this.hingeAngle = state.hingeAngle;
        this.hingePose = state.hingePose ?? null;
        if (state.tableMode !== undefined) this.tableMode = state.tableMode;
        if (command.control === "pose") this.hingePhysicalOrientation = hingePoseOrientation(command.value);
        this.broadcastConfig();
      } else {
        // A failed sequence can still move the hinge or change the active
        // panel. Recover actual state before the failure ack permits a retry.
        this.hingePose = null;
        const recovered = await this.hid.hingeState();
        if (this.phase !== "running") return false;
        this.hingeAngle = recovered.hingeAngle ?? this.hingeAngle;
        this.tableMode = recovered.tableMode;
        this.hingePhysicalOrientation = recovered.physicalOrientation ?? this.hingePhysicalOrientation;
        try { await this.refreshScreenSizeFromNative(); }
        catch { /* Preserve the last readable screen through a transient failure. */ }
        if (this.phase !== "running") return false;
        this.broadcastConfig();
      }
      return ok;
    });
    this.hingeControlUpdate = operation.then(() => {}, () => {});
    return operation;
  }

  private queueSoftwareKeyboardSync(visible: boolean): void {
    this.softwareKeyboardPendingVisible = visible;
    if (this.softwareKeyboardSyncPending) return;
    this.softwareKeyboardSyncPending = true;
    this.softwareKeyboardSync = this.softwareKeyboardSync
      .then(() => this.drainSoftwareKeyboardSync())
      .finally(() => {
        this.softwareKeyboardSyncPending = false;
      });
  }

  private async drainSoftwareKeyboardSync(): Promise<void> {
    while (this.softwareKeyboardPendingVisible !== undefined) {
      const visible = this.softwareKeyboardPendingVisible;
      this.softwareKeyboardPendingVisible = undefined;
      await this.setSoftwareKeyboardVisible(visible);
    }
  }

  private async setSoftwareKeyboardVisible(visible: boolean): Promise<void> {
    if (visible) {
      debugKeyboard("show requested, hidden=%s", this.softwareKeyboardHidden);
      if (!this.softwareKeyboardHidden) return;
      this.softwareKeyboardHidden = false;
      this.hid.softwareKeyboard();
      return;
    }
    const keyboardVisible = await isSoftwareKeyboardVisible(this.udid);
    debugKeyboard(
      "hide requested, keyboard=%s hidden=%s",
      keyboardVisible,
      this.softwareKeyboardHidden,
    );
    if (this.softwareKeyboardHidden || !keyboardVisible) return;
    this.softwareKeyboardHidden = true;
    this.hid.softwareKeyboard();
  }

  private recordTouchEvent(payload: { type: string; x: number; y: number; edge?: number }): void {
    if (payload.type === "begin") {
      this.touchGestureLog = newTouchGesture(payload);
      return;
    }

    if (payload.type === "move") {
      let gesture = this.touchGestureLog;
      if (!gesture) {
        gesture = newTouchGesture(payload);
        this.touchGestureLog = gesture;
      }

      gesture.lastX = payload.x;
      gesture.lastY = payload.y;
      gesture.moveCount++;
      if (payload.edge != null) gesture.edge = payload.edge;
      if (touchGestureMoved(gesture)) {
        if (gesture.eventId == null) {
          const entry = recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "drag",
            action: "drag",
            summary: touchGestureSummary(gesture),
            details: this.touchGestureDetails(gesture, "drag", "move"),
          });
          gesture.eventId = entry.id;
        } else {
          // Keep the stored drag current without streaming every touchmove to the browser.
          updateEventLogEvent(
            gesture.eventId,
            {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "move"),
            },
            { notify: false },
          );
        }
      }
      return;
    }

    if (payload.type === "end") {
      const gesture = this.touchGestureLog;
      if (gesture) {
        gesture.lastX = payload.x;
        gesture.lastY = payload.y;
        if (payload.edge != null) gesture.edge = payload.edge;
        if (gesture.moveCount > 0 && touchGestureMoved(gesture)) {
          if (gesture.eventId == null) {
            recordEventLogEvent({
              device: this.udid,
              source: "hid",
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          } else {
            updateEventLogEvent(gesture.eventId, {
              kind: "drag",
              action: "drag",
              summary: touchGestureSummary(gesture),
              details: this.touchGestureDetails(gesture, "drag", "end"),
            });
          }
        } else {
          recordEventLogEvent({
            device: this.udid,
            source: "hid",
            kind: "tap",
            action: "tap",
            summary: `Tap ${formatEventLogPoint(payload.x, payload.y)}`,
            details: this.touchGestureDetails(gesture, "tap"),
          });
        }
        this.touchGestureLog = undefined;
        return;
      }
    }

    this.recordHidEvent(0x03, payload);
  }

  private eventLogScreen(): { width: number; height: number } | undefined {
    return this.width > 0 && this.height > 0
      ? { width: this.width, height: this.height }
      : undefined;
  }

  private touchGestureDetails(
    gesture: TouchGestureLog,
    type: "drag" | "tap",
    phase?: "move" | "end",
  ): Record<string, unknown> {
    return {
      type,
      ...(phase ? { phase } : {}),
      start: { x: gesture.startX, y: gesture.startY },
      current: { x: gesture.lastX, y: gesture.lastY },
      moveCount: gesture.moveCount,
      ...(gesture.edge != null ? { edge: gesture.edge } : {}),
      ...(this.eventLogScreen() ? { screen: this.eventLogScreen() } : {}),
    };
  }

  private recordHidEvent(tag: number, payload: Record<string, unknown>): void {
    const event = eventLogEventForHidMessage(
      this.udid,
      tag,
      payload,
      this.eventLogScreen(),
    );
    if (event) recordEventLogEvent(event);
  }

  // ── Config ───────────────────────────────────────────────────────────────

  screenConfig(): {
    width: number;
    height: number;
    orientation: string;
    screenId?: number;
    supportsHingeAngle?: boolean;
    hingeAngle?: number;
    hingePose?: HingePose | null;
    tableMode?: boolean;
    tableModeAvailable?: boolean;
  } {
    return {
      width: this.width,
      height: this.height,
      orientation: this.orientation,
      ...(this.nativeScreen?.screenId !== undefined ? { screenId: this.nativeScreen.screenId } : {}),
      ...(this.supportsHingeAngle !== undefined ? { supportsHingeAngle: this.supportsHingeAngle } : {}),
      ...(this.hingeAngle !== undefined ? { hingeAngle: this.hingeAngle } : {}),
      ...(this.supportsHingeAngle ? { hingePose: this.hingePose, tableModeAvailable: isTableModeAvailable(this.hingeAngle, this.hingePhysicalOrientation) } : {}),
      ...(this.tableMode !== undefined ? { tableMode: this.tableMode } : {}),
    };
  }

  private configFrame(): Buffer | null {
    if (this.width === 0 && this.height === 0) return null;
    return Buffer.concat([Buffer.from([WS_MSG_CONFIG]), Buffer.from(JSON.stringify(this.screenConfig()))]);
  }

  private refreshScreenSizeFromNative(): Promise<boolean> {
    this.screenRefreshRequested = true;
    if (this.screenRefresh) return this.screenRefresh;
    this.screenRefresh = (async () => {
      let changed = false;
      do {
        this.screenRefreshRequested = false;
        changed = await this.readScreenFromNative() || changed;
      } while (this.phase === "running" && this.screenRefreshRequested);
      return changed;
    })().finally(() => {
      this.screenRefresh = undefined;
    });
    return this.screenRefresh;
  }

  private async readScreenFromNative(): Promise<boolean> {
    const screen = await this.capture.screenSize();
    if (this.phase !== "running") return false;
    const previous = this.nativeScreen;
    let changed = false;
    if (!previous || screen.screenId !== previous.screenId) {
      await this.hid.setScreen(screen.screenId ?? 0);
      if (this.phase !== "running") return false;
      changed = true;
    }
    // Encoders can publish smaller frames than the native framebuffer. Only a
    // change in the framebuffer itself should replace those encoded dimensions.
    if (screen.width > 0 && screen.height > 0 &&
        (screen.width !== previous?.width || screen.height !== previous?.height)) {
      this.width = screen.width;
      this.height = screen.height;
      changed = true;
    }
    if (screen.orientation !== undefined && screen.orientation !== this.orientation) {
      this.orientation = screen.orientation;
      changed = true;
    }
    this.nativeScreen = screen;
    return changed;
  }

  private scheduleScreenRefresh(): void {
    if (this.phase !== "running") return;
    // Native notifications drive routing; retain a non-overlapping fallback
    // for runtimes that miss properties/surface notifications while idle.
    this.screenRefreshTimer = setTimeout(async () => {
      try {
        if (await this.refreshScreenSizeFromNative()) this.broadcastConfig();
      } catch {
        // A transitioning simulator can temporarily have no readable screen.
      } finally {
        this.scheduleScreenRefresh();
      }
    }, 250);
    this.screenRefreshTimer.unref();
  }

  private updateScreenSize(width: number, height: number): void {
    if (!width || !height || (width === this.width && height === this.height)) return;
    this.width = width;
    this.height = height;
    this.broadcastConfig();
  }

  private broadcastConfig(): void {
    const frame = this.configFrame();
    if (!frame) return;
    for (const ws of this.hidSockets) ws.send(frame);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    this.sendJsonString(res, status, JSON.stringify(body));
  }

  private sendTransportLocked(res: ServerResponse): void {
    this.sendJson(res, 409, {
      error: "stream_transport_locked",
      transport: this.transport,
    });
  }

  private sendJsonString(res: ServerResponse, status: number, json: string): void {
    const buf = Buffer.from(json, "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache, no-store",
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  }
}

// ── Registry ─────────────────────────────────────────────────────────────

const sessions = new Map<string, DeviceSession>();

/** Existing session only. Reading stats must never be the thing that starts capture. */
export function peekDeviceSession(udid: string): DeviceSession | undefined {
  return sessions.get(udid);
}

/**
 * Get (lazily creating + starting) the in-process session for `udid`. Throws if
 * the device isn't booted. The session lives until `closeDeviceSession`.
 */
export function getDeviceSession(udid: string, initialStreamSettings?: StreamSettings): DeviceSession {
  let session = sessions.get(udid);
  if (!session) {
    const createdSession = new DeviceSession(udid, initialStreamSettings);
    session = createdSession;
    sessions.set(udid, createdSession);
    try {
      const start = createdSession.start();
      void start.catch(() => {
        if (sessions.get(udid) !== createdSession) return;
        createdSession.close();
        sessions.delete(udid);
      });
    } catch (err) {
      createdSession.close();
      sessions.delete(udid);
      throw err;
    }
  }
  return session;
}

export function closeDeviceSession(udid: string): void {
  const session = sessions.get(udid);
  if (session) {
    session.close();
    sessions.delete(udid);
  }
}
