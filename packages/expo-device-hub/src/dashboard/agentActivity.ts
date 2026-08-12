import { agentInteractionCursorExpiresAt, type AgentInteraction } from '@expo/hub-client';

export type AgentInteractions = Record<string, AgentInteraction>;

/** Give malformed external timestamps a stable observation time before storing them. */
export function normalizeAgentInteractionTimestamp(
  interaction: AgentInteraction,
  observedAt: number
): AgentInteraction {
  return Number.isFinite(Date.parse(interaction.timestamp))
    ? interaction
    : { ...interaction, timestamp: new Date(observedAt).toISOString() };
}

/** Keep only interactions whose final frame is less than one timeout window old. */
export function activeAgentInteractions(
  interactions: AgentInteractions,
  now: number
): AgentInteractions {
  return Object.fromEntries(
    Object.entries(interactions).filter(
      ([, interaction]) => agentInteractionCursorExpiresAt(interaction, now) > now
    )
  );
}

/** Find the next active-device state change so the UI can expire it without another event. */
export function nextAgentInteractionExpiry(
  interactions: AgentInteractions,
  now: number
): number | null {
  let next = Infinity;
  for (const interaction of Object.values(interactions)) {
    const expiresAt = agentInteractionCursorExpiresAt(interaction, now);
    if (expiresAt > now) next = Math.min(next, expiresAt);
  }
  return Number.isFinite(next) ? next : null;
}
