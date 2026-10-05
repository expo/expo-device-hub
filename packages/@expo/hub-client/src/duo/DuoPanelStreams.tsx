/**
 * Keeps both iPhone Duo panel feeds decoding while the 3D model shows one of
 * them, following serve-sim's `src/client/components/duo-panel-streams.tsx`
 * (@expo/serve-sim 0.5.0). Each panel paints into a hidden element under
 * `[data-duo-panel]`, which the scene samples for its textures. Transport
 * handling reuses the Hub's AVCC and WebRTC hooks instead of serve-sim's
 * `SimulatorView`; only the 3D scene handles input.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { AVCC_FRAME_TIMEOUT_MS } from '../avcc-fallback';
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
  const { mode, codec, iceServers } = feeds;
  const url = duoPanelUrl(feeds.url, screenId);
  const active = activeScreenId === screenId;
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [streaming, setStreaming] = useState(false);
  const decoded = useRef(false);
  const avccDecoded = useRef(false);
  const feedsRef = useRef(feeds);
  feedsRef.current = feeds;
  const activeRef = useRef(active);
  activeRef.current = active;

  // Stable, so a panel handoff never restarts the hidden feed's decoder.
  const onFrame = useCallback(() => {
    if (!decoded.current) {
      decoded.current = true;
      setStreaming(true);
    }
    if (activeRef.current) feedsRef.current.onFrame?.();
  }, []);

  useMjpegPanel(mode === 'mjpeg' ? `${url}/stream.mjpeg` : null, imgRef, onFrame);

  useAvccStream({
    url,
    enabled: mode === 'avcc',
    canvasRef,
    onFrame,
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
  } = useWebRtcStream({
    offerUrl: `${url}/webrtc/offer`,
    closeUrl: `${url}/webrtc/close`,
    statsUrl: `${url}/webrtc/stats`,
    enabled: mode === 'webrtc',
    codec,
    iceServers,
    // iOS keeps the inactive panel silent until a handoff; only the shown
    // panel's missing frames mean a codec or transport problem.
    judgeStalls: active,
  });

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
    video.srcObject = webRtcStream;
    if (webRtcStream) {
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallback = video.requestVideoFrameCallback(onVideoFrame);
      } else {
        video.addEventListener('timeupdate', onTimeUpdate);
      }
      void video.play().catch(() => {});
    }
    return () => {
      stopped = true;
      video.removeEventListener('timeupdate', onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback);
      }
      video.srcObject = null;
    };
  }, [mode, webRtcStream, markFrameDecoded, onFrame]);

  useEffect(() => {
    decoded.current = false;
    avccDecoded.current = false;
    setStreaming(false);
  }, [url, mode]);

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
  }, [url, mode, active]);

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
