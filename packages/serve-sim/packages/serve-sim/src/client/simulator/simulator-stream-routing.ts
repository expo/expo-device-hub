export type SimulatorStreamMode = "mjpeg" | "avcc" | "webrtc" | "simstream";

export type SimulatorStreamRouting = {
  effectiveStreamMode: SimulatorStreamMode;
  useWebRtc: boolean;
  useAvcc: boolean;
  /** The simstream engine's WebSocket feed; routed like AVCC (canvas), decoded by its own hook. */
  useSimstream: boolean;
  externalInput: boolean;
  externalMjpeg: boolean;
  openDirectControlSocket: boolean;
  openDirectMjpeg: boolean;
};

export function resolveSimulatorStreamRouting({
  streamMode,
  avccSupported,
  hasExternalInput,
  hasExternalFrames,
}: {
  streamMode: SimulatorStreamMode;
  avccSupported: boolean;
  hasExternalInput: boolean;
  hasExternalFrames: boolean;
}): SimulatorStreamRouting {
  const effectiveStreamMode = (streamMode === "avcc" || streamMode === "simstream") && !avccSupported
    ? "mjpeg"
    : streamMode;
  const useWebRtc = effectiveStreamMode === "webrtc";
  const useSimstream = effectiveStreamMode === "simstream";
  const useAvcc = effectiveStreamMode === "avcc" || useSimstream;
  const externalMjpeg = effectiveStreamMode === "mjpeg" && hasExternalFrames;

  return {
    effectiveStreamMode,
    useWebRtc,
    useAvcc,
    useSimstream,
    externalInput: hasExternalInput,
    externalMjpeg,
    openDirectControlSocket: !hasExternalInput,
    openDirectMjpeg: effectiveStreamMode === "mjpeg" && !externalMjpeg,
  };
}
