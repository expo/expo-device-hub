import type { CaptureCounts } from "../../webrtc-sender-stats";

export interface CaptureSample {
  counts: CaptureCounts;
  atMs: number;
}

/** Flow counters read as rates over the poll window; rare events stay as session totals, where a
 * single occurrence an hour ago still matters. */
export interface CaptureWindow {
  screenFps: number | null;
  idleFps: number | null;
  deliveredFps: number | null;
  submittedFps: number | null;
  intervalMs: number | null;
  pickMs: number | null;
  stalls: number | null;
  stallSumMs: number | null;
  cpuFallbacks: number | null;
  pumpRestarts: number | null;
}

const MIN_WINDOW_MS = 250;
/** Poll gaps grow without bound when the tab is backgrounded. A rate over a minute of wall
 * clock is not the "last second" the panel promises, so report nothing rather than a lie. */
const MAX_WINDOW_MS = 4_000;

export function describeCaptureCounts(
  previous: CaptureSample | null,
  current: CaptureSample,
): CaptureWindow {
  const totals = {
    stalls: current.counts.stalls,
    stallSumMs: current.counts.stallSumMs,
    cpuFallbacks: current.counts.cpuFallbacks,
    pumpRestarts: current.counts.pumpRestarts,
  };
  const unusable: CaptureWindow = {
    screenFps: null,
    idleFps: null,
    deliveredFps: null,
    submittedFps: null,
    intervalMs: null,
    pickMs: null,
    ...totals,
  };
  if (previous === null) return unusable;
  const elapsedMs = current.atMs - previous.atMs;
  if (elapsedMs < MIN_WINDOW_MS || elapsedMs > MAX_WINDOW_MS) return unusable;

  const seconds = elapsedMs / 1000;
  const before = previous.counts;
  const after = current.counts;
  return {
    screenFps: rate(before.screenFrames, after.screenFrames, seconds),
    idleFps: rate(before.idleFrames, after.idleFrames, seconds),
    deliveredFps: rate(before.offeredFrames, after.offeredFrames, seconds),
    submittedFps: rate(before.forwardedFrames, after.forwardedFrames, seconds),
    intervalMs: windowMean(
      delta(before.gapSumMs, after.gapSumMs),
      delta(before.attempts, after.attempts),
    ),
    pickMs: windowMean(
      delta(before.pickSumMs, after.pickSumMs),
      delta(before.pickCount, after.pickCount),
    ),
    ...totals,
  };
}

/** A counter that went backwards means the capture was replaced, so the window spans two of them. */
function delta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  const difference = after - before;
  return difference < 0 ? null : difference;
}

function rate(before: number | null, after: number | null, seconds: number): number | null {
  const difference = delta(before, after);
  return difference === null ? null : difference / seconds;
}

function windowMean(total: number | null, count: number | null): number | null {
  if (total === null || count === null || count <= 0) return null;
  return total / count;
}
