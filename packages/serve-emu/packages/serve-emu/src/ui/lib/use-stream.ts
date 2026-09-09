import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  controlAcknowledgementMessage,
  logControlAcknowledgement,
} from "./control-ack";
import { scanAU } from "./h264";
import { MsePlayer } from "./mse-player";
import { parseFramePacket } from "../../shared/frame-meta";
import {
  DEFAULT_WEBRTC_ICE_SERVERS,
  type StreamSettings,
  type StreamTransport,
  type ViewerTransports,
  type WebRtcIceServer,
} from "../../stream-settings";
import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from "./webrtc-negotiation";
import {
  deriveStreamDisplayStatus,
  gateStreamEventGeneration,
  isCurrentStreamClientEpoch,
  isStreamFatalStatus,
  reduceStreamLifecycle,
} from "./stream-lifecycle";
import { downloadStreamStats } from "./stream-stats-download";
import type {
  StreamEventGenerationGate,
  StreamFatalStatus,
  StreamLifecycleState,
} from "./stream-lifecycle";
import type { StreamStats, StreamWorkerEvent } from "./stream-worker";

export type DeviceSize = { width: number; height: number };

export type { StreamStats };

export type StreamState = {
  status: string;
  generation: number;
  lastRenderedAt: number | null;
  fps: number;
  deviceSize: DeviceSize | null;
  stats: StreamStats | null;
  controlError: string | null;
};

export type Sender = (msg: Record<string, unknown>, ack?: boolean) => void;
export type { StreamTransport } from "../../stream-settings";

type ApiInfo = {
  generation: number;
  size: DeviceSize;
  status?: "streaming" | "stopped" | "error";
  lastError?: string | null;
  stream?: StreamSettings;
  viewerTransports?: ViewerTransports;
};

type BrowserRtpCodecCapability = {
  mimeType: string;
  sdpFmtpLine?: string;
};

// A canvas can transfer control to an OffscreenCanvas only once, so the worker
// that received it must be reused if the effect re-runs for the same element.
const workerByCanvas = new WeakMap<HTMLCanvasElement, Worker>();
const workerGenerationByCanvas = new WeakMap<HTMLCanvasElement, number>();
const clientEpochByCanvas = new WeakMap<HTMLCanvasElement, number>();

const HEALTH_POLL_INTERVAL_MS = 1_500;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const WEBRTC_ICE_GATHERING_TIMEOUT_MS = 3_000;
const WEBRTC_SIGNALING_REQUEST_TIMEOUT_MS = 20_000;
const WEBRTC_FIRST_FRAME_TIMEOUT_MS = 4_000;
const WEBRTC_BUSY_RETRY_INTERVAL_MS = 500;
const WEBRTC_BUSY_RETRY_COUNT = 30;
const WEBRTC_TRANSPORT_RETRY_BASE_MS = 500;
const WEBRTC_TRANSPORT_RETRY_MAX_MS = 5_000;
const WEBRTC_DISCONNECTED_GRACE_MS = 10_000;
const CONTROL_ERROR_VISIBLE_MS = 5_000;
const VIEWER_TRANSPORT_SESSION_KEY = "serve-emu.viewer-transport";

function viewerTransportsKey(value: ViewerTransports | null): string | null {
  return value ? JSON.stringify(value) : null;
}

function legacyViewerTransports(
  settings: StreamSettings | undefined,
): ViewerTransports | null {
  if (!settings) return null;
  return {
    default: settings.transport,
    available: [settings.transport],
    webrtc: settings.transport === "webrtc" ? settings : null,
  };
}

function storedViewerTransport(): StreamTransport | null {
  try {
    const value = sessionStorage.getItem(VIEWER_TRANSPORT_SESSION_KEY);
    return value === "websocket" || value === "webrtc" ? value : null;
  } catch {
    return null;
  }
}

function storeViewerTransport(transport: StreamTransport): void {
  try {
    sessionStorage.setItem(VIEWER_TRANSPORT_SESSION_KEY, transport);
  } catch {
    // A blocked storage API must not prevent a viewer-local transport switch.
  }
}

function createWebRtcSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function streamSettingsKey(settings: StreamSettings | null): string | null {
  return settings ? JSON.stringify(settings) : null;
}

function iceServersForBrowser(settings: StreamSettings): WebRtcIceServer[] {
  if (settings.transport !== "webrtc") return DEFAULT_WEBRTC_ICE_SERVERS;
  return settings.iceServers.length
    ? settings.iceServers
    : DEFAULT_WEBRTC_ICE_SERVERS;
}

function preferH264(transceiver: RTCRtpTransceiver): void {
  if (
    !("setCodecPreferences" in transceiver) ||
    typeof RTCRtpReceiver === "undefined"
  ) {
    return;
  }
  const capabilities = RTCRtpReceiver.getCapabilities("video");
  const codecs = (capabilities?.codecs ?? []) as BrowserRtpCodecCapability[];
  if (codecs.length === 0) return;
  const isH264 = (codec: BrowserRtpCodecCapability) =>
    codec.mimeType.toLowerCase() === "video/h264";
  const hasMode1 = (codec: BrowserRtpCodecCapability) =>
    /(?:^|;)\s*packetization-mode=1(?:\s*;|$)/i.test(
      codec.sdpFmtpLine ?? "",
    );
  transceiver.setCodecPreferences([
    ...codecs.filter((codec) => isH264(codec) && hasMode1(codec)),
    ...codecs.filter((codec) => isH264(codec) && !hasMode1(codec)),
    ...codecs.filter((codec) => !isH264(codec)),
  ] as Parameters<RTCRtpTransceiver["setCodecPreferences"]>[0]);
}

async function waitForWebRtcIce(
  connection: RTCPeerConnection,
): Promise<void> {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let timeout: number | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      connection.removeEventListener("icegatheringstatechange", onState);
      if (timeout !== undefined) window.clearTimeout(timeout);
      resolve();
    };
    const onState = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    connection.addEventListener("icegatheringstatechange", onState);
    timeout = window.setTimeout(finish, WEBRTC_ICE_GATHERING_TIMEOUT_MS);
  });
}

export function useStream(
  canvasRef: RefObject<HTMLCanvasElement>,
  videoRef: RefObject<HTMLVideoElement>,
) {
  const [state, setState] = useState<StreamState>({
    status: "connecting…",
    generation: 0,
    lastRenderedAt: null,
    fps: 0,
    deviceSize: null,
    stats: null,
    controlError: null,
  });
  const workerRef = useRef<Worker | null>(null);
  const directWsRef = useRef<WebSocket | null>(null);
  const clientEpochRef = useRef(0);
  const [viewerTransports, setViewerTransports] =
    useState<ViewerTransports | null>(null);
  const viewerTransportsRef = useRef<ViewerTransports | null>(null);
  const [transport, setTransport] = useState<StreamTransport | null>(null);
  const transportRef = useRef<StreamTransport | null>(null);
  const [switchingTo, setSwitchingTo] =
    useState<StreamTransport | null>(null);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [statsDownloadStatus, setStatsDownloadStatus] = useState<
    "idle" | "downloading" | "complete" | "error"
  >("idle");
  const [statsDownloadMessage, setStatsDownloadMessage] = useState<
    string | null
  >(null);
  const [webRtcRetryGeneration, setWebRtcRetryGeneration] = useState(0);
  const [serverGeneration, setServerGeneration] = useState<number | null>(null);
  const serverGenerationRef = useRef<number | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const liveTransportRef = useRef<StreamTransport | null>(null);
  const currentWebRtcSessionIdRef = useRef<string | null>(null);
  const statsDownloadPendingRef = useRef(false);
  const webRtcTransportRetryAttemptRef = useRef(0);
  const controlErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamSettings: StreamSettings | null =
    transport === "websocket"
      ? { transport: "websocket" }
      : transport === "webrtc"
        ? viewerTransports?.webrtc ?? null
        : null;
  const currentStreamSettingsKey = streamSettingsKey(streamSettings);

  const markTransportLive = useCallback((live: StreamTransport) => {
    if (transportRef.current !== live) return;
    liveTransportRef.current = live;
    setSwitchingTo((current) => (current === live ? null : current));
    setTransportError(null);
  }, []);

  const markTransportSwitching = useCallback((next: StreamTransport) => {
    if (transportRef.current !== next) return;
    liveTransportRef.current = null;
    setSwitchingTo(next);
  }, []);

  const reportTransportError = useCallback(
    (failed: StreamTransport, message: string) => {
      if (transportRef.current !== failed) return;
      liveTransportRef.current = null;
      setSwitchingTo(null);
      setTransportError(message);
    },
    [],
  );

  const selectTransport = useCallback((next: StreamTransport) => {
    const catalog = viewerTransportsRef.current;
    if (!catalog?.available.includes(next)) {
      setTransportError(
        `${next === "webrtc" ? "WebRTC" : "WebSocket"} is unavailable for this stream.`,
      );
      return;
    }
    if (transportRef.current === next) return;
    storeViewerTransport(next);
    transportRef.current = next;
    liveTransportRef.current = null;
    setTransportError(null);
    if (!statsDownloadPendingRef.current) {
      setStatsDownloadStatus("idle");
      setStatsDownloadMessage(null);
    }
    setSwitchingTo(next);
    setState((current) => ({
      ...current,
      status: `switching to ${next === "webrtc" ? "WebRTC" : "WebSocket"}`,
      lastRenderedAt: null,
      fps: 0,
      stats: null,
    }));
    setTransport(next);
  }, []);

  const downloadStats = useCallback(async () => {
    const currentTransport = transportRef.current;
    if (currentTransport === null || statsDownloadPendingRef.current) return;
    if (liveTransportRef.current !== currentTransport) {
      setStatsDownloadStatus("error");
      setStatsDownloadMessage(
        "Wait for the selected viewer transport to become live.",
      );
      return;
    }

    statsDownloadPendingRef.current = true;
    setStatsDownloadStatus("downloading");
    setStatsDownloadMessage("Collecting viewer and server statistics…");
    try {
      const result = await downloadStreamStats({
        transport: currentTransport,
        viewerState: stateRef.current,
        webRtcSessionId:
          currentTransport === "webrtc"
            ? currentWebRtcSessionIdRef.current
            : null,
      });
      setStatsDownloadStatus("complete");
      setStatsDownloadMessage(
        result.document.errors.length > 0
          ? "Stats downloaded with partial server data."
          : "Stats downloaded.",
      );
    } catch {
      setStatsDownloadStatus("error");
      setStatsDownloadMessage("Could not download stream stats.");
    } finally {
      statsDownloadPendingRef.current = false;
    }
  }, []);

  const showControlError = useCallback((message: string) => {
    if (controlErrorTimerRef.current) {
      clearTimeout(controlErrorTimerRef.current);
    }
    setState((current) => ({ ...current, controlError: message }));
    controlErrorTimerRef.current = setTimeout(() => {
      controlErrorTimerRef.current = null;
      setState((current) =>
        current.controlError === message
          ? { ...current, controlError: null }
          : current,
      );
    }, CONTROL_ERROR_VISIBLE_MS);
  }, []);

  const handleControlAcknowledgement = useCallback(
    (raw: string): boolean => {
      const message = controlAcknowledgementMessage(raw);
      if (!message) return false;
      logControlAcknowledgement(raw);
      showControlError(message);
      return true;
    },
    [showControlError],
  );

  useEffect(
    () => () => {
      if (controlErrorTimerRef.current) {
        clearTimeout(controlErrorTimerRef.current);
      }
    },
    [],
  );

  const send = useCallback<Sender>((msg, ack = true) => {
    const directWs = directWsRef.current;
    if (directWs?.readyState === WebSocket.OPEN) {
      directWs.send(JSON.stringify(ack ? msg : { ...msg, ack: false }));
      return;
    }
    const clientEpoch = clientEpochRef.current;
    if (clientEpoch < 1) return;
    workerRef.current?.postMessage({
      type: "send",
      clientEpoch,
      text: JSON.stringify(ack ? msg : { ...msg, ack: false }),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const refresh = async () => {
      controller = new AbortController();
      const timeout = setTimeout(
        () => controller?.abort(),
        HEALTH_REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch("/api", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ApiInfo;
        if (cancelled) return;
        const nextViewerTransports =
          data.viewerTransports ?? legacyViewerTransports(data.stream);
        if (nextViewerTransports) {
          const previousCatalog = viewerTransportsRef.current;
          if (
            viewerTransportsKey(previousCatalog) !==
            viewerTransportsKey(nextViewerTransports)
          ) {
            viewerTransportsRef.current = nextViewerTransports;
            setViewerTransports(nextViewerTransports);
          }
          const currentTransport = transportRef.current;
          if (currentTransport === null) {
            const stored = storedViewerTransport();
            const initial =
              stored && nextViewerTransports.available.includes(stored)
                ? stored
                : nextViewerTransports.available.includes(
                    nextViewerTransports.default,
                  )
                  ? nextViewerTransports.default
                  : nextViewerTransports.available[0]!;
            transportRef.current = initial;
            liveTransportRef.current = null;
            setSwitchingTo(initial);
            setTransport(initial);
          } else if (!nextViewerTransports.available.includes(currentTransport)) {
            liveTransportRef.current = null;
            setSwitchingTo(null);
            setTransportError(
              `${currentTransport === "webrtc" ? "WebRTC" : "WebSocket"} is no longer available. Choose another transport.`,
            );
          } else if (
            currentTransport === "webrtc" &&
            viewerTransportsKey(previousCatalog) !==
              viewerTransportsKey(nextViewerTransports)
          ) {
            setTransportError(null);
            markTransportSwitching("webrtc");
          }
        }
        if (
          Number.isSafeInteger(data.generation) &&
          data.generation >= 0
        ) {
          const previousGeneration = serverGenerationRef.current;
          if (
            previousGeneration !== null &&
            previousGeneration !== data.generation
          ) {
            markTransportSwitching("webrtc");
          }
          serverGenerationRef.current = data.generation;
          setServerGeneration((current) =>
            current === data.generation ? current : data.generation,
          );
        }
        setState((current) => ({
          ...current,
          deviceSize: data.size,
          ...(data.status && data.status !== "streaming"
            ? { status: data.lastError || data.status }
            : {}),
        }));
      } catch {
        if (!cancelled) {
          setState((current) =>
            current.status === "streaming"
              ? current
              : { ...current, status: "metadata unavailable" },
          );
        }
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!cancelled) {
          timer = setTimeout(() => void refresh(), HEALTH_POLL_INTERVAL_MS);
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [markTransportSwitching]);

  useEffect(() => {
    if (transport !== "websocket") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (
      typeof Worker !== "function" ||
      typeof VideoDecoder !== "function" ||
      typeof EncodedVideoChunk !== "function" ||
      typeof canvas.transferControlToOffscreen !== "function"
    ) {
      return;
    }

    let cancelled = false;
    let currentGeneration = 0;
    let currentLifecycle: StreamLifecycleState | null = null;
    let lastRenderedAt: number | null = null;
    let serverTerminalStatus: string | null = null;
    let workerFatalStatus: StreamFatalStatus | null = null;
    let lifecycleTimer: ReturnType<typeof setInterval> | null = null;
    let healthTimer: ReturnType<typeof setTimeout> | null = null;
    let healthController: AbortController | null = null;
    let healthRequestSequence = 0;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws?frame-meta=1`;

    let worker = workerByCanvas.get(canvas);
    const isNewWorker = !worker;
    if (!worker) {
      worker = new Worker(new URL("./stream-worker.ts", import.meta.url), { type: "module" });
      workerByCanvas.set(canvas, worker);
    }
    currentGeneration = workerGenerationByCanvas.get(canvas) ?? 0;
    let generationGate: StreamEventGenerationGate = {
      currentGeneration,
      awaitingConnectBoundary: !isNewWorker,
    };
    const previousClientEpoch = clientEpochByCanvas.get(canvas) ?? 0;
    const clientEpoch = previousClientEpoch + 1;
    clientEpochByCanvas.set(canvas, clientEpoch);
    clientEpochRef.current = clientEpoch;
    workerRef.current = worker;

    const onMessage = (e: MessageEvent) => {
      if (cancelled) return;
      const msg = e.data as StreamWorkerEvent;
      // A transferred canvas keeps its worker across effect replay. The epoch
      // is the connect-command nonce, so events queued by the prior listener
      // cannot satisfy this setup's generation boundary.
      if (!isCurrentStreamClientEpoch(clientEpoch, msg.clientEpoch)) return;
      if (msg.type === "lifecycle" && msg.state.generation !== msg.generation) return;
      const gatedGeneration = gateStreamEventGeneration(
        generationGate,
        msg.generation,
        msg.type === "lifecycle" ? msg.state.reason : null,
      );
      generationGate = gatedGeneration.gate;
      const generationDisposition = gatedGeneration.disposition;
      if (
        generationDisposition === "invalid" ||
        generationDisposition === "stale" ||
        generationDisposition === "awaiting-boundary"
      ) {
        return;
      }

      const isNewGeneration = generationDisposition === "new-generation";
      if (isNewGeneration) {
        markTransportSwitching("websocket");
        currentGeneration = generationGate.currentGeneration;
        workerGenerationByCanvas.set(canvas, currentGeneration);
        currentLifecycle = null;
        lastRenderedAt = null;
        // Terminal health belongs to the previous worker generation. A fresh
        // health response can re-assert it if the server is still terminal.
        serverTerminalStatus = null;
        workerFatalStatus = null;
        refreshHealthForGeneration();
      }

      if (msg.type === "lifecycle") {
        currentLifecycle = msg.state;
        if (
          msg.state.lastRenderedAt !== null &&
          (lastRenderedAt === null || msg.state.lastRenderedAt > lastRenderedAt)
        ) {
          lastRenderedAt = msg.state.lastRenderedAt;
        }
      } else if (msg.type === "rendered") {
        markTransportLive("websocket");
        if (lastRenderedAt === null || msg.at > lastRenderedAt) lastRenderedAt = msg.at;
        if (currentLifecycle) {
          currentLifecycle = reduceStreamLifecycle(currentLifecycle, {
            type: "frame-rendered",
            generation: msg.generation,
            at: msg.at,
          });
        }
      }
      if (msg.type === "status" && isStreamFatalStatus(msg.status)) {
        workerFatalStatus = msg.status;
        reportTransportError("websocket", msg.status);
      }
      if (msg.type === "control-error") showControlError(msg.message);

      setState((prev) => {
        let next: StreamState = isNewGeneration
          ? {
              ...prev,
              status:
                serverTerminalStatus ??
                workerFatalStatus ??
                (currentLifecycle
                  ? deriveStreamDisplayStatus(currentLifecycle, Date.now())
                  : "connecting"),
              generation: currentGeneration,
              lastRenderedAt,
              fps: 0,
              stats: null,
            }
          : prev;

        if (
          next.generation !== currentGeneration ||
          next.lastRenderedAt !== lastRenderedAt
        ) {
          next = { ...next, generation: currentGeneration, lastRenderedAt };
        }

        if (msg.type === "lifecycle" || msg.type === "rendered") {
          if (currentLifecycle) {
            const status =
              serverTerminalStatus ??
              workerFatalStatus ??
              deriveStreamDisplayStatus(currentLifecycle, Date.now());
            if (next.status !== status) next = { ...next, status };
          }
        } else if (msg.type === "status") {
          const workerStatus =
            msg.status === "streaming" && lastRenderedAt === null
              ? currentLifecycle
                ? deriveStreamDisplayStatus(currentLifecycle, Date.now())
                : "connecting"
              : msg.status;
          const status = serverTerminalStatus ?? workerFatalStatus ?? workerStatus;
          if (next.status !== status) next = { ...next, status };
        } else if (msg.type === "session") {
          next = { ...next, deviceSize: msg.size };
        } else if (msg.type === "stats") {
          next = { ...next, fps: msg.stats.fps, stats: msg.stats };
        }

        return next;
      });
    };
    worker.addEventListener("message", onMessage);

    // Listen before init/connect: a reused worker can publish its clean
    // generation boundary synchronously with the command.
    if (isNewWorker) {
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage(
        { type: "init", clientEpoch, canvas: offscreen, url },
        [offscreen],
      );
    } else {
      setState((prev) => ({
        ...prev,
        status: "connecting",
        lastRenderedAt: null,
        fps: 0,
        stats: null,
      }));
      worker.postMessage({ type: "connect", clientEpoch });
    }

    lifecycleTimer = setInterval(() => {
      if (cancelled || !currentLifecycle) return;
      const status =
        serverTerminalStatus ??
        workerFatalStatus ??
        deriveStreamDisplayStatus(currentLifecycle, Date.now());
      setState((prev) => (prev.status === status ? prev : { ...prev, status }));
    }, 1_000);

    const applyServerStatus = (d: ApiInfo) => {
      serverTerminalStatus =
        d.status && d.status !== "streaming" ? d.lastError || d.status : null;
      setState((prev) => ({
        ...prev,
        deviceSize: d.size,
        ...(serverTerminalStatus ? { status: serverTerminalStatus } : {}),
      }));
    };

    function refreshHealthForGeneration() {
      if (cancelled) return;
      if (healthTimer !== null) {
        clearTimeout(healthTimer);
        healthTimer = null;
      }
      if (healthController) {
        // Its finally block observes the generation mismatch and schedules an
        // immediate replacement without overlapping requests.
        healthController.abort();
        return;
      }
      void pollHealth();
    }

    async function pollHealth() {
      if (cancelled) return;
      const requestSequence = ++healthRequestSequence;
      const requestGeneration = currentGeneration;
      const controller = new AbortController();
      healthController = controller;
      const requestTimeout = setTimeout(
        () => controller.abort(),
        HEALTH_REQUEST_TIMEOUT_MS,
      );

      try {
        const response = await fetch("/health", { signal: controller.signal });
        const data = (await response.json()) as ApiInfo;
        if (
          cancelled ||
          controller.signal.aborted ||
          requestSequence !== healthRequestSequence ||
          requestGeneration !== currentGeneration
        ) {
          return;
        }
        applyServerStatus(data);
      } catch {
        // The stream lifecycle remains authoritative when metadata is
        // temporarily unavailable.
      } finally {
        clearTimeout(requestTimeout);
        if (healthController === controller) healthController = null;
        if (!cancelled && requestSequence === healthRequestSequence) {
          // If a stream boundary made this response stale, refresh metadata
          // immediately; otherwise keep the normal low-frequency cadence.
          const delay =
            requestGeneration === currentGeneration
              ? HEALTH_POLL_INTERVAL_MS
              : 0;
          healthTimer = setTimeout(() => void pollHealth(), delay);
        }
      }
    }
    void pollHealth();

    return () => {
      cancelled = true;
      healthRequestSequence++;
      healthController?.abort();
      if (healthTimer !== null) clearTimeout(healthTimer);
      if (lifecycleTimer !== null) clearInterval(lifecycleTimer);
      worker.removeEventListener("message", onMessage);
      worker.postMessage({ type: "stop", clientEpoch });
      if (clientEpochRef.current === clientEpoch) clientEpochRef.current = 0;
      workerRef.current = null;
    };
  }, [
    canvasRef,
    markTransportLive,
    markTransportSwitching,
    reportTransportError,
    showControlError,
    transport,
  ]);

  // WebCodecs is unavailable on some plain-HTTP LAN origins. Keep the fork's
  // Media Source Extensions fallback for those browsers while the normal path
  // stays in upstream's lower-overhead worker.
  useEffect(() => {
    if (transport !== "websocket") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const canUseWorker =
      typeof Worker === "function" &&
      typeof VideoDecoder === "function" &&
      typeof EncodedVideoChunk === "function" &&
      typeof canvas.transferControlToOffscreen === "function";
    if (canUseWorker) return;
    if (!MsePlayer.isSupported()) {
      reportTransportError("websocket", "WebCodecs and MSE unsupported");
      setState((current) => ({
        ...current,
        status: "WebCodecs and MSE unsupported",
      }));
      return;
    }

    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let player: MsePlayer | null = null;
    let ws: WebSocket | null = null;

    const setStatus = (status: string) =>
      setState((current) =>
        current.status === status ? current : { ...current, status },
      );
    const requestKeyframe = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reset-video", ack: false }));
      }
    };
    const resetPlayer = () => {
      player?.destroy();
      player = null;
    };

    const connect = () => {
      if (cancelled) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(
        `${protocol}//${location.host}/ws?frame-meta=1`,
      );
      ws.binaryType = "arraybuffer";
      directWsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        setStatus("connecting video");
        requestKeyframe();
      };
      ws.onerror = () => setStatus("connection error");
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          handleControlAcknowledgement(event.data);
          try {
            const message = JSON.parse(event.data) as {
              type?: string;
              size?: DeviceSize;
            };
            if (message.type === "video-session" && message.size) {
              resetPlayer();
              setState((current) => ({
                ...current,
                deviceSize: message.size!,
              }));
              requestKeyframe();
            }
          } catch {}
          return;
        }

        const packet = parseFramePacket(event.data as ArrayBuffer);
        const isKey = packet.isKey ?? scanAU(packet.data).isKey;
        if (!player) {
          player = new MsePlayer(canvas, {
            onFirstFrame: () => {
              markTransportLive("websocket");
              setState((current) => ({
                ...current,
                status: "streaming",
                lastRenderedAt: Date.now(),
              }));
            },
            onResize: (width, height) =>
              setState((current) => ({
                ...current,
                deviceSize: { width, height },
              })),
            onFps: (fps) =>
              setState((current) =>
                current.fps === fps ? current : { ...current, fps },
              ),
            onError: (message) => {
              reportTransportError("websocket", message);
              setStatus(message);
            },
            requestKeyframe,
          });
        }
        player.feed(packet.data, isKey, packet.timestamp);
      };
      ws.onclose = () => {
        if (directWsRef.current === ws) directWsRef.current = null;
        if (cancelled) return;
        markTransportSwitching("websocket");
        resetPlayer();
        const retryIn = reconnectDelay;
        setStatus(
          `disconnected — retrying in ${Math.round(retryIn / 1_000)}s`,
        );
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5_000);
        retryTimer = setTimeout(connect, retryIn);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
      if (directWsRef.current === ws) directWsRef.current = null;
      resetPlayer();
    };
  }, [
    canvasRef,
    handleControlAcknowledgement,
    markTransportLive,
    markTransportSwitching,
    reportTransportError,
    transport,
  ]);

  useEffect(() => {
    webRtcTransportRetryAttemptRef.current = 0;
  }, [currentStreamSettingsKey, serverGeneration]);

  // WebRTC carries video; this lightweight WebSocket remains the low-latency
  // scrcpy control channel for touch, keys, text, and keyframe requests.
  useEffect(() => {
    if (transport !== "webrtc") return;
    let cancelled = false;
    let reconnectDelay = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;

    const setStatus = (status: string) =>
      setState((current) =>
        current.status === status ? current : { ...current, status },
      );
    const connect = () => {
      if (cancelled) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${location.host}/ws?video=0`);
      directWsRef.current = ws;
      ws.onopen = () => {
        reconnectDelay = 500;
        ws?.send(JSON.stringify({ type: "reset-video", ack: false }));
      };
      ws.onerror = () => setStatus("input connection error");
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        handleControlAcknowledgement(event.data);
      };
      ws.onclose = () => {
        if (directWsRef.current === ws) directWsRef.current = null;
        if (cancelled) return;
        const retryIn = reconnectDelay;
        setStatus(
          `input disconnected — retrying in ${Math.round(retryIn / 1_000)}s`,
        );
        reconnectDelay = Math.min(Math.round(reconnectDelay * 1.6), 5_000);
        retryTimer = setTimeout(connect, retryIn);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        ws?.close();
      } catch {}
      if (directWsRef.current === ws) directWsRef.current = null;
    };
  }, [handleControlAcknowledgement, transport]);

  useEffect(() => {
    if (transport !== "webrtc" || streamSettings?.transport !== "webrtc") {
      currentWebRtcSessionIdRef.current = null;
      return;
    }
    const video = videoRef.current;
    if (!video) {
      currentWebRtcSessionIdRef.current = null;
      setState((current) => ({
        ...current,
        status: "video element unavailable",
      }));
      return;
    }
    if (
      typeof RTCPeerConnection === "undefined" ||
      typeof RTCRtpReceiver === "undefined"
    ) {
      currentWebRtcSessionIdRef.current = null;
      reportTransportError("webrtc", "WebRTC unsupported");
      setState((current) => ({ ...current, status: "WebRTC unsupported" }));
      return;
    }

    let stopped = false;
    let failing = false;
    let peer: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let firstFrameTimeout: number | undefined;
    let disconnectedTimeout: number | undefined;
    let videoFrameCallback: number | undefined;
    let framePollTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let firstFrameDecoded = false;
    let trackReceived = false;
    let connectionReady = false;
    let fpsCount = 0;
    let fpsTimer = performance.now();
    let lastVideoTime = -1;
    const lifecycleController = new AbortController();
    const sessionId = createWebRtcSessionId();
    markTransportSwitching("webrtc");
    currentWebRtcSessionIdRef.current = sessionId;
    const iceServers = iceServersForBrowser(streamSettings);

    setState((current) => ({
      ...current,
      status: "connecting WebRTC",
      fps: 0,
      stats: null,
      lastRenderedAt: null,
    }));

    const setStatus = (status: string) =>
      setState((current) =>
        current.status === status ? current : { ...current, status },
      );
    const requestKeyframe = () => {
      const ws = directWsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "reset-video", ack: false }));
      }
    };
    const closeRemoteSession = (keepalive = false): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = closeWebRtcSession({
        url: "/webrtc/close",
        sessionId,
        keepalive,
      });
      return closePromise;
    };
    const stopFrameObserver = () => {
      if (
        videoFrameCallback !== undefined &&
        typeof video.cancelVideoFrameCallback === "function"
      ) {
        video.cancelVideoFrameCallback(videoFrameCallback);
        videoFrameCallback = undefined;
      }
      if (framePollTimer !== undefined) {
        window.clearInterval(framePollTimer);
        framePollTimer = undefined;
      }
    };
    const markFrameDecoded = () => {
      const isFirstFrame = !firstFrameDecoded;
      firstFrameDecoded = true;
      webRtcTransportRetryAttemptRef.current = 0;
      if (firstFrameTimeout !== undefined) {
        window.clearTimeout(firstFrameTimeout);
        firstFrameTimeout = undefined;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (isFirstFrame) {
        markTransportLive("webrtc");
        setState((current) => ({
          ...current,
          status: "streaming",
          lastRenderedAt: Date.now(),
          ...(width > 0 && height > 0
            ? { deviceSize: { width, height } }
            : {}),
        }));
      }
      fpsCount++;
      const now = performance.now();
      if (now - fpsTimer >= 1_000) {
        const fps = Math.round((fpsCount * 1_000) / (now - fpsTimer));
        fpsCount = 0;
        fpsTimer = now;
        setState((current) => ({
          ...current,
          status: "streaming",
          fps,
          lastRenderedAt: Date.now(),
          ...(width > 0 &&
          height > 0 &&
          (current.deviceSize?.width !== width ||
            current.deviceSize?.height !== height)
            ? { deviceSize: { width, height } }
            : {}),
        }));
      }
    };
    const startFrameObserver = () => {
      stopFrameObserver();
      if (typeof video.requestVideoFrameCallback === "function") {
        const observe = () => {
          if (stopped) return;
          markFrameDecoded();
          videoFrameCallback = video.requestVideoFrameCallback(observe);
        };
        videoFrameCallback = video.requestVideoFrameCallback(observe);
      } else {
        framePollTimer = window.setInterval(() => {
          if (
            stopped ||
            video.readyState < 2 ||
            video.currentTime === lastVideoTime
          ) {
            return;
          }
          lastVideoTime = video.currentTime;
          markFrameDecoded();
        }, 250);
      }
    };

    const closePeer = () => {
      stopFrameObserver();
      if (firstFrameTimeout !== undefined) {
        window.clearTimeout(firstFrameTimeout);
        firstFrameTimeout = undefined;
      }
      if (disconnectedTimeout !== undefined) {
        window.clearTimeout(disconnectedTimeout);
        disconnectedTimeout = undefined;
      }
      video.srcObject = null;
      peer?.close();
    };
    const failPermanently = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      reportTransportError("webrtc", message);
      setStatus(message);
      closePeer();
      void closeRemoteSession();
    };
    const retryTransport = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      markTransportSwitching("webrtc");
      const attempt = webRtcTransportRetryAttemptRef.current++;
      const delay = Math.min(
        WEBRTC_TRANSPORT_RETRY_BASE_MS * 2 ** Math.min(attempt, 4),
        WEBRTC_TRANSPORT_RETRY_MAX_MS,
      );
      requestKeyframe();
      setStatus(`${message} Retrying…`);
      closePeer();
      void closeRemoteSession();
      retryTimer = window.setTimeout(() => {
        if (!stopped) {
          setWebRtcRetryGeneration((generation) => generation + 1);
        }
      }, delay);
    };
    const armFirstFrameTimeout = () => {
      if (
        stopped ||
        firstFrameDecoded ||
        !trackReceived ||
        !connectionReady ||
        firstFrameTimeout !== undefined
      ) {
        return;
      }
      firstFrameTimeout = window.setTimeout(() => {
        firstFrameTimeout = undefined;
        if (stopped || firstFrameDecoded) return;
        requestKeyframe();
        retryTransport("WebRTC did not establish a video path.");
      }, WEBRTC_FIRST_FRAME_TIMEOUT_MS);
    };

    const releaseOnPageHide = () => void closeRemoteSession(true);
    window.addEventListener("pagehide", releaseOnPageHide);
    window.addEventListener("beforeunload", releaseOnPageHide);

    void (async () => {
      try {
        peer = new RTCPeerConnection({
          iceServers,
          iceTransportPolicy: streamSettings.iceTransportPolicy,
        });
        const transceiver = peer.addTransceiver("video", {
          direction: "recvonly",
        });
        preferH264(transceiver);
        peer.ontrack = (event) => {
          if (stopped) return;
          trackReceived = true;
          firstFrameDecoded = false;
          event.track.onended = () =>
            retryTransport("WebRTC video track ended.");
          video.srcObject =
            event.streams[0] ?? new MediaStream([event.track]);
          void video.play().catch(() => {});
          startFrameObserver();
          armFirstFrameTimeout();
        };
        peer.onconnectionstatechange = () => {
          if (stopped || !peer) return;
          if (peer.connectionState === "connected") {
            connectionReady = true;
            if (disconnectedTimeout !== undefined) {
              window.clearTimeout(disconnectedTimeout);
              disconnectedTimeout = undefined;
            }
            setStatus("WebRTC connected");
            armFirstFrameTimeout();
          } else if (peer.connectionState === "disconnected") {
            connectionReady = false;
            setStatus("WebRTC reconnecting");
            if (disconnectedTimeout === undefined) {
              disconnectedTimeout = window.setTimeout(() => {
                disconnectedTimeout = undefined;
                if (
                  !stopped &&
                  peer?.connectionState !== "connected"
                ) {
                  retryTransport("WebRTC remained disconnected.");
                }
              }, WEBRTC_DISCONNECTED_GRACE_MS);
            }
          } else if (
            peer.connectionState === "failed" ||
            peer.connectionState === "closed"
          ) {
            retryTransport("WebRTC connection failed.");
          }
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForWebRtcIce(peer);
        const local = peer.localDescription;
        if (!local) throw new Error("WebRTC offer was not created");
        const response = await postWebRtcOffer({
          url: "/webrtc/offer",
          signal: lifecycleController.signal,
          requestTimeoutMs: WEBRTC_SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: WEBRTC_BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: WEBRTC_BUSY_RETRY_COUNT,
          body: JSON.stringify({
            type: local.type,
            sdp: local.sdp,
            sessionId,
            codec: streamSettings.codec,
          }),
        });
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel();
          const message = `WebRTC offer failed: HTTP ${status}.`;
          if (
            status === 408 ||
            status === 425 ||
            status === 429 ||
            status >= 500
          ) {
            retryTransport(message);
          } else {
            failPermanently(message);
          }
          return;
        }
        const answer = (await response.json()) as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        if (
          typeof answer !== "object" ||
          answer === null ||
          typeof answer.type !== "string" ||
          typeof answer.sdp !== "string"
        ) {
          failPermanently("WebRTC returned an invalid session description.");
          return;
        }
        await peer.setRemoteDescription(answer);
      } catch (error) {
        if (stopped || lifecycleController.signal.aborted) return;
        if (error instanceof WebRtcSignalingBusyError) {
          retryTransport(error.message);
          return;
        }
        retryTransport(
          error instanceof WebRtcSignalingTimeoutError
            ? "WebRTC signaling timed out."
            : "WebRTC signaling failed.",
        );
      }
    })();

    return () => {
      stopped = true;
      if (currentWebRtcSessionIdRef.current === sessionId) {
        currentWebRtcSessionIdRef.current = null;
      }
      window.removeEventListener("pagehide", releaseOnPageHide);
      window.removeEventListener("beforeunload", releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (firstFrameTimeout !== undefined) {
        window.clearTimeout(firstFrameTimeout);
      }
      if (disconnectedTimeout !== undefined) {
        window.clearTimeout(disconnectedTimeout);
      }
      void closeRemoteSession(true);
      closePeer();
    };
  }, [
    currentStreamSettingsKey,
    markTransportLive,
    markTransportSwitching,
    reportTransportError,
    serverGeneration,
    streamSettings,
    transport,
    videoRef,
    webRtcRetryGeneration,
  ]);

  return {
    state,
    send,
    transport,
    availableTransports: viewerTransports?.available ?? [],
    switchingTo,
    transportError,
    selectTransport,
    statsDownloadStatus,
    statsDownloadMessage,
    downloadStats,
  };
}
