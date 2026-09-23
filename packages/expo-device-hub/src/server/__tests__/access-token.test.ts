import { describe, expect, test } from 'bun:test';

import {
  authorizeDeviceManagement,
  dashboardUrlWithToken,
  mintAccessToken,
  originMatches,
  upgradeHeadersForAllowedOrigin,
  upgradeHeadersForMiddleware,
  upgradeHeadersWithSubprotocolToken,
} from '../access-token';

describe('mintAccessToken', () => {
  test('mints a distinct base64url token each time', () => {
    const a = mintAccessToken();
    const b = mintAccessToken();
    expect(a).not.toBe(b);
    // 32 bytes -> 43 base64url characters, no padding, so it fits a URL and a subprotocol.
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('dashboardUrlWithToken', () => {
  test('keeps the token in a fragment, or adds nothing without one', () => {
    expect(dashboardUrlWithToken('http://localhost:3400', 'a+b')).toBe(
      'http://localhost:3400/#token=a%2Bb',
    );
    expect(dashboardUrlWithToken('http://localhost:3400', undefined)).toBe('http://localhost:3400');
  });
});

describe('authorizeDeviceManagement', () => {
  test('accepts a matching bearer, including a case-insensitive scheme', () => {
    for (const scheme of ['Bearer', 'bearer']) {
      expect(authorizeDeviceManagement(new Request('http://hub/api/devices/boot', {
        headers: { authorization: `${scheme} session` },
      }), 'session')).toBeNull();
    }
  });

  test('rejects query tokens, wrong bearers, and an empty gated token', () => {
    for (const token of ['', 'session']) {
      const response = authorizeDeviceManagement(new Request('http://hub/api/devices/boot?token=session', {
        headers: { authorization: 'Bearer wrong' },
      }), token);
      expect(response?.status).toBe(401);
      expect(response?.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('leaves an ungated Hub open', () => {
    expect(authorizeDeviceManagement(new Request('http://hub/api/devices/boot'), undefined)).toBeNull();
  });
});

describe('upgradeHeadersWithSubprotocolToken', () => {
  test('turns the serve-sim token subprotocol into a bearer', () => {
    const headers = upgradeHeadersWithSubprotocolToken(
      new Headers({ 'sec-websocket-protocol': 'serve-sim.token.secret', origin: 'http://hub.test' }),
    );
    expect(headers.get('authorization')).toBe('Bearer secret');
    // Everything else is kept, including the offered protocol `ws` names back.
    expect(headers.get('sec-websocket-protocol')).toBe('serve-sim.token.secret');
    expect(headers.get('origin')).toBe('http://hub.test');
  });

  test('picks the token entry out of a list of offered protocols', () => {
    const headers = upgradeHeadersWithSubprotocolToken(
      new Headers({ 'sec-websocket-protocol': 'chat, serve-sim.token.secret , other' }),
    );
    expect(headers.get('authorization')).toBe('Bearer secret');
  });

  test('leaves the headers alone with no token entry or an empty one', () => {
    expect(upgradeHeadersWithSubprotocolToken(new Headers()).has('authorization')).toBe(false);
    expect(
      upgradeHeadersWithSubprotocolToken(new Headers({ 'sec-websocket-protocol': 'chat' })).has(
        'authorization',
      ),
    ).toBe(false);
    expect(
      upgradeHeadersWithSubprotocolToken(
        new Headers({ 'sec-websocket-protocol': 'serve-sim.token.' }),
      ).has('authorization'),
    ).toBe(false);
  });

  test('never overrides an Authorization header the client sent', () => {
    const headers = upgradeHeadersWithSubprotocolToken(
      new Headers({
        authorization: 'Bearer explicit',
        'sec-websocket-protocol': 'serve-sim.token.other',
      }),
    );
    expect(headers.get('authorization')).toBe('Bearer explicit');
  });

  test('does not mutate the given headers', () => {
    const original = new Headers({ 'sec-websocket-protocol': 'serve-sim.token.secret' });
    upgradeHeadersWithSubprotocolToken(original);
    expect(original.has('authorization')).toBe(false);
  });
});

describe('originMatches', () => {
  test('matches an exact origin, ignoring default ports and case', () => {
    expect(originMatches('https://expo.dev', new URL('https://expo.dev'))).toBe(true);
    expect(originMatches('https://expo.dev:443/', new URL('https://EXPO.dev'))).toBe(true);
    expect(originMatches('http://localhost:34568', new URL('http://localhost:34568'))).toBe(true);
    expect(originMatches('http://localhost:34568', new URL('http://localhost:34567'))).toBe(false);
  });

  test('a wildcard covers subdomains only, with the same scheme and port', () => {
    expect(originMatches('https://*.expo.dev', new URL('https://pr-1.expo.dev'))).toBe(true);
    expect(originMatches('https://*.expo.dev', new URL('https://expo.dev'))).toBe(false);
    expect(originMatches('https://*.expo.dev', new URL('http://pr-1.expo.dev'))).toBe(false);
    expect(originMatches('https://*.com', new URL('https://evil.com'))).toBe(false);
  });

  test('refuses non-web and malformed values', () => {
    expect(originMatches('not a url', new URL('https://expo.dev'))).toBe(false);
    expect(originMatches('chrome-extension://abc', new URL('chrome-extension://abc'))).toBe(false);
  });
});

describe('upgradeHeadersForAllowedOrigin', () => {
  const hub = 'http://localhost:34567/vendor/serve-sim/exec-ws';

  test('rewrites an allow-listed cross-origin Origin to the Hub origin', () => {
    const headers = upgradeHeadersForAllowedOrigin(
      new Headers({ origin: 'http://localhost:34568' }),
      hub,
      ['http://localhost:34568'],
    );
    expect(headers.get('origin')).toBe('http://localhost:34567');
  });

  test('accepts the same wildcard shapes as --cors-origin', () => {
    const headers = upgradeHeadersForAllowedOrigin(
      new Headers({ origin: 'https://pr-9.expo.dev' }),
      'https://hub.example.test/vendor/serve-sim/exec-ws',
      ['https://*.expo.dev'],
    );
    expect(headers.get('origin')).toBe('https://hub.example.test');
  });

  test('leaves a same-host, unlisted, missing, or malformed Origin as sent', () => {
    expect(
      upgradeHeadersForAllowedOrigin(new Headers({ origin: 'http://localhost:34567' }), hub, [
        'http://localhost:34568',
      ]).get('origin'),
    ).toBe('http://localhost:34567');
    expect(
      upgradeHeadersForAllowedOrigin(new Headers({ origin: 'http://evil.test' }), hub, [
        'http://localhost:34568',
      ]).get('origin'),
    ).toBe('http://evil.test');
    expect(
      upgradeHeadersForAllowedOrigin(new Headers({ origin: 'http://localhost:34568' }), hub, []).get(
        'origin',
      ),
    ).toBe('http://localhost:34568');
    expect(upgradeHeadersForAllowedOrigin(new Headers(), hub, ['http://x.test']).has('origin')).toBe(
      false,
    );
    expect(
      upgradeHeadersForAllowedOrigin(new Headers({ origin: 'null' }), hub, ['http://x.test']).get(
        'origin',
      ),
    ).toBe('null');
  });
});

describe('upgradeHeadersForMiddleware', () => {
  test('applies both the token bridge and the origin allow list', () => {
    const headers = upgradeHeadersForMiddleware(
      new Headers({
        origin: 'http://localhost:34568',
        'sec-websocket-protocol': 'serve-sim.token.secret',
      }),
      'http://localhost:34567/vendor/serve-sim/exec-ws',
      ['http://localhost:34568'],
    );
    expect(headers.get('authorization')).toBe('Bearer secret');
    expect(headers.get('origin')).toBe('http://localhost:34567');
  });
});
