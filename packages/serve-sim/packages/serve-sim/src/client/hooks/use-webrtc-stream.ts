import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseInboundVideo,
  readStatsBeforeDeadline,
  startPlaybackStallWatchdog,
} from "./playback-stall-watchdog";
import type { StatsSubscriber } from "./use-stream-stats";
import type { WebRtcCodec, WebRtcStreamFailure } from "../webrtc-codec-fallback";
import {
  offerFailureIsTransient,
  webRtcFailureDisposition,
} from "../webrtc-failure-policy";
import { WEBRTC_ICE_TRANSPORT_POLICY, type IceServer } from "../webrtc-ice";
import { raiseH264OfferLevel } from "../webrtc-sdp-level";
import { webrtcSessionStatsUrl } from "../utils/sim-endpoint";
import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from "../webrtc-negotiation";

const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun1.l.google.com:19302"] },
];
const ICE_GATHERING_TIMEOUT_MS = 3_000;
// Native signaling has its own 10s deadline. Each accepted HTTP attempt gets a
// fresh browser deadline; time spent retrying 409s cannot consume it.
const SIGNALING_REQUEST_TIMEOUT_MS = 20_000;
const FIRST_FRAME_TIMEOUT_MS = 4_000;

/// Whether the sender says it is producing frames. Null on any doubt, because unknown keeps
/// the fallback.
async function senderIsEncoding(
  statsUrl: string | undefined,
  sessionId: string,
): Promise<boolean | null> {
  if (!statsUrl) return null;
  try {
    const response = await fetch(webrtcSessionStatsUrl(statsUrl, sessionId), {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { sessions?: { framesEncoded?: number }[] };
    const sessions = Array.isArray(body.sessions) ? body.sessions : [];
    if (sessions.length === 0) return null;
    return sessions.some((session) => (session.framesEncoded ?? 0) > 0);
  } catch {
    return null;
  }
}

const BUSY_RETRY_INTERVAL_MS = 500;
// Native serializes offer setup. Retry beyond its 10s orphan deadline so one
// stalled negotiation cannot prevent another viewer from joining.
const BUSY_RETRY_COUNT = 30;
const TRANSPORT_RETRY_BASE_MS = 500;
const TRANSPORT_RETRY_MAX_MS = 5_000;

function createSessionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useWebRtcStream({
  offerUrl,
  closeUrl,
  enabled,
  codec = "h264",
  iceServers,
  statsUrl,
  judgeStalls = true,
  transportLocked = false,
}: {
  offerUrl: string;
  closeUrl: string;
  enabled: boolean;
  codec?: WebRtcCodec;
  iceServers?: IceServer[];
  statsUrl?: string;
  /// Off for a stream nobody is looking at: its stats still flow, but a frozen decoder there
  /// must not fail the codec for the one on screen.
  judgeStalls?: boolean;
  /// No HTTP to fall back to, so a rejected offer has to be waited out rather than handed on.
  transportLocked?: boolean;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failure, setFailure] = useState<WebRtcStreamFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);
  const transportRetryAttemptRef = useRef(0);
  // Read at each poll rather than restarting the stream when the shown screen changes.
  const judgeStallsRef = useRef(judgeStalls);
  judgeStallsRef.current = judgeStalls;
  /// One getStats per tick, shared with the stats panel so it does not poll a second time.
  const statsListenersRef = useRef(new Set<(report: RTCStatsReport, at: number) => void>());
  const subscribeStats: StatsSubscriber = useCallback((listener) => {
    const listeners = statsListenersRef.current;
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  /// When this codec was last reconnected for a stall. Cleared when the codec changes.
  const stallReconnectAtRef = useRef<number | null>(null);

  /// Re-establish after a failure the hook cannot resolve itself, such as every codec failing
  /// with HTTP fallback turned off.
  const retry = useCallback(() => {
    setFailure(null);
    setError(null);
    setRetryGeneration((generation) => generation + 1);
  }, []);

  const markFrameDecoded = useCallback(() => {
    firstFrameDecodedRef.current = true;
    transportRetryAttemptRef.current = 0;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }
    setFailure(null);
    setError(null);
  }, []);

  useEffect(() => {
    transportRetryAttemptRef.current = 0;
    stallReconnectAtRef.current = null;
  }, [enabled, offerUrl, closeUrl, codec, iceServers]);

  useEffect(() => {
    if (!enabled || !offerUrl) return;
    setFailure(null);
    if (typeof RTCPeerConnection === "undefined" || typeof RTCRtpReceiver === "undefined") {
      setStream(null);
      setSessionId(null);
      setError("WebRTC is not supported by this browser.");
      setFailure({ sessionId: createSessionId(), kind: "permanent" });
      return;
    }

    let stopped = false;
    let pc: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let failing = false;
    const lifecycleController = new AbortController();
    const sessionId = createSessionId();
    const servers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
    setSessionId(sessionId);
    setStream(null);
    setFailure(null);
    setError(null);
    firstFrameDecodedRef.current = false;
    if (firstFrameTimeoutRef.current !== undefined) {
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    }

    const closeRemoteSession = (keepalive = false): Promise<void> => {
      if (closePromise) return closePromise;
      closePromise = closeWebRtcSession({
        url: closeUrl,
        sessionId,
        keepalive,
      });
      return closePromise;
    };
    const releaseOnPageHide = () => void closeRemoteSession(true);
    window.addEventListener("pagehide", releaseOnPageHide);
    window.addEventListener("beforeunload", releaseOnPageHide);

    let armFirstFrameWatchdog: (() => void) | null = null;
    // One counter per watchdog, or ticks before the first paint retire the other one mid-read.
    let firstFrameGeneration = 0;
    const publishStats = (report: RTCStatsReport, at: number) => {
      for (const listener of statsListenersRef.current) listener(report, at);
    };
    const readable = () => !stopped && pc !== null && document.visibilityState === "visible";
    const stall = startPlaybackStallWatchdog({
      peer: () => pc,
      readable,
      judgeable: () => readable() && !failing && pc?.connectionState === "connected"
        && firstFrameDecodedRef.current && judgeStallsRef.current,
      publish: publishStats,
      reconnectedAt: stallReconnectAtRef,
      failCodec: () => failCodec(),
      retryTransport: (message: string) => retryTransport(message),
    });
    // A hide and resume can complete between two ticks, so the transition itself ends the run.
    const onVisibilityChange = () => {
      stall.invalidate();
      firstFrameGeneration += 1;
      if (firstFrameTimeoutRef.current !== undefined) {
        window.clearTimeout(firstFrameTimeoutRef.current);
        firstFrameTimeoutRef.current = undefined;
      }
      if (document.visibilityState === "visible" && !firstFrameDecodedRef.current && !failing) {
        armFirstFrameWatchdog?.();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    const closePeer = () => {
      setStream(null);
      pc?.close();
      // Readers of `peerConnection` would otherwise keep polling a closed connection for the whole
      // retry backoff, and report its last values as if the stream were still live.
      setPeerConnection(null);
    };

    const failPermanently = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setError(message);
      setFailure({ sessionId, kind: "permanent" });
      closePeer();
      void closeRemoteSession();
    };

    const failCodec = () => {
      if (stopped || failing) return;
      failing = true;
      closePeer();
      void closeRemoteSession().finally(() => {
        if (!stopped) setFailure({ sessionId, kind: "codec", codec });
      });
    };

    const retryTransport = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setFailure(null);
      const attempt = transportRetryAttemptRef.current++;
      const delay = Math.min(
        TRANSPORT_RETRY_BASE_MS * 2 ** Math.min(attempt, 4),
        TRANSPORT_RETRY_MAX_MS,
      );
      setError(`${message} Retrying...`);
      closePeer();
      void closeRemoteSession().finally(() => {
        if (stopped) return;
        retryTimer = window.setTimeout(() => {
          if (!stopped) setRetryGeneration((generation) => generation + 1);
        }, delay);
      });
    };

    const waitForIce = (connection: RTCPeerConnection) =>
      new Promise<void>((resolve) => {
        if (connection.iceGatheringState === "complete") {
          resolve();
          return;
        }
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
        timeout = window.setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      });

    void (async () => {
      try {
        pc = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy: WEBRTC_ICE_TRANSPORT_POLICY,
        });

        setPeerConnection(pc);

        const videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
        const videoCapabilities = RTCRtpReceiver.getCapabilities("video");
        const preferredMimeType = codec === "h264"
          ? "video/H264"
          : codec === "vp9"
            ? "video/VP9"
            : "video/VP8";
        if (videoCapabilities?.codecs.length && "setCodecPreferences" in videoTransceiver) {
          const normalizedPreferredMimeType = preferredMimeType.toLowerCase();
          videoTransceiver.setCodecPreferences([
            ...videoCapabilities.codecs.filter((candidate) =>
              candidate.mimeType.toLowerCase() === normalizedPreferredMimeType
            ),
            ...videoCapabilities.codecs.filter((candidate) =>
              candidate.mimeType.toLowerCase() !== normalizedPreferredMimeType
            ),
          ]);
        }

        pc.ontrack = (event) => {
          if (stopped) return;
          firstFrameDecodedRef.current = false;
          event.track.onended = () => retryTransport("WebRTC video track ended.");
          setStream(event.streams[0] ?? new MediaStream([event.track]));
          if (firstFrameTimeoutRef.current !== undefined) {
            window.clearTimeout(firstFrameTimeoutRef.current);
          }
          // One extra window when RTP is arriving, so a slow first paint is not mistaken
          // for a broken codec. Bounded: an undecodable stream still falls back.
          stall.invalidate();
          let graceUsed = false;
          armFirstFrameWatchdog = () => {
            firstFrameTimeoutRef.current = window.setTimeout(() => {
              firstFrameTimeoutRef.current = undefined;
              if (stopped || firstFrameDecodedRef.current || document.visibilityState !== "visible") return;
              const reading = firstFrameGeneration;
              void (async () => {
                const firstFrameReport = await readStatsBeforeDeadline(pc, FIRST_FRAME_TIMEOUT_MS);
                const reports = firstFrameReport ? parseInboundVideo(firstFrameReport) : [];
                if (stopped || firstFrameDecodedRef.current || reading !== firstFrameGeneration) return;
                const mediaArriving = reports.some((report) => report.framesReceived > 0);
                const senderEncoding = mediaArriving
                  ? null
                  : await senderIsEncoding(statsUrl, sessionId);
                if (stopped || firstFrameDecodedRef.current || reading !== firstFrameGeneration
                  || document.visibilityState !== "visible") return;
                const disposition = webRtcFailureDisposition("first-frame-timeout", pc?.connectionState ?? "closed", {
                  mediaArriving,
                  senderEncoding,
                });
                if (disposition === "wait" && !graceUsed) {
                  graceUsed = true;
                  armFirstFrameWatchdog?.();
                } else if (disposition === "transport") {
                  retryTransport("WebRTC did not establish a video path.");
                } else {
                  failCodec();
                }
              })();
            }, FIRST_FRAME_TIMEOUT_MS);
          };
          if (document.visibilityState === "visible") armFirstFrameWatchdog();
        };
        pc.onconnectionstatechange = () => {
          if (stopped || !pc || pc.connectionState !== "failed") return;
          if (webRtcFailureDisposition("connection-failed", pc.connectionState) === "transport") {
            retryTransport("WebRTC connection failed.");
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIce(pc);
        const local = pc.localDescription;
        if (!local) throw new Error("WebRTC offer was not created");
        // Only what the encoder reads is rewritten; our own description stays as the
        // browser built it. See raiseH264OfferLevel.
        const offerSdp = codec === "h264" ? raiseH264OfferLevel(local.sdp) : local.sdp;
        const response = await postWebRtcOffer({
          url: offerUrl,
          signal: lifecycleController.signal,
          requestTimeoutMs: SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: BUSY_RETRY_COUNT,
          body: JSON.stringify({
            type: local.type,
            sdp: offerSdp,
            sessionId,
            codec,
            iceServers: servers,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const message = `WebRTC offer failed: HTTP ${response.status}.`;
          // Where HTTP is available, handing the failure on gets a picture back immediately.
          // Only a locked session, which has nowhere to go, waits the status out.
          if (transportLocked && offerFailureIsTransient(response.status)) retryTransport(message);
          else failPermanently(message);
          return;
        }
        const answer = await response.json() as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        try {
          await pc.setRemoteDescription(answer);
        } catch {
          failPermanently("WebRTC returned an invalid session description.");
        }
      } catch (caught) {
        if (stopped || lifecycleController.signal.aborted) return;
        if (caught instanceof WebRtcSignalingBusyError) {
          // 409 is the server saying it is busy right now, which clears by itself. Its message
          // asks for a reload, which is the one thing a locked session cannot do for itself.
          if (transportLocked) retryTransport("WebRTC signaling stayed busy.");
          else failPermanently(caught.message);
          return;
        }
        const message = caught instanceof WebRtcSignalingTimeoutError
          ? "WebRTC signaling timed out."
          : "WebRTC signaling failed.";
        if (webRtcFailureDisposition("signaling-failed", pc?.connectionState ?? "closed") === "transport") {
          retryTransport(message);
        }
      }
    })();

    return () => {
      stopped = true;
      stall.stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", releaseOnPageHide);
      window.removeEventListener("beforeunload", releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (firstFrameTimeoutRef.current !== undefined) {
        window.clearTimeout(firstFrameTimeoutRef.current);
        firstFrameTimeoutRef.current = undefined;
      }
      void closeRemoteSession(true);
      setStream(null);
      setPeerConnection(null);
      setSessionId(null);
      pc?.close();
    };
  }, [enabled, offerUrl, closeUrl, codec, iceServers, statsUrl, retryGeneration, transportLocked]);

  return { stream, failure, error, markFrameDecoded, peerConnection, sessionId, retry, subscribeStats };
}
