import {
  type AgentInteraction,
  type AgentInteractionPoint,
  type AgentInteractionSegment,
} from './types';

const CURSOR_TRAVEL_MS = 220;
export const AGENT_INTERACTION_IDLE_TIMEOUT_MS = 60 * 1000;

export function agentInteractionEndMs(interaction: AgentInteraction): number {
  return interaction.segments.reduce(
    (latest, segment) => Math.max(latest, segment.startMs + (segment.frames.at(-1)?.atMs ?? 0)),
    0
  );
}

/** Timestamp after which the settled cursor should no longer be visible. */
export function agentInteractionCursorExpiresAt(
  interaction: AgentInteraction,
  fallbackStartedAt = Date.now()
): number {
  const parsedTimestamp = Date.parse(interaction.timestamp);
  const startedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallbackStartedAt;
  return startedAt + agentInteractionEndMs(interaction) + AGENT_INTERACTION_IDLE_TIMEOUT_MS;
}

/** Resolve the visible agent finger positions for one moment on the MCP-call timeline. */
export function agentInteractionPointsAt(
  interaction: AgentInteraction,
  elapsedMs: number
): AgentInteractionPoint[] {
  const firstSegment = interaction.segments[0];
  if (!firstSegment) return [];

  let segmentIndex = 0;
  for (let index = 0; index < interaction.segments.length; index++) {
    const candidate = interaction.segments[index];
    if (!candidate) continue;
    if (candidate.startMs > elapsedMs) break;
    segmentIndex = index;
  }
  const segment = interaction.segments[segmentIndex] ?? firstSegment;
  const nextSegment = interaction.segments[segmentIndex + 1];
  const lastFrame = segment.frames.at(-1);
  const segmentEndMs = segment.startMs + (lastFrame?.atMs ?? 0);

  if (nextSegment && lastFrame && elapsedMs >= segmentEndMs) {
    const nextFrame = nextSegment.frames[0];
    const travelMs = nextSegment.startMs - segmentEndMs;
    if (nextFrame && travelMs > 0 && lastFrame.points.length === nextFrame.points.length) {
      return interpolatePoints(
        lastFrame.points,
        nextFrame.points,
        easeInOutCubic((elapsedMs - segmentEndMs) / travelMs)
      );
    }
  }
  return pointsWithinSegment(segment, Math.max(0, elapsedMs - segment.startMs));
}

/** Duration of the synthetic cursor move between separate Argent log records. */
export function agentInteractionTravelMs(
  previousPoints: AgentInteractionPoint[],
  interaction: AgentInteraction
): number {
  const nextPoints = agentInteractionPointsAt(interaction, 0);
  if (previousPoints.length !== nextPoints.length || previousPoints.length === 0) return 0;
  return previousPoints.some((point, index) => {
    const nextPoint = nextPoints[index];
    return nextPoint && (point.x !== nextPoint.x || point.y !== nextPoint.y);
  })
    ? CURSOR_TRAVEL_MS
    : 0;
}

/** Move from the last visible cursor position before replaying the next log record. */
export function agentInteractionPointsWithTravelAt(
  interaction: AgentInteraction,
  previousPoints: AgentInteractionPoint[],
  elapsedMs: number
): AgentInteractionPoint[] {
  const travelMs = agentInteractionTravelMs(previousPoints, interaction);
  if (travelMs === 0) return agentInteractionPointsAt(interaction, elapsedMs);
  if (elapsedMs >= travelMs) {
    return agentInteractionPointsAt(interaction, elapsedMs - travelMs);
  }
  return interpolatePoints(
    previousPoints,
    agentInteractionPointsAt(interaction, 0),
    easeInOutCubic(elapsedMs / travelMs)
  );
}

function pointsWithinSegment(
  segment: AgentInteractionSegment,
  elapsedMs: number
): AgentInteractionPoint[] {
  const first = segment.frames[0];
  if (!first) return [];
  const last = segment.frames.at(-1) ?? first;
  if (elapsedMs <= first.atMs) return first.points;
  if (elapsedMs >= last.atMs) return last.points;

  for (let index = 1; index < segment.frames.length; index++) {
    const to = segment.frames[index];
    const from = segment.frames[index - 1];
    if (!to || !from || elapsedMs > to.atMs) continue;
    if (from.points.length !== to.points.length || to.atMs === from.atMs) return to.points;

    const linearProgress = (elapsedMs - from.atMs) / (to.atMs - from.atMs);
    const progress =
      segment.easing === 'ease-out' ? 1 - Math.pow(1 - linearProgress, 3) : linearProgress;
    return interpolatePoints(from.points, to.points, progress);
  }
  return last.points;
}

function interpolatePoints(
  from: AgentInteractionPoint[],
  to: AgentInteractionPoint[],
  progress: number
): AgentInteractionPoint[] {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return from.map((point, index) => {
    const destination = to[index] ?? point;
    return {
      x: point.x + (destination.x - point.x) * clampedProgress,
      y: point.y + (destination.y - point.y) * clampedProgress,
    };
  });
}

function easeInOutCubic(progress: number): number {
  const clampedProgress = Math.min(1, Math.max(0, progress));
  return clampedProgress < 0.5
    ? 4 * clampedProgress * clampedProgress * clampedProgress
    : 1 - Math.pow(-2 * clampedProgress + 2, 3) / 2;
}
