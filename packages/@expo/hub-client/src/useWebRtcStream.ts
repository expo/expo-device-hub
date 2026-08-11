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

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Negotiate and maintain serve-sim's recv-only WebRTC stream. */
export function useWebRtcStream({
  offerUrl,
  closeUrl,
  enabled,
  codec,
  iceServers,
}: {
  offerUrl: string;
  closeUrl: string;
  enabled: boolean;
  codec: WebRtcCodec;
  iceServers?: WebRtcIceServer[];
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [failure, setFailure] = useState<WebRtcStreamFailure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const firstFrameTimeoutRef = useRef<number | undefined>(undefined);
  const firstFrameDecodedRef = useRef(false);
  const transportRetryAttemptRef = useRef(0);

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
  }, [enabled, offerUrl, closeUrl, codec, iceServers]);

  useEffect(() => {
    if (!enabled || !offerUrl) return;
    setFailure(null);
    if (typeof RTCPeerConnection === 'undefined' || typeof RTCRtpReceiver === 'undefined') {
      setStream(null);
      setError('WebRTC is not supported by this browser.');
      setFailure({ sessionId: createSessionId(), kind: 'permanent' });
      return;
    }

    let stopped = false;
    let peer: RTCPeerConnection | null = null;
    let retryTimer: number | undefined;
    let closePromise: Promise<void> | null = null;
    let failing = false;
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

    const closePeer = () => {
      setStream(null);
      peer?.close();
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
          iceTransportPolicy: 'all',
        });

        const transceiver = peer.addTransceiver('video', { direction: 'recvonly' });
        const capabilities = RTCRtpReceiver.getCapabilities('video');
        const preferredMimeType =
          codec === 'h264' ? 'video/H264' : codec === 'vp9' ? 'video/VP9' : 'video/VP8';
        if (capabilities?.codecs.length && 'setCodecPreferences' in transceiver) {
          const preferred = preferredMimeType.toLowerCase();
          transceiver.setCodecPreferences([
            ...capabilities.codecs.filter((candidate) => candidate.mimeType.toLowerCase() === preferred),
            ...capabilities.codecs.filter((candidate) => candidate.mimeType.toLowerCase() !== preferred),
          ]);
        }

        peer.ontrack = (event) => {
          if (stopped) return;
          firstFrameDecodedRef.current = false;
          event.track.onended = () => retryTransport('WebRTC video track ended.');
          setStream(event.streams[0] ?? new MediaStream([event.track]));
          if (firstFrameTimeoutRef.current !== undefined) {
            window.clearTimeout(firstFrameTimeoutRef.current);
          }
          firstFrameTimeoutRef.current = window.setTimeout(() => {
            firstFrameTimeoutRef.current = undefined;
            if (stopped || firstFrameDecodedRef.current) return;
            const state = peer?.connectionState ?? 'closed';
            if (webRtcFailureDisposition('first-frame-timeout', state) === 'codec') failCodec();
            else retryTransport('WebRTC did not establish a video path.');
          }, FIRST_FRAME_TIMEOUT_MS);
        };
        peer.onconnectionstatechange = () => {
          if (stopped || !peer || peer.connectionState !== 'failed') return;
          if (webRtcFailureDisposition('connection-failed', peer.connectionState) === 'transport') {
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
          body: JSON.stringify({
            type: local.type,
            sdp: local.sdp,
            sessionId,
            codec,
            iceServers: servers,
          }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          failPermanently(`WebRTC offer failed: HTTP ${response.status}`);
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
          failPermanently(caught.message);
          return;
        }
        const message =
          caught instanceof WebRtcSignalingTimeoutError
            ? 'WebRTC signaling timed out.'
            : 'WebRTC signaling failed.';
        if (webRtcFailureDisposition('signaling-failed', peer?.connectionState ?? 'closed') === 'transport') {
          retryTransport(message);
        }
      }
    })();

    return () => {
      stopped = true;
      window.removeEventListener('pagehide', releaseOnPageHide);
      window.removeEventListener('beforeunload', releaseOnPageHide);
      lifecycleController.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      if (firstFrameTimeoutRef.current !== undefined) {
        window.clearTimeout(firstFrameTimeoutRef.current);
        firstFrameTimeoutRef.current = undefined;
      }
      void closeRemoteSession(true);
      setStream(null);
      peer?.close();
    };
  }, [enabled, offerUrl, closeUrl, codec, iceServers, retryGeneration]);

  return { stream, failure, error, markFrameDecoded };
}
