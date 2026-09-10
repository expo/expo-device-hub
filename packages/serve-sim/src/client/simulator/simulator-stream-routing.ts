export type SimulatorStreamMode = "mjpeg" | "avcc" | "webrtc";

export type SimulatorStreamRouting = {
  effectiveStreamMode: SimulatorStreamMode;
  useWebRtc: boolean;
  useAvcc: boolean;
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
  const effectiveStreamMode = streamMode === "avcc" && !avccSupported
    ? "mjpeg"
    : streamMode;
  const useWebRtc = effectiveStreamMode === "webrtc";
  const useAvcc = effectiveStreamMode === "avcc";
  const externalMjpeg = effectiveStreamMode === "mjpeg" && hasExternalFrames;

  return {
    effectiveStreamMode,
    useWebRtc,
    useAvcc,
    externalInput: hasExternalInput,
    externalMjpeg,
    openDirectControlSocket: !hasExternalInput,
    openDirectMjpeg: effectiveStreamMode === "mjpeg" && !externalMjpeg,
  };
}
