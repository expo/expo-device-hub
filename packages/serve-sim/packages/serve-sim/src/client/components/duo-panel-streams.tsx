import { useCallback, useEffect, useRef, useState } from "react";
import { SimulatorView } from "../simulator/simulator-view";
import { useMjpegStream } from "../hooks/use-mjpeg-stream";
import { useWebRtcStream } from "../hooks/use-webrtc-stream";
import type { StatsSubscriber } from "../hooks/use-stream-stats";
import { AVCC_FRAME_TIMEOUT_MS } from "../avcc-fallback";
import type { SimulatorStreamMode } from "../simulator/simulator-stream-routing";
import type { StreamConfig } from "../types";
import type { WebRtcCodec, WebRtcStreamFailure } from "../webrtc-codec-fallback";
import type { IceServer } from "../webrtc-ice";

export function duoPanelUrl(streamUrl: string, screenId: 1 | 3): string {
  const url = new URL(streamUrl);
  url.pathname = url.pathname.replace(/\/stream\.[^/]+$/, `/panel/${screenId}`);
  url.search = "";
  url.hash = "";
  return url.toString();
}

interface DuoPanelStreamsProps {
  streamUrl: string;
  mode: SimulatorStreamMode;
  activeScreenId?: number;
  codec: WebRtcCodec;
  iceServers?: IceServer[];
  onStreamingChange: (streaming: boolean) => void;
  onStreamError?: (error: string | null) => void;
  onAvccError: () => void;
  onWebRtcFailure: (failure: WebRtcStreamFailure) => void;
  onWebRtcPeerChange: (peer: DuoPanelPeer | null) => void;
}

export interface DuoPanelPeer {
  peerConnection: RTCPeerConnection | null;
  sessionId: string | null;
  statsUrl: string;
  /// This screen's own `getStats` reader. The panel shares it rather than opening a second.
  subscribeStats: StatsSubscriber;
  retry: () => void;
}

type PanelStatus = {
  streaming: boolean;
  error: string | null;
  failure: WebRtcStreamFailure | null;
};
const EMPTY_STATUS: PanelStatus = { streaming: false, error: null, failure: null };

/** Health belongs to the displayed panel; the other decoder can remain healthy independently. */
export function duoPanelStatus(mode: SimulatorStreamMode, screenId: number | undefined, panels: Record<1 | 3, PanelStatus>) {
  const panel = panels[screenId === 1 ? 1 : 3];
  const error = mode === "webrtc"
    ? panel.error ?? (panel.failure
      ? panel.failure.kind === "codec"
        ? "WebRTC could not decode this display."
        : "WebRTC streaming failed for this display."
      : null)
    : null;
  return { streaming: panel.streaming && !error, error };
}

// Framebuffer dimensions only establish the hidden source view's layout.
// The scene reads each decoded frame's actual size for its texture mapping.
const PANEL_CONFIG: Record<1 | 3, StreamConfig> = {
  1: { width: 1398, height: 2034, screenId: 1, orientation: "portrait" },
  3: { width: 2007, height: 2853, screenId: 3, orientation: "portrait" },
};
const ignoreSourceTouch = () => {};

function DuoPanelStream({
  screenId, streamUrl, mode, activeScreenId, codec, iceServers,
  onStatusChange, onAvccError, onWebRtcFailure, onPeerChange,
}: Omit<DuoPanelStreamsProps, "onStreamingChange" | "onWebRtcPeerChange" | "onStreamError"> & {
  screenId: 1 | 3;
  onStatusChange: (screenId: 1 | 3, status: PanelStatus) => void;
  onPeerChange: (screenId: 1 | 3, peer: DuoPanelPeer | null) => void;
}) {
  const url = duoPanelUrl(streamUrl, screenId);
  const mjpeg = useMjpegStream(mode === "mjpeg" ? `${url}/stream.mjpeg` : null);
  const webrtc = useWebRtcStream({
    offerUrl: `${url}/webrtc/offer`, closeUrl: `${url}/webrtc/close`,
    statsUrl: `${url}/webrtc/stats`,
    enabled: mode === "webrtc", codec, iceServers,
    judgeStalls: activeScreenId === screenId,
  });
  const [streaming, setStreaming] = useState(false);
  useEffect(() => {
    onStatusChange(screenId, { streaming, error: webrtc.error, failure: webrtc.failure });
  }, [screenId, streaming, webrtc.error, webrtc.failure, onStatusChange]);
  useEffect(() => {
    if (mode === "webrtc" && webrtc.failure) onWebRtcFailure(webrtc.failure);
  }, [mode, webrtc.failure, onWebRtcFailure]);
  useEffect(() => {
    onPeerChange(screenId, mode === "webrtc" ? {
      peerConnection: webrtc.peerConnection, sessionId: webrtc.sessionId, statsUrl: `${url}/webrtc/stats`,
      subscribeStats: webrtc.subscribeStats, retry: webrtc.retry,
    } : null);
    return () => onPeerChange(screenId, null);
  }, [mode, screenId, url, webrtc.peerConnection, webrtc.sessionId, webrtc.subscribeStats, webrtc.retry, onPeerChange]);

  const decoded = useRef(false);
  const onDecodedFrame = useCallback(() => { decoded.current = true; }, []);
  useEffect(() => {
    decoded.current = false;
  }, [url, mode]);
  useEffect(() => {
    // An inactive panel may stay silent until iOS wakes it. Only the intended
    // display gets a startup deadline, and a previously decoded panel can idle
    // without permanently downgrading a working session to MJPEG.
    if (mode !== "avcc" || activeScreenId !== screenId || decoded.current) return;
    const timer = setTimeout(() => {
      if (!decoded.current) onAvccError();
    }, AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, mode, activeScreenId, screenId, onAvccError]);
  return (
    <div data-duo-panel={screenId} style={{ position: "absolute", inset: 0, visibility: activeScreenId === screenId ? "visible" : "hidden" }}>
      <SimulatorView
        key={mode}
        url={url}
        style={{ width: "100%", height: "100%" }}
        streamMode={mode}
        streamConfig={PANEL_CONFIG[screenId]}
        subscribeFrame={mode === "mjpeg" ? mjpeg.subscribeFrame : undefined}
        webRtcStream={webrtc.stream}
        onWebRtcFrame={webrtc.markFrameDecoded}
        streamError={webrtc.error}
        onAvccError={onAvccError}
        onAvccDecodedFrame={onDecodedFrame}
        onStreamingChange={setStreaming}
        onStreamTouch={ignoreSourceTouch}
        hideControls
      />
    </div>
  );
}

/** Both decoders stay mounted while the hinge moves; only the 3D scene handles input. */
export function DuoPanelStreams(props: DuoPanelStreamsProps) {
  const [statuses, setStatuses] = useState<Record<1 | 3, PanelStatus>>({ 1: EMPTY_STATUS, 3: EMPTY_STATUS });
  const [peers, setPeers] = useState<Record<1 | 3, DuoPanelPeer | null>>({ 1: null, 3: null });
  const onPeerChange = useCallback((screenId: 1 | 3, peer: DuoPanelPeer | null) => {
    setPeers((previous) => previous[screenId] === peer ? previous : { ...previous, [screenId]: peer });
  }, []);
  const onStatusChange = useCallback((screenId: 1 | 3, status: PanelStatus) => {
    setStatuses((previous) => ({ ...previous, [screenId]: status }));
  }, []);
  const { onStreamingChange, onStreamError, onWebRtcPeerChange, activeScreenId } = props;
  const status = duoPanelStatus(props.mode, activeScreenId, statuses);
  useEffect(() => {
    const shown = peers[activeScreenId === 1 ? 1 : 3];
    onWebRtcPeerChange(shown && {
      ...shown,
      retry: () => { peers[1]?.retry(); peers[3]?.retry(); },
    });
  }, [peers, activeScreenId, onWebRtcPeerChange]);
  useEffect(() => () => onWebRtcPeerChange(null), [onWebRtcPeerChange]);
  useEffect(() => {
    onStreamingChange(status.streaming);
  }, [status.streaming, onStreamingChange]);
  useEffect(() => () => onStreamingChange(false), [onStreamingChange]);
  useEffect(() => { onStreamError?.(status.error); }, [status.error, onStreamError]);
  useEffect(() => () => onStreamError?.(null), [onStreamError]);
  return <>{([1, 3] as const).map((screenId) => (
    <DuoPanelStream key={screenId} {...props} screenId={screenId} onStatusChange={onStatusChange} onPeerChange={onPeerChange} />
  ))}</>;
}
