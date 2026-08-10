import { afterEach, describe, expect, test } from 'bun:test';

import { ARGENT_INTERACTION_MESSAGE_TYPE } from '../../argent-interaction-protocol';
import {
  argentInteractionsWebSocketUrl,
  parseArgentInteractionMessage,
} from '../useArgentInteraction';

const INTERACTION = {
  id: 'interaction-1',
  deviceId: 'device-1',
  timestamp: '2026-08-10T13:59:21.315Z',
  segments: [{ startMs: 0, frames: [{ atMs: 0, points: [{ x: 0.2, y: 0.5 }] }] }],
};

afterEach(() => {
  delete (globalThis as any).window;
});

describe('Argent interaction WebSocket', () => {
  test('builds secure and insecure URLs under the Hub mount', () => {
    (globalThis as any).window = { __DEV__: true };
    expect(argentInteractionsWebSocketUrl('http://localhost:8081')).toBe(
      'ws://localhost:8081/_expo/plugins/expo-device-hub/api/argent-interactions/ws'
    );
    expect(argentInteractionsWebSocketUrl('https://expo.dev')).toBe(
      'wss://expo.dev/_expo/plugins/expo-device-hub/api/argent-interactions/ws'
    );
  });

  test('accepts only interaction messages with the expected envelope', () => {
    const encoded = JSON.stringify({
      type: ARGENT_INTERACTION_MESSAGE_TYPE,
      interaction: INTERACTION,
    });
    expect(parseArgentInteractionMessage(encoded)?.interaction).toEqual(INTERACTION);
    expect(parseArgentInteractionMessage(JSON.stringify({ type: 'device-list' }))).toBeNull();
    expect(
      parseArgentInteractionMessage(
        JSON.stringify({
          type: ARGENT_INTERACTION_MESSAGE_TYPE,
          interaction: { ...INTERACTION, segments: [{ startMs: 0, frames: 'invalid' }] },
        })
      )
    ).toBeNull();
    expect(parseArgentInteractionMessage('{')).toBeNull();
  });
});
