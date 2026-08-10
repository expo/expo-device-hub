import { describe, expect, test } from 'bun:test';

import { agentInteractionEndMs, agentInteractionPointsAt } from '../agent-interaction-animation';
import { type AgentInteraction } from '../types';

const INTERACTION: AgentInteraction = {
  id: 'interaction-1',
  deviceId: 'device-1',
  timestamp: '2026-08-10T13:59:21.315Z',
  segments: [
    {
      startMs: 0,
      frames: [
        { atMs: 0, points: [{ x: 0.2, y: 0.5 }] },
        { atMs: 300, points: [{ x: 0.8, y: 0.5 }] },
      ],
    },
    { startMs: 500, frames: [{ atMs: 0, points: [{ x: 0.1, y: 0.9 }] }] },
  ],
};

describe('agentInteractionPointsAt', () => {
  test('interpolates movement and holds between batched gestures', () => {
    expect(agentInteractionPointsAt(INTERACTION, 150)).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(agentInteractionPointsAt(INTERACTION, 400)).toEqual([{ x: 0.8, y: 0.5 }]);
    expect(agentInteractionPointsAt(INTERACTION, 500)).toEqual([{ x: 0.1, y: 0.9 }]);
  });

  test('keeps the final interaction visible indefinitely', () => {
    expect(agentInteractionEndMs(INTERACTION)).toBe(500);
    expect(agentInteractionPointsAt(INTERACTION, 10_000)).toEqual([{ x: 0.1, y: 0.9 }]);
  });

  test('matches Argent settle swipe cubic ease-out', () => {
    const settled: AgentInteraction = {
      ...INTERACTION,
      segments: [{ ...INTERACTION.segments[0]!, easing: 'ease-out' }],
    };
    expect(agentInteractionPointsAt(settled, 150)[0]?.x).toBeCloseTo(0.725);
  });
});
