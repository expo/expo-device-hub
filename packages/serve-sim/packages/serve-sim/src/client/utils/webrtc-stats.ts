// Pure and separate from the polling so the rate maths are testable without a peer connection.

const MIN_WINDOW_MS = 250;

export interface StreamStatsSample {
  atMs: number;
  framesDecoded: number;
  framesDropped: number;
  freezeCount: number;
  freezeMs: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number | null;
  jitterMs: number | null;
  /** Cumulative, so the windowed delay is derived from two samples rather than read directly. */
  jitterBufferSeconds: number | null;
  jitterBufferEmitted: number | null;
  /** libwebrtc's own figure, kept for the export as a cross-check on our window maths. */
  reportedFps: number | null;
  /** Cumulative sum and sum-of-squares, which together give the spread without a histogram. */
  interFrameDelaySeconds: number | null;
  interFrameDelaySquaredSeconds: number | null;
  decodeSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  roundTripMs: number | null;
  /** `relay` means media crosses TURN, which costs latency and throughput. */
  path: "direct" | "relay" | "unknown";
}

export interface StreamStats extends StreamStatsSample {
  fps: number | null;
  kbps: number | null;
  /** 0-1, per-window rather than lifetime. */
  lossRatio: number | null;
  droppedInWindow: number | null;
  freezesInWindow: number | null;
  freezeMsInWindow: number | null;
  /** Mean delay over the frames emitted in this window, not over the session. */
  jitterBufferMs: number | null;
  /** Standard deviation of the gap between delivered frames; a locked cadence sits near zero.
   * This is the cadence the viewer sees, so it covers transport and decode. The sender paces its
   * own output and repeats its last frame, so a capture stall does not have to show up here. */
  pacingDeviationMs: number | null;
  /** Mean gap between delivered frames, the value pacingDeviationMs is the spread around. */
  frameGapMs: number | null;
  decodeMsPerFrame: number | null;
}

function number(value: unknown): number {
  return maybeNumber(value) ?? 0;
}

function maybeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `now` is injected so tests are not clock-dependent. */
export function readStreamStats(report: RTCStatsReport, now: number): StreamStatsSample {
  const sample: StreamStatsSample = {
    atMs: now,
    framesDecoded: 0,
    framesDropped: 0,
    freezeCount: 0,
    freezeMs: 0,
    bytesReceived: 0,
    packetsReceived: 0,
    packetsLost: null,
    jitterMs: null,
    jitterBufferSeconds: null,
    jitterBufferEmitted: null,
    reportedFps: null,
    interFrameDelaySeconds: null,
    interFrameDelaySquaredSeconds: null,
    decodeSeconds: null,
    width: null,
    height: null,
    codec: null,
    roundTripMs: null,
    path: "unknown",
  };

  const codecsById = new Map<string, string>();
  const pairsById = new Map<string, Record<string, unknown>>();
  const candidatesById = new Map<string, Record<string, unknown>>();
  let selectedPairId: string | null = null;
  let nominatedPair: Record<string, unknown> | null = null;
  let succeededPair: Record<string, unknown> | null = null;

  report.forEach((entry: Record<string, unknown>) => {
    switch (entry.type) {
      case "codec":
        if (typeof entry.id === "string" && typeof entry.mimeType === "string") {
          codecsById.set(entry.id, entry.mimeType);
        }
        break;
      case "inbound-rtp": {
        if (entry.kind !== "video") break;
        // A second video entry (an unused simulcast layer, or a previous ssrc) would otherwise
        // overwrite the live one purely by report order.
        const framesDecoded = number(entry.framesDecoded);
        if (framesDecoded < sample.framesDecoded) break;
        sample.framesDecoded = framesDecoded;
        sample.framesDropped = number(entry.framesDropped);
        sample.freezeCount = number(entry.freezeCount);
        sample.freezeMs = number(entry.totalFreezesDuration) * 1000;
        sample.bytesReceived = number(entry.bytesReceived);
        sample.packetsReceived = number(entry.packetsReceived);
        sample.packetsLost = maybeNumber(entry.packetsLost);
        sample.reportedFps = maybeNumber(entry.framesPerSecond);
        sample.interFrameDelaySeconds = maybeNumber(entry.totalInterFrameDelay);
        sample.interFrameDelaySquaredSeconds = maybeNumber(entry.totalSquaredInterFrameDelay);
        sample.decodeSeconds = maybeNumber(entry.totalDecodeTime);
        sample.width = maybeNumber(entry.frameWidth);
        sample.height = maybeNumber(entry.frameHeight);
        const jitter = maybeNumber(entry.jitter);
        sample.jitterMs = jitter === null ? null : jitter * 1000;
        sample.jitterBufferSeconds = maybeNumber(entry.jitterBufferDelay);
        sample.jitterBufferEmitted = maybeNumber(entry.jitterBufferEmittedCount);
        if (typeof entry.codecId === "string") sample.codec = codecsById.get(entry.codecId) ?? null;
        break;
      }
      case "transport":
        // Chrome names the live pair here; it exposes no `selected` flag on the pair itself.
        if (typeof entry.selectedCandidatePairId === "string") {
          selectedPairId = entry.selectedCandidatePairId;
        }
        break;
      case "candidate-pair":
        if (typeof entry.id === "string") pairsById.set(entry.id, entry);
        if (entry.selected === true) nominatedPair = entry;
        else if (entry.nominated === true && entry.state === "succeeded") nominatedPair ??= entry;
        else if (entry.state === "succeeded") succeededPair ??= entry;
        break;
      case "local-candidate":
      case "remote-candidate":
        if (typeof entry.id === "string") candidatesById.set(entry.id, entry);
        break;
    }
  });

  const selectedPair = (selectedPairId === null ? undefined : pairsById.get(selectedPairId))
    ?? nominatedPair
    ?? succeededPair;
  if (selectedPair) {
    const rtt = maybeNumber(selectedPair.currentRoundTripTime);
    sample.roundTripMs = rtt === null ? null : rtt * 1000;
    const ends = [selectedPair.localCandidateId, selectedPair.remoteCandidateId].map((id) =>
      typeof id === "string" ? candidatesById.get(id)?.candidateType : undefined,
    );
    if (ends.every((type) => typeof type === "string")) {
      sample.path = ends.includes("relay") ? "relay" : "direct";
    }
  }

  // A codec entry can arrive without an inbound-rtp codecId on some browsers.
  if (sample.codec === null && codecsById.size === 1) {
    sample.codec = [...codecsById.values()][0] ?? null;
  }
  return sample;
}

/** Null rates when the window is unusable, rather than a misleading zero. */
export function describeStreamStats(
  previous: StreamStatsSample | null,
  current: StreamStatsSample,
): StreamStats {
  const unusable: StreamStats = {
    ...current,
    fps: null,
    kbps: null,
    lossRatio: null,
    droppedInWindow: null,
    freezesInWindow: null,
    freezeMsInWindow: null,
    jitterBufferMs: null,
    pacingDeviationMs: null,
    frameGapMs: null,
    decodeMsPerFrame: null,
  };
  if (previous === null) return unusable;

  const elapsedMs = current.atMs - previous.atMs;
  // getStats latency can compress the window, and rates over a sliver are noise, not measurement.
  if (elapsedMs < MIN_WINDOW_MS) return unusable;

  // A counter that went backwards means the stream was replaced, so the whole window spans two
  // different streams. Reporting zero here would read as a measured stall.
  const decoded = current.framesDecoded - previous.framesDecoded;
  const bytes = current.bytesReceived - previous.bytesReceived;
  const dropped = current.framesDropped - previous.framesDropped;
  const freezes = current.freezeCount - previous.freezeCount;
  const freezeMs = current.freezeMs - previous.freezeMs;
  if (decoded < 0 || bytes < 0 || dropped < 0 || freezes < 0 || freezeMs < 0) return unusable;

  const seconds = elapsedMs / 1000;
  const frameGap = windowFrameGap(previous, current, decoded);
  return {
    ...current,
    fps: decoded / seconds,
    kbps: (bytes * 8) / 1000 / seconds,
    lossRatio: windowLossRatio(previous, current),
    droppedInWindow: dropped,
    freezesInWindow: freezes,
    freezeMsInWindow: freezeMs,
    jitterBufferMs: windowJitterBufferMs(previous, current),
    pacingDeviationMs: frameGap?.deviationMs ?? null,
    frameGapMs: frameGap?.meanMs ?? null,
    decodeMsPerFrame: windowDecodeMsPerFrame(previous, current, decoded),
  };
}

/** Mean and spread of the inter-frame gap, from the cumulative sum and sum-of-squares libwebrtc keeps.
 * Variance can go slightly negative through floating-point cancellation, so it is clamped. */
function windowFrameGap(
  previous: StreamStatsSample,
  current: StreamStatsSample,
  frames: number,
): { meanMs: number; deviationMs: number } | null {
  if (previous.interFrameDelaySeconds === null || current.interFrameDelaySeconds === null) {
    return null;
  }
  if (
    previous.interFrameDelaySquaredSeconds === null
    || current.interFrameDelaySquaredSeconds === null
  ) {
    return null;
  }
  // A spread needs two samples. One frame yields 0 by construction, which would render a
  // stalled window as a perfectly even one.
  if (frames < 2) return null;
  const sum = current.interFrameDelaySeconds - previous.interFrameDelaySeconds;
  const squared = current.interFrameDelaySquaredSeconds - previous.interFrameDelaySquaredSeconds;
  if (sum < 0 || squared < 0) return null;
  const mean = sum / frames;
  return {
    meanMs: mean * 1000,
    deviationMs: Math.sqrt(Math.max(0, squared / frames - mean * mean)) * 1000,
  };
}

function windowDecodeMsPerFrame(
  previous: StreamStatsSample,
  current: StreamStatsSample,
  frames: number,
): number | null {
  if (previous.decodeSeconds === null || current.decodeSeconds === null) return null;
  if (frames <= 0) return null;
  const decode = current.decodeSeconds - previous.decodeSeconds;
  if (decode < 0) return null;
  return (decode / frames) * 1000;
}

/** Both counters must move forward, or the ratio is taken across two different streams. */
function windowLossRatio(previous: StreamStatsSample, current: StreamStatsSample): number | null {
  if (previous.packetsLost === null || current.packetsLost === null) return null;
  const lost = current.packetsLost - previous.packetsLost;
  const received = current.packetsReceived - previous.packetsReceived;
  if (lost < 0 || received < 0) return null;
  const expected = received + lost;
  return expected > 0 ? lost / expected : null;
}

function windowJitterBufferMs(
  previous: StreamStatsSample,
  current: StreamStatsSample,
): number | null {
  if (current.jitterBufferSeconds === null || current.jitterBufferEmitted === null) return null;
  if (previous.jitterBufferSeconds === null || previous.jitterBufferEmitted === null) return null;
  const delay = current.jitterBufferSeconds - previous.jitterBufferSeconds;
  const emitted = current.jitterBufferEmitted - previous.jitterBufferEmitted;
  if (delay < 0 || emitted <= 0) return null;
  return (delay / emitted) * 1000;
}
