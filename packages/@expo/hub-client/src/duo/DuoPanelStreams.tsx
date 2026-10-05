/**
 * Keeps both iPhone Duo panel feeds decoding while the 3D model shows one of
 * them, following serve-sim's `src/client/components/duo-panel-streams.tsx`
 * (@expo/serve-sim 0.5.0). Each panel paints into a hidden element under
 * `[data-duo-panel]`, which the scene samples for its textures. Transport
 * handling reuses the Hub's AVCC and WebRTC hooks instead of serve-sim's
 * `SimulatorView`; only the 3D scene handles input.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AVCC_FRAME_TIMEOUT_MS } from '../avcc-fallback';
import { sessionTokenFetch, withSessionTokenQuery } from '../session-token';
import { type DuoPanelFeeds } from '../types';
import { useAvccStream } from '../useAvccStream';
import { useWebRtcStream } from '../useWebRtcStream';
import {
  DUO_PANEL_CONFIG,
  EMPTY_DUO_PANEL_STATUS,
  duoPanelStatus,
  duoPanelUrl,
  type DuoPanelId,
  type DuoPanelStatus,
} from './duo-panels';
import { useMjpegPanel } from './useMjpegPanel';

function DuoPanelStream({
  screenId,
  feeds,
  activeScreenId,
  onStatusChange,
}: {
  screenId: DuoPanelId;
  feeds: DuoPanelFeeds;
  activeScreenId: DuoPanelId;
  onStatusChange: (screenId: DuoPanelId, status: DuoPanelStatus) => void;
}) {
  const { mode, codec, iceServers, token = null } = feeds;
  const sessionFetch = useMemo(() => sessionTokenFetch(token), [token]);
  const url = duoPanelUrl(feeds.url, screenId);
  const active = activeScreenId === screenId;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
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
    if (activeRef.current) feedsRef.current.onFrame?.();
  }, []);

  const resetStreaming = useCallback(() => {
    decoded.current = false;
    avccDecoded.current = false;
    lastFrameAt.current = 0;
    setStreaming(false);
    setFeedGeneration((generation) => generation + 1);
  }, []);

  useMjpegPanel(
    mode === 'mjpeg' ? `${url}/stream.mjpeg` : null,
    imgRef,
    onFrame,
    sessionFetch,
    resetStreaming,
  );

  useAvccStream({
    url,
    enabled: mode === 'avcc',
    canvasRef,
    fetchImpl: sessionFetch,
    onFrame,
    onConnecting: resetStreaming,
    // onFrame also presents the JPEG seed, which says nothing about H.264 support.
    onDecodedFrame: () => {
      avccDecoded.current = true;
    },
    onDecoderError: () => feedsRef.current.onAvccError(),
  });

  const {
    stream: webRtcStream,
    failure: webRtcFailure,
    error: webRtcError,
    markFrameDecoded,
    streamStats,
  } = useWebRtcStream({
    offerUrl: `${url}/webrtc/offer`,
    closeUrl: `${url}/webrtc/close`,
    closeBeaconUrl: withSessionTokenQuery(`${url}/webrtc/close`, token),
    statsUrl: `${url}/webrtc/stats`,
    enabled: mode === 'webrtc',
    codec,
    iceServers,
    fetchImpl: sessionFetch,
    // iOS keeps the inactive panel silent until a handoff; only the shown
    // panel's missing frames mean a codec or transport problem.
    judgeStalls: active,
    statsEnabled: active && (feeds.statsEnabled ?? false),
  });

  useEffect(() => {
    if (active) feedsRef.current.onStatsChange?.(mode === 'webrtc' ? streamStats : null);
  }, [active, mode, streamStats]);

  useEffect(() => {
    if (mode !== 'webrtc') return;
    const video = videoRef.current;
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
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        video.addEventListener('timeupdate', onTimeUpdate);
      }
      video.addEventListener('loadeddata', onLoadedData, { once: true });
      void video.play().catch(() => {});
    }
    return () => {
      stopped = true;
      video.removeEventListener('loadeddata', onLoadedData);
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.srcObject = null;
    };
  }, [mode, webRtcStream, markFrameDecoded, onFrame]);

  useEffect(() => {
    resetStreaming();
  }, [url, mode, sessionFetch, webRtcStream, resetStreaming]);

  useEffect(() => {
    const check = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const staleAfter = mode === 'webrtc' ? 3_000 : 2_000;
      if (lastFrameAt.current && Date.now() - lastFrameAt.current > staleAfter) {
        decoded.current = false;
        setStreaming(false);
      }
    };
    const timer = setInterval(check, 1_000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', check);
    };
  }, [mode]);

  useEffect(() => {
    onStatusChange(screenId, { streaming, error: webRtcError, failure: webRtcFailure });
  }, [screenId, streaming, webRtcError, webRtcFailure, onStatusChange]);
  useEffect(() => {
    // Codec verdicts are only meaningful for the shown panel; transport and
    // permanent failures of either panel still drive the shared fallback.
    if (mode !== 'webrtc' || !webRtcFailure) return;
    if (active || webRtcFailure.kind !== 'codec') feedsRef.current.onWebRtcFailure(webRtcFailure);
  }, [mode, webRtcFailure, active]);

  useEffect(() => {
    // An inactive panel may stay silent until iOS wakes it. Only the intended
    // display gets a startup deadline, and a previously decoded panel can idle
    // without permanently downgrading a working session to MJPEG.
    if (mode !== 'avcc' || !active || avccDecoded.current) return;
    const timer = setTimeout(() => {
      if (!avccDecoded.current) feedsRef.current.onAvccError();
    }, AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, mode, active, sessionFetch, feedGeneration]);

  const config = DUO_PANEL_CONFIG[screenId];
  const mediaStyle = {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  } as const;
  return (
    <div
      data-duo-panel={screenId}
      style={{
        position: 'absolute',
        inset: 0,
        visibility: active ? 'visible' : 'hidden',
        aspectRatio: `${config.width} / ${config.height}`,
      }}
    >
      {mode === 'avcc' ? (
        <canvas ref={canvasRef} style={mediaStyle} />
      ) : mode === 'webrtc' ? (
        <video ref={videoRef} autoPlay muted playsInline style={mediaStyle} />
      ) : (
        <img ref={imgRef} alt="" draggable={false} style={mediaStyle} />
      )}
    </div>
  );
}

/** Both decoders stay mounted while the hinge moves; only the 3D scene handles input. */
export function DuoPanelStreams({
  feeds,
  activeScreenId,
}: {
  feeds: DuoPanelFeeds;
  activeScreenId: DuoPanelId;
}) {
  const [statuses, setStatuses] = useState<Record<DuoPanelId, DuoPanelStatus>>({
    1: EMPTY_DUO_PANEL_STATUS,
    3: EMPTY_DUO_PANEL_STATUS,
  });
  const onStatusChange = useCallback((screenId: DuoPanelId, status: DuoPanelStatus) => {
    setStatuses((previous) => ({ ...previous, [screenId]: status }));
  }, []);
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const status = duoPanelStatus(feeds.mode, activeScreenId, statuses);
  useEffect(() => {
    feedsRef.current.onStreamingChange(status.streaming);
  }, [status.streaming]);
  useEffect(() => {
    feedsRef.current.onStreamError(status.error);
  }, [status.error]);
  useEffect(
    () => () => {
      feedsRef.current.onStreamingChange(false);
      feedsRef.current.onStreamError(null);
      feedsRef.current.onStatsChange?.(null);
    },
    [],
  );
  return (
    <>
      {([1, 3] as const).map((screenId) => (
        <DuoPanelStream
          key={screenId}
          screenId={screenId}
          feeds={feeds}
          activeScreenId={activeScreenId}
          onStatusChange={onStatusChange}
        />
      ))}
    </>
  );
}
