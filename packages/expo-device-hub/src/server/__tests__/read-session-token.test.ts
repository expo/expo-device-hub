import { describe, expect, test } from 'bun:test';

import { readSessionToken } from '../read-session-token';

const STANDALONE = { EXPO_DEVICE_HUB_BASE_PATH: '' };

describe('readSessionToken', () => {
  test('reads the token that the standalone CLI sets', () => {
    expect(readSessionToken({ ...STANDALONE, EXPO_DEVICE_HUB_SESSION_TOKEN: 'jJ3k_Qx-9Zp2' })).toBe('jJ3k_Qx-9Zp2');
  });

  test('has no token outside the standalone CLI, or when none is set', () => {
    expect(readSessionToken({ EXPO_DEVICE_HUB_SESSION_TOKEN: 'jJ3k_Qx-9Zp2' })).toBeUndefined();
    expect(readSessionToken({ ...STANDALONE, EXPO_DEVICE_HUB_SESSION_TOKEN: '' })).toBeUndefined();
  });

  // The Hub and both backends take the token as a bearer, a query, a cookie, or a subprotocol.
  test('refuses a token that some clients could never send', () => {
    for (const token of ['a,b', ' padded ', 'with space', 'a+b', 'YWJjZA==', 'semi;colon', 'café']) {
      expect(() => readSessionToken({ ...STANDALONE, EXPO_DEVICE_HUB_SESSION_TOKEN: token })).toThrow(
        'EXPO_DEVICE_HUB_SESSION_TOKEN'
      );
    }
  });
});
