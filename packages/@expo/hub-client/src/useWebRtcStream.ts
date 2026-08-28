import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type WebRtcCodec,
  type WebRtcStreamFailure,
  webRtcFailureDisposition,
} from './webrtc-fallback';
import {
  closeWebRtcSession,
  postWebRtcOffer,
  WebRtcSignalingBusyError,
  WebRtcSignalingTimeoutError,
} from './webrtc-negotiation';
import { useWebRtcStreamStats, type WebRtcStatsConnection } from './stream-stats';

export type WebRtcIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

const DEFAULT_ICE_SERVERS: WebRtcIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: ['stun:stun1.l.google.com:19302'] },
];
const ICE_GATHERING_TIMEOUT_MS = 3_000;
const SIGNALING_REQUEST_TIMEOUT_MS = 20_000;
const FIRST_FRAME_TIMEOUT_MS = 4_000;
const BUSY_RETRY_INTERVAL_MS = 500;
const BUSY_RETRY_COUNT = 30;
const TRANSPORT_RETRY_BASE_MS = 500;
const TRANSPORT_RETRY_MAX_MS = 5_000;
const DISCONNECTED_GRACE_MS = 10_000;

export type WebRtcVideoCodecCapability = {
  mimeType: string;
  sdpFmtpLine?: string;
};

/** Keep serve-emu's packetization-mode=1 H.264 formats ahead of incompatible formats. */
export function preferredVideoCodecs<Capability extends WebRtcVideoCodecCapability>(
  codecs: readonly Capability[],
  codec: WebRtcCodec,
): Capability[] {
  const preferredMimeType =
    codec === 'h264' ? 'video/h264' : codec === 'vp9' ? 'video/vp9' : 'video/vp8';
  if (codec !== 'h264') {
    return [
      ...codecs.filter((candidate) => candidate.mimeType.toLowerCase() === preferredMimeType),
      ...codecs.filter((candidate) => candidate.mimeType.toLowerCase() !== preferredMimeType),
    ];
  }

  const isH264 = (candidate: Capability) => candidate.mimeType.toLowerCase() === preferredMimeType;
  const hasPacketizationMode1 = (candidate: Capability) =>
    /(?:^|;)\s*packetization-mode=1(?:\s*;|$)/i.test(candidate.sdpFmtpLine ?? '');
  return [
    ...codecs.filter((candidate) => isH264(candidate) && hasPacketizationMode1(candidate)),
    ...codecs.filter((candidate) => isH264(candidate) && !hasPacketizationMode1(candidate)),
    ...codecs.filter((candidate) => !isH264(candidate)),
  ];
}

export function buildWebRtcOfferPayload({
  description,
  sessionId,
  codec,
  iceServers,
  sendIceServersInOffer = true,
}: {
  description: RTCSessionDescriptionInit;
  sessionId: string;
  codec: WebRtcCodec;
  iceServers: WebRtcIceServer[];
  sendIceServersInOffer?: boolean;
}): Record<string, unknown> {
  return {
    type: description.type,
    sdp: description.sdp,
    sessionId,
    codec,
    ...(sendIceServersInOffer ? { iceServers } : {}),
  };
}

export function isRetryableWebRtcOfferStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function shouldFallbackCodecAfterFirstFrameTimeout(
  allowCodecFallback: boolean,
  connectionState: RTCPeerConnectionState,
): boolean {
  return (
    allowCodecFallback &&
    webRtcFailureDisposition('first-frame-timeout', connectionState) === 'codec'
  );
}

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Negotiate and maintain a recv-only serve-sim / serve-emu WebRTC stream. */
export function useWebRtcStream({
  offerUrl,
  closeUrl,
  statsUrl = '',
  enabled,
  codec,
  iceServers,
  iceTransportPolicy = 'all',
  sendIceServersInOffer = true,
  allowCodecFallback = true,
  onKeyframeNeeded,
}: {
  offerUrl: string;
  closeUrl: string;
  /** Device-scoped WebRTC sender statistics endpoint. */
  statsUrl?: string;
  enabled: boolean;
  codec: WebRtcCodec;
  iceServers?: WebRtcIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  sendIceServersInOffer?: boolean;
  allowCodecFallback?: boolean;
  onKeyframeNeeded?: () => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failure, setFailure] = useState<WebRtcStreamFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statsConnection, setStatsConnection] = useState<WebRtcStatsConnection | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);
  const presentedFramesRef = useRef(0);
  const transportRetryAttemptRef = useRef(0);
  const streamStats = useWebRtcStreamStats(statsConnection, statsUrl, presentedFramesRef);

  const markFrameDecoded = useCallback(() => {
    presentedFramesRef.current++;
    if (firstFrameDecodedRef.current) return;
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
  }, [
    enabled,
    offerUrl,
    closeUrl,
    codec,
    iceServers,
    iceTransportPolicy,
    sendIceServersInOffer,
    allowCodecFallback,
  ]);

  useEffect(() => {
    if (!enabled || !offerUrl) return;
    setFailure(null);
    if (typeof RTCPeerConnection === 'undefined' || typeof RTCRtpReceiver === 'undefined') {
      setStream(null);
      setStatsConnection(null);
      setError('WebRTC is not supported by this browser.');
      setFailure({ sessionId: createSessionId(), kind: 'permanent' });
      return;
    }

    let stopped = false;
    let peer: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let disconnectedTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let failing = false;
    let trackReceived = false;
    let connectionReady = false;
    const lifecycleController = new AbortController();
    const sessionId = createSessionId();
    const servers = iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS;
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
      closePromise = closeWebRtcSession({ url: closeUrl, sessionId, keepalive });
      return closePromise;
    };
    const releaseOnPageHide = () => void closeRemoteSession(true);
    window.addEventListener('pagehide', releaseOnPageHide);
    window.addEventListener('beforeunload', releaseOnPageHide);

    const clearFirstFrameTimeout = () => {
      if (firstFrameTimeoutRef.current === undefined) return;
      window.clearTimeout(firstFrameTimeoutRef.current);
      firstFrameTimeoutRef.current = undefined;
    };

    const clearDisconnectedTimer = () => {
      if (disconnectedTimer === undefined) return;
      window.clearTimeout(disconnectedTimer);
      disconnectedTimer = undefined;
    };

    const closePeer = () => {
      clearFirstFrameTimeout();
      clearDisconnectedTimer();
      setStream(null);
      setStatsConnection((current) =>
        current?.sessionId === sessionId ? null : current,
      );
      peer?.close();
    };

    const requestKeyframe = () => {
      try {
        onKeyframeNeeded?.();
      } catch {}
    };

    const failPermanently = (message: string) => {
      if (stopped || failing) return;
      failing = true;
      setError(message);
      setFailure({ sessionId, kind: 'permanent' });
      closePeer();
      void closeRemoteSession();
    };

    const failCodec = () => {
      if (stopped || failing) return;
      failing = true;
      closePeer();
      void closeRemoteSession().finally(() => {
        if (!stopped) setFailure({ sessionId, kind: 'codec', codec });
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
      requestKeyframe();
      setError(`${message} Retrying...`);
      closePeer();
      void closeRemoteSession();
      retryTimer = window.setTimeout(() => {
        if (!stopped) setRetryGeneration((generation) => generation + 1);
      }, delay);
    };

    const armFirstFrameTimeout = () => {
      if (
        stopped ||
        firstFrameDecodedRef.current ||
        !trackReceived ||
        !connectionReady ||
        firstFrameTimeoutRef.current !== undefined
      ) {
        return;
      }
      firstFrameTimeoutRef.current = window.setTimeout(() => {
        firstFrameTimeoutRef.current = undefined;
        if (stopped || firstFrameDecodedRef.current) return;
        const state = peer?.connectionState ?? 'closed';
        if (shouldFallbackCodecAfterFirstFrameTimeout(allowCodecFallback, state)) {
          requestKeyframe();
          failCodec();
        } else {
          retryTransport('WebRTC did not establish a video path.');
        }
      }, FIRST_FRAME_TIMEOUT_MS);
    };

    const waitForIce = (connection: RTCPeerConnection) =>
      new Promise<void>((resolve) => {
        if (connection.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        let timeout: number | undefined;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          connection.removeEventListener('icegatheringstatechange', onState);
          if (timeout !== undefined) window.clearTimeout(timeout);
          resolve();
        };
        const onState = () => {
          if (connection.iceGatheringState === 'complete') finish();
        };
        connection.addEventListener('icegatheringstatechange', onState);
        timeout = window.setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      });

    void (async () => {
      try {
        peer = new RTCPeerConnection({
          iceServers: servers,
          iceTransportPolicy,
        });
        setStatsConnection({ peerConnection: peer, sessionId });

        const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        if (capabilities?.codecs.length && 'setCodecPreferences' in transceiver) {
          transceiver.setCodecPreferences(preferredVideoCodecs(capabilities.codecs, codec));
        }

        peer.ontrack = (event) => {
          if (stopped) return;
          trackReceived = true;
          firstFrameDecodedRef.current = false;
          event.track.onended = () => retryTransport('WebRTC video track ended.');
          setStream(event.streams[0] ?? new MediaStream([event.track]));
          clearFirstFrameTimeout();
          armFirstFrameTimeout();
        };
        peer.onconnectionstatechange = () => {
          if (stopped || !peer) return;
          if (peer.connectionState === 'connected') {
            connectionReady = true;
            clearDisconnectedTimer();
            armFirstFrameTimeout();
          } else if (peer.connectionState === 'disconnected') {
            connectionReady = false;
            clearFirstFrameTimeout();
            if (disconnectedTimer === undefined) {
              disconnectedTimer = window.setTimeout(() => {
                disconnectedTimer = undefined;
                if (stopped || !peer || peer.connectionState === 'connected') return;
                retryTransport('WebRTC remained disconnected.');
              }, DISCONNECTED_GRACE_MS);
            }
          } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
            retryTransport('WebRTC connection failed.');
          }
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIce(peer);
        const local = peer.localDescription;
        if (!local) throw new Error('WebRTC offer was not created');
        const response = await postWebRtcOffer({
          url: offerUrl,
          signal: lifecycleController.signal,
          requestTimeoutMs: SIGNALING_REQUEST_TIMEOUT_MS,
          busyRetryIntervalMs: BUSY_RETRY_INTERVAL_MS,
          busyRetryCount: BUSY_RETRY_COUNT,
          body: JSON.stringify(
            buildWebRtcOfferPayload({
              description: local,
              sessionId,
              codec,
              iceServers: servers,
              sendIceServersInOffer,
            }),
          ),
        });
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel();
          const message = `WebRTC offer failed: HTTP ${status}.`;
          if (isRetryableWebRtcOfferStatus(status)) retryTransport(message);
          else failPermanently(message);
          return;
        }
        const answer = (await response.json()) as RTCSessionDescriptionInit;
        if (stopped) {
          await closeRemoteSession(true);
          return;
        }
        try {
          await peer.setRemoteDescription(answer);
        } catch {
          failPermanently('WebRTC returned an invalid session description.');
        }
      } catch (caught) {
        if (stopped || lifecycleController.signal.aborted) return;
        if (caught instanceof WebRtcSignalingBusyError) {
          retryTransport('WebRTC signaling stayed busy for too long.');
          return;
        }
        const message =
          caught instanceof WebRtcSignalingTimeoutError
            ? 'WebRTC signaling timed out.'
            : 'WebRTC signaling failed.';
        retryTransport(message);
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener('pagehide', releaseOnPageHide);
      window.removeEventListener('beforeunload', releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      clearFirstFrameTimeout();
      clearDisconnectedTimer();
      void closeRemoteSession(true);
      setStream(null);
      setStatsConnection((current) =>
        current?.sessionId === sessionId ? null : current,
      );
      peer?.close();
    };
  }, [
    enabled,
    offerUrl,
    closeUrl,
    codec,
    iceServers,
    iceTransportPolicy,
    sendIceServersInOffer,
    allowCodecFallback,
    onKeyframeNeeded,
    retryGeneration,
  ]);

  return { stream, failure, error, markFrameDecoded, streamStats };
}
