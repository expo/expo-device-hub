import { describe, expect, test } from 'bun:test';

import { shareLink } from '../../share';

const at = (pathname: string, search = '') => ({
  origin: 'http://192.168.1.20:3400',
  pathname,
  search,
});

describe('shareLink', () => {
  test('adds the token when the Hub is gated', () => {
    expect(shareLink(at('/'), { sessionToken: 'tok-1' })).toEqual({
      url: 'http://192.168.1.20:3400/?token=tok-1',
      carriesToken: true,
    });
  });

  test('shares the plain address when the Hub is not gated', () => {
    expect(shareLink(at('/'), {})).toEqual({ url: 'http://192.168.1.20:3400/', carriesToken: false });
  });

  test('keeps the mount path and the query', () => {
    expect(shareLink(at('/_expo/plugins/expo-device-hub', '?device=ABC'), { sessionToken: 'tok-1' }).url).toBe(
      'http://192.168.1.20:3400/_expo/plugins/expo-device-hub?device=ABC&token=tok-1'
    );
  });

  test('replaces a token already in the address', () => {
    expect(shareLink(at('/', '?token=stale'), { sessionToken: 'tok-1' }).url).toBe(
      'http://192.168.1.20:3400/?token=tok-1'
    );
    expect(shareLink(at('/', '?token=stale'), {}).url).toBe('http://192.168.1.20:3400/');
  });

  test('uses --share-url instead of this page, and still adds the token', () => {
    expect(
      shareLink(at('/', '?device=ABC'), {
        sessionToken: 'tok-1',
        shareUrl: 'https://expo.dev/device-preview/abc?token=stale',
      }).url
    ).toBe('https://expo.dev/device-preview/abc?token=tok-1');
  });

  test('escapes a token that is not URL-safe', () => {
    expect(shareLink(at('/'), { sessionToken: 'a b&c' }).url).toBe('http://192.168.1.20:3400/?token=a+b%26c');
  });
});
