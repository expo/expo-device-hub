import { describe, expect, test } from 'bun:test';

import {
  agentInteractionCursorExpiresAt,
  agentInteractionEndMs,
  agentInteractionPointsAt,
  agentInteractionPointsWithTravelAt,
  agentInteractionTravelMs,
} from '../agent-interaction-animation';
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
  test('interpolates gesture and cursor movement between batched segments', () => {
    expect(agentInteractionPointsAt(INTERACTION, 150)).toEqual([{ x: 0.5, y: 0.5 }]);
    expect(agentInteractionPointsAt(INTERACTION, 400)).toEqual([{ x: 0.45, y: 0.7 }]);
    expect(agentInteractionPointsAt(INTERACTION, 500)).toEqual([{ x: 0.1, y: 0.9 }]);
  });

  test('moves from the previous log record before replaying the next click', () => {
    const nextClick: AgentInteraction = {
      ...INTERACTION,
      id: 'interaction-2',
      segments: [{ startMs: 0, frames: [{ atMs: 0, points: [{ x: 0.9, y: 0.1 }] }] }],
    };
    const previousPoints = [{ x: 0.1, y: 0.9 }];

    expect(agentInteractionTravelMs(previousPoints, nextClick)).toBe(220);
    expect(agentInteractionPointsWithTravelAt(nextClick, previousPoints, 0)).toEqual(
      previousPoints
    );
    expect(agentInteractionPointsWithTravelAt(nextClick, previousPoints, 110)).toEqual([
      { x: 0.5, y: 0.5 },
    ]);
    expect(agentInteractionPointsWithTravelAt(nextClick, previousPoints, 220)).toEqual([
      { x: 0.9, y: 0.1 },
    ]);
  });

  test('keeps the final interaction point settled after playback', () => {
    expect(agentInteractionEndMs(INTERACTION)).toBe(500);
    expect(agentInteractionPointsAt(INTERACTION, 10_000)).toEqual([{ x: 0.1, y: 0.9 }]);
  });

  test('expires the cursor two minutes after the final interaction frame', () => {
    expect(agentInteractionCursorExpiresAt(INTERACTION)).toBe(
      Date.parse(INTERACTION.timestamp) + 500 + 120_000
    );
  });

  test('uses the observation time when an interaction timestamp is invalid', () => {
    expect(agentInteractionCursorExpiresAt({ ...INTERACTION, timestamp: 'invalid' }, 1_000)).toBe(
      121_500
    );
  });

  test('matches Argent settle swipe cubic ease-out', () => {
    const settled: AgentInteraction = {
      ...INTERACTION,
      segments: [{ ...INTERACTION.segments[0]!, easing: 'ease-out' }],
    };
    expect(agentInteractionPointsAt(settled, 150)[0]?.x).toBeCloseTo(0.725);
  });
});
