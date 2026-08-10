import {
  type AgentInteraction,
  type AgentInteractionPoint,
  type AgentInteractionSegment,
} from './types';

export function agentInteractionEndMs(interaction: AgentInteraction): number {
  return interaction.segments.reduce(
    (latest, segment) => Math.max(latest, segment.startMs + (segment.frames.at(-1)?.atMs ?? 0)),
    0
  );
}

/** Resolve the visible agent finger positions for one moment on the MCP-call timeline. */
export function agentInteractionPointsAt(
  interaction: AgentInteraction,
  elapsedMs: number
): AgentInteractionPoint[] {
  const firstSegment = interaction.segments[0];
  if (!firstSegment) return [];

  let segment = firstSegment;
  for (const candidate of interaction.segments) {
    if (candidate.startMs > elapsedMs) break;
    segment = candidate;
  }
  return pointsWithinSegment(segment, Math.max(0, elapsedMs - segment.startMs));
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
    return from.points.map((point, pointIndex) => {
      const destination = to.points[pointIndex] ?? point;
      return {
        x: point.x + (destination.x - point.x) * progress,
        y: point.y + (destination.y - point.y) * progress,
      };
    });
  }
  return last.points;
}
