import { describe, expect, test } from 'bun:test';

import {
  dashboardUrlWithToken,
  mintAccessToken,
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
  test('appends the token as a query on the root, or nothing without one', () => {
    expect(dashboardUrlWithToken('http://localhost:3400', 'a+b')).toBe(
      'http://localhost:3400/?token=a%2Bb',
    );
    expect(dashboardUrlWithToken('http://localhost:3400', undefined)).toBe('http://localhost:3400');
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
