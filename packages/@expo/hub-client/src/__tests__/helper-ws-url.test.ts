import { describe, expect, test } from 'bun:test';
import { toQueryStyleHelperWsUrl } from '../useIosDevice';

describe('toQueryStyleHelperWsUrl', () => {
  test('rewrites the path-scoped helper ws form to the device query form', () => {
    expect(
      toQueryStyleHelperWsUrl(
        'ws://127.0.0.1:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/UDID-123/ws',
      ),
    ).toBe(
      'ws://127.0.0.1:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/ws?device=UDID-123',
    );
  });

  test('keeps an existing device query param over the one in the path', () => {
    expect(toQueryStyleHelperWsUrl('ws://host/helper/UDID-A/ws?device=UDID-B')).toBe(
      'ws://host/helper/ws?device=UDID-B',
    );
  });

  test('throws when the path is not the /helper/<id>/ws form', () => {
    expect(() => toQueryStyleHelperWsUrl('ws://127.0.0.1:8081/base/helper/ws?device=UDID-123')).toThrow(
      'Invalid helper ws url',
    );
    expect(() => toQueryStyleHelperWsUrl('ws://127.0.0.1:3100/ws')).toThrow('Invalid helper ws url');
  });

  test('throws on a non-URL input', () => {
    expect(() => toQueryStyleHelperWsUrl('not a url')).toThrow();
  });
});
