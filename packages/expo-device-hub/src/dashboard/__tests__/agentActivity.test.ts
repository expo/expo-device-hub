import { describe, expect, test } from 'bun:test';

import {
  activeAgentInteractions,
  nextAgentInteractionExpiry,
  normalizeAgentInteractionTimestamp,
} from '../agentActivity';
import { type AgentInteraction } from '@expo/hub-client';

const STARTED_AT = Date.parse('2026-08-12T08:00:00.000Z');
const INTERACTION: AgentInteraction = {
  id: 'interaction-1',
  deviceId: 'device-1',
  timestamp: new Date(STARTED_AT).toISOString(),
  segments: [
    {
      startMs: 0,
      frames: [
        { atMs: 0, points: [{ x: 0.2, y: 0.5 }] },
        { atMs: 500, points: [{ x: 0.8, y: 0.5 }] },
      ],
    },
  ],
};

describe('agent activity', () => {
  test('keeps a device active for one minute after its final interaction frame', () => {
    const expiresAt = STARTED_AT + 500 + 60_000;
    expect(activeAgentInteractions({ 'device-1': INTERACTION }, expiresAt - 1)).toEqual({
      'device-1': INTERACTION,
    });
    expect(activeAgentInteractions({ 'device-1': INTERACTION }, expiresAt)).toEqual({});
    expect(nextAgentInteractionExpiry({ 'device-1': INTERACTION }, STARTED_AT)).toBe(expiresAt);
  });

  test('gives an invalid timestamp the stable time when it was observed', () => {
    expect(
      normalizeAgentInteractionTimestamp({ ...INTERACTION, timestamp: 'invalid' }, STARTED_AT)
        .timestamp
    ).toBe('2026-08-12T08:00:00.000Z');
  });
});
