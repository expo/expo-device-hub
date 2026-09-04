import { useEffect, useReducer, useRef } from 'react';

import { agentInteractionCursorExpiresAt } from './agent-interaction-animation';
import { type AgentInteraction } from './types';

/**
 * Return the current interaction only while its cursor is active, and schedule
 * the expiry render so every consumer shares the indicator's timeout boundary.
 */
export function useActiveAgentInteraction(
  interaction?: AgentInteraction | null,
): AgentInteraction | null {
  const fallback = useRef({ interaction, startedAt: Date.now() });
  const [, renderAtExpiry] = useReducer((value: number) => value + 1, 0);

  if (fallback.current.interaction !== interaction) {
    fallback.current = { interaction, startedAt: Date.now() };
  }

  const expiresAt = interaction
    ? agentInteractionCursorExpiresAt(interaction, fallback.current.startedAt)
    : null;
  const active = interaction && expiresAt !== null && expiresAt > Date.now() ? interaction : null;

  useEffect(() => {
    if (expiresAt === null) return;
    const delay = expiresAt - Date.now();
    if (delay <= 0) return;
    const timer = window.setTimeout(renderAtExpiry, delay + 1);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  return active;
}
