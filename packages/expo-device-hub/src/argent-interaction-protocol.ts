import { type AgentInteraction } from '@expo/hub-client';

export const ARGENT_INTERACTION_MESSAGE_TYPE = 'argent-interaction' as const;

export type ArgentInteractionMessage = {
  type: typeof ARGENT_INTERACTION_MESSAGE_TYPE;
  interaction: AgentInteraction;
};

export function argentInteractionMessage(interaction: AgentInteraction): ArgentInteractionMessage {
  return { type: ARGENT_INTERACTION_MESSAGE_TYPE, interaction };
}
