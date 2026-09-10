// libwebrtc reports seconds and bits/second; the receiver stats are ms and kbps. Convert here so
// the two views are comparable.

export interface SenderStreamStats {
  sessionId: string;
  codec: string | null;
  connected: boolean;
  /** `cpu` means the encoder cannot keep up; `bandwidth` means the path cannot carry the bitrate. */
  qualityLimitationReason: string | null;
  qualityLimitationMs: Record<string, number>;
  framesEncoded: number;
  framesSent: number;
  reportedFps: number | null;
  targetKbps: number | null;
  totalEncodeMs: number | null;
  encodeMsPerFrame: number | null;
  width: number | null;
  height: number | null;
  packetsSent: number;
  packetsLost: number;
  /** 0-1, lifetime rather than windowed. */
  lossRatio: number | null;
  roundTripMs: number | null;
  /** `relay` means media crosses TURN, which costs latency and throughput. */
  path: "direct" | "relay" | "unknown";
  /** libwebrtc's own view, between what we forward and what the encoder takes: says which one drops. */
  sourceFrames: number | null;
  sourceFps: number | null;
  sourceFramesDropped: number | null;
}

export interface CaptureCounts {
  screenFrames: number;
  idleFrames: number;
  offeredFrames: number | null;
  forwardedFrames: number | null;
  /** Frame-pump watchdog restarts; nonzero means the host starved or dropped pump timers. */
  pumpRestarts: number | null;
}

export interface SenderStats {
  capture?: CaptureCounts | null;
  sessions: SenderStreamStats[];
}

export function senderSessionForViewer(
  sessions: readonly SenderStreamStats[],
  sessionId: string,
): SenderStreamStats | null {
  return sessions.find((session) => session.sessionId === sessionId) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function maybeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function durationsMs(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const durations: Record<string, number> = {};
  for (const [reason, seconds] of Object.entries(value)) {
    const parsed = maybeNumber(seconds);
    if (parsed !== null) durations[reason] = parsed * 1000;
  }
  return durations;
}

function candidatePath(local: unknown, remote: unknown): SenderStreamStats["path"] {
  const ends = [maybeString(local), maybeString(remote)];
  if (ends.some((type) => type === null)) return "unknown";
  return ends.includes("relay") ? "relay" : "direct";
}

function readSenderSession(raw: Record<string, unknown>): SenderStreamStats {
  const framesEncoded = number(raw.framesEncoded);
  const packetsSent = number(raw.packetsSent);
  const packetsLost = number(raw.packetsLost);
  const totalEncodeTime = maybeNumber(raw.totalEncodeTime);
  const targetBitrate = maybeNumber(raw.targetBitrate);
  const roundTripTime = maybeNumber(raw.roundTripTime);
  return {
    sessionId: maybeString(raw.sessionId) ?? "",
    sourceFrames: maybeNumber(raw.sourceFrames),
    sourceFps: maybeNumber(raw.sourceFramesPerSecond),
    sourceFramesDropped: maybeNumber(raw.sourceFramesDropped),
    codec: maybeString(raw.codec),
    connected: raw.connected === true,
    qualityLimitationReason: maybeString(raw.qualityLimitationReason),
    qualityLimitationMs: durationsMs(raw.qualityLimitationDurations),
    framesEncoded,
    framesSent: number(raw.framesSent),
    reportedFps: maybeNumber(raw.framesPerSecond),
    targetKbps: targetBitrate === null ? null : targetBitrate / 1000,
    totalEncodeMs: totalEncodeTime === null ? null : totalEncodeTime * 1000,
    encodeMsPerFrame: totalEncodeTime === null || framesEncoded <= 0
      ? null
      : (totalEncodeTime * 1000) / framesEncoded,
    width: maybeNumber(raw.frameWidth),
    height: maybeNumber(raw.frameHeight),
    packetsSent,
    packetsLost,
    lossRatio: packetsSent > 0 ? Math.max(0, packetsLost) / packetsSent : null,
    roundTripMs: roundTripTime === null ? null : roundTripTime * 1000,
    path: candidatePath(raw.localCandidateType, raw.remoteCandidateType),
  };
}

export function readSenderStats(raw: unknown): SenderStats {
  if (!isRecord(raw) || !Array.isArray(raw.sessions)) return { sessions: [] };
  return {
    sessions: raw.sessions.filter(isRecord).map(readSenderSession),
    capture: readCaptureCounts(raw.capture),
  };
}

/**
 * Frames the guest actually drew, versus frames the idle floor re-emitted.
 *
 * This is what separates a static screen from a stalled capture: both show few encoded frames, but only
 * a stall shows the screen count flat while the guest was drawing.
 */
function readCaptureCounts(raw: unknown): CaptureCounts | null {
  if (!isRecord(raw)) return null;
  const screenFrames = raw.screenFrames;
  const idleFrames = raw.idleFrames;
  if (typeof screenFrames !== "number" || typeof idleFrames !== "number") return null;
  return {
    screenFrames,
    idleFrames,
    offeredFrames: typeof raw.offeredFrames === "number" ? raw.offeredFrames : null,
    forwardedFrames: typeof raw.forwardedFrames === "number" ? raw.forwardedFrames : null,
    pumpRestarts: typeof raw.pumpRestarts === "number" ? raw.pumpRestarts : null,
  };
}
