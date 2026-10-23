/**
 * Streams the iPhone Duo's panels into the elements a consumer attached
 * through `DeviceClient.displays`, following serve-sim's
 * `src/client/components/duo-panel-streams.tsx` (@expo/serve-sim 0.5.0). Each
 * panel keeps decoding while the other one is presented, so a fold can hand
 * off without a reconnect. Transport handling reuses the Hub's AVCC and WebRTC
 * hooks instead of serve-sim's `SimulatorView`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AVCC_FRAME_TIMEOUT_MS } from "../avcc-fallback";
import { type SessionFetch, sessionTokenFetch, withSessionTokenQuery } from "../session-token";
import { type DeviceStreamStats, type VideoSurfaceKind } from "../types";
import { useAvccStream } from "../useAvccStream";
import { type WebRtcIceServer, useWebRtcStream } from "../useWebRtcStream";
import { type WebRtcCodec, type WebRtcStreamFailure } from "../webrtc-fallback";
import { type DuoPanelId } from "./duo-fold";
import {
  type DuoPanelStatus,
  type DuoPanelStreamMode,
  duoPanelStatus,
  duoPanelUrl,
} from "./duo-panels";
import { useMjpegPanel } from "./useMjpegPanel";

/** What both panel streams share with the flat stream. */
export interface DuoPanelFeeds {
  /** Helper base URL; each panel streams from `${url}/panel/<1|3>/…`. */
  url: string;
  /** Session token for the same backend as the flat stream. */
  token?: string | null;
  /**
   * The helper session, as for the flat stream's readers. A replaced helper at
   * the same URL changes it, which restarts both panels' readers.
   */
  session?: string | null;
  mode: DuoPanelStreamMode;
  codec: WebRtcCodec;
  iceServers?: WebRtcIceServer[];
  /** serve-sim locks this session to WebRTC, as for the flat stream. */
  transportLocked?: boolean;
  /** Collect statistics, for the presented panel only. */
  statsEnabled?: boolean;
  /** A frame of the presented panel was painted. */
  onFrame?: () => void;
  /** The H.264 decoder failed; the client falls back to MJPEG. */
  onAvccError: () => void;
  onWebRtcFailure: (failure: WebRtcStreamFailure) => void;
}

/** An element the consumer attached for one panel, with the kind it was attached as. */
export type DuoPanelElement = {
  kind: VideoSurfaceKind;
  element: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement;
};

export const DUO_PANEL_KIND: Record<DuoPanelStreamMode, VideoSurfaceKind> = {
  mjpeg: "img",
  avcc: "canvas",
  webrtc: "video",
};

type DuoPanelStreamState = DuoPanelStatus & { stats: DeviceStreamStats | null };

function useDuoPanelStream(
  screenId: DuoPanelId,
  attached: DuoPanelElement | null,
  feeds: DuoPanelFeeds | null,
  activeScreenId: DuoPanelId,
): DuoPanelStreamState {
  const mode = feeds?.mode;
  const token = feeds?.token ?? null;
  const session = feeds?.session ?? null;
  // Every reader depends on this function, so a new helper session gets new readers.
  const sessionFetch = useMemo<SessionFetch>(() => {
    const tokenFetch = sessionTokenFetch(token);
    return session === null ? tokenFetch : (input, init) => tokenFetch(input, init);
  }, [token, session]);
  const url = feeds ? duoPanelUrl(feeds.url, screenId) : "";
  const element = mode && attached?.kind === DUO_PANEL_KIND[mode] ? attached.element : null;
  const img = mode === "mjpeg" ? (element as HTMLImageElement | null) : null;
  const canvas = mode === "avcc" ? (element as HTMLCanvasElement | null) : null;
  const video = mode === "webrtc" ? (element as HTMLVideoElement | null) : null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  canvasRef.current = canvas;
  const active = activeScreenId === screenId;
  const [streaming, setStreaming] = useState(false);
  const decoded = useRef(false);
  const avccDecoded = useRef(false);
  const lastFrameAt = useRef(0);
  const [feedGeneration, setFeedGeneration] = useState(0);
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Stable, so a panel handoff never restarts the hidden feed's decoder.
  const onFrame = useCallback(() => {
    lastFrameAt.current = Date.now();
    if (!decoded.current) {
      decoded.current = true;
      setStreaming(true);
    }
    if (activeRef.current) feedsRef.current?.onFrame?.();
  }, []);

  const resetStreaming = useCallback(() => {
    decoded.current = false;
    avccDecoded.current = false;
    lastFrameAt.current = 0;
    setStreaming(false);
    setFeedGeneration((generation) => generation + 1);
  }, []);

  useMjpegPanel(img ? `${url}/stream.mjpeg` : null, img, onFrame, sessionFetch, resetStreaming);

  useAvccStream({
    url,
    enabled: !!canvas,
    canvasRef,
    fetchImpl: sessionFetch,
    onFrame,
    onConnecting: resetStreaming,
    // onFrame also presents the JPEG seed, which says nothing about H.264 support.
    onDecodedFrame: () => {
      avccDecoded.current = true;
    },
    onDecoderError: () => feedsRef.current?.onAvccError(),
  });

  const {
    stream: webRtcStream,
    failure: webRtcFailure,
    error: webRtcError,
    retrying: webRtcRetrying,
    markFrameDecoded,
    streamStats,
    setStreamStatsEnabled,
  } = useWebRtcStream({
    offerUrl: `${url}/webrtc/offer`,
    closeUrl: `${url}/webrtc/close`,
    closeBeaconUrl: withSessionTokenQuery(`${url}/webrtc/close`, token),
    statsUrl: `${url}/webrtc/stats`,
    enabled: !!video,
    codec: feeds?.codec ?? "h264",
    iceServers: feeds?.iceServers,
    fetchImpl: sessionFetch,
    transportLocked: feeds?.transportLocked ?? false,
    raiseH264Level: true,
    // iOS keeps the inactive panel silent until a handoff; only the shown
    // panel's missing frames mean a codec or transport problem.
    judgeStalls: active,
  });

  const statsEnabled = active && (feeds?.statsEnabled ?? false);
  useEffect(() => {
    setStreamStatsEnabled(statsEnabled);
  }, [setStreamStatsEnabled, statsEnabled]);

  useEffect(() => {
    if (!video) return;
    let stopped = false;
    let frameCallback = 0;
    const markFrame = () => {
      if (stopped) return;
      markFrameDecoded();
      onFrame();
    };
    const onVideoFrame: VideoFrameRequestCallback = () => {
      markFrame();
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();
    // Like serve-sim's panel view and the flat stream, the first loaded frame
    // counts even when frame callbacks do not run, for example in a hidden tab.
    const onLoadedData = () => {
      if (stopped) return;
      markFrameDecoded(0);
      onFrame();
    };
    video.srcObject = webRtcStream;
    if (webRtcStream) {
      if (typeof video.requestVideoFrameCallback === "function") {
        frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        video.addEventListener("timeupdate", onTimeUpdate);
      }
      video.addEventListener("loadeddata", onLoadedData, { once: true });
      void video.play().catch(() => {});
    }
    return () => {
      stopped = true;
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.srcObject = null;
    };
  }, [video, webRtcStream, markFrameDecoded, onFrame]);

  useEffect(() => {
    resetStreaming();
  }, [url, mode, element, sessionFetch, webRtcStream, resetStreaming]);

  useEffect(() => {
    // Every iOS client runs this hook; a panel without an element has nothing to watch.
    if (!element) return;
    const check = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const staleAfter = mode === "webrtc" ? 3_000 : 2_000;
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > staleAfter) {
        decoded.current = false;
        setStreaming(false);
      }
    };
    const timer = setInterval(check, 1_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", check);
    };
  }, [mode, element]);

  useEffect(() => {
    // Codec verdicts are only meaningful for the shown panel; permanent
    // failures of either panel still reach the shared codec policy.
    if (!video || !webRtcFailure) return;
    if (active || webRtcFailure.kind !== "codec") feedsRef.current?.onWebRtcFailure(webRtcFailure);
  }, [video, webRtcFailure, active]);

  useEffect(() => {
    // An inactive panel may stay silent until iOS wakes it. Only the intended
    // display gets a startup deadline, and a previously decoded panel can idle
    // without permanently downgrading a working session to MJPEG.
    if (!canvas || !active || avccDecoded.current) return;
    const timer = setTimeout(() => {
      if (!avccDecoded.current) feedsRef.current?.onAvccError();
    }, AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, canvas, active, sessionFetch, feedGeneration]);

  return {
    streaming,
    // A transport retry reconnects by itself, as on the flat stream.
    error: video && !webRtcRetrying ? webRtcError : null,
    failure: video ? webRtcFailure : null,
    stats: video ? streamStats : null,
  };
}

/**
 * Both panels decode while the hinge moves. The presented panel's health and
 * statistics stand for the connection; the other panel can stay silent.
 */
export function useDuoPanelStreams(
  feeds: DuoPanelFeeds | null,
  elements: Readonly<Record<DuoPanelId, DuoPanelElement | null>>,
  activeScreenId: DuoPanelId,
): { streaming: boolean; error: string | null; stats: DeviceStreamStats | null } {
  const cover = useDuoPanelStream(1, elements[1], feeds, activeScreenId);
  const inner = useDuoPanelStream(3, elements[3], feeds, activeScreenId);
  const status = duoPanelStatus(feeds?.mode ?? "mjpeg", activeScreenId, { 1: cover, 3: inner });
  return { ...status, stats: (activeScreenId === 1 ? cover : inner).stats };
}
