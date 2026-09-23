import { afterEach, describe, expect, test } from 'bun:test';

import {
  accessTokenFetch,
  accessTokenHeaders,
  accessTokenSubprotocols,
  openAccessTokenWebSocket,
  withAccessTokenHeaders,
  withAccessTokenQuery,
} from '../access-token';

const TOKEN = 'abc-DEF_123';

describe('accessTokenHeaders', () => {
  test('presents the token as a bearer', () => {
    expect(accessTokenHeaders(TOKEN)).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  test('is empty without a token', () => {
    expect(accessTokenHeaders(null)).toEqual({});
    expect(accessTokenHeaders(undefined)).toEqual({});
    expect(accessTokenHeaders('')).toEqual({});
  });
});

describe('withAccessTokenHeaders', () => {
  test('keeps the caller headers and adds the bearer', () => {
    const init = withAccessTokenHeaders(
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      TOKEN,
    );
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('POST');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('returns the init untouched without a token', () => {
    const init = { cache: 'no-store' as const };
    expect(withAccessTokenHeaders(init, null)).toBe(init);
    expect(withAccessTokenHeaders(undefined, null)).toBeUndefined();
  });

  test('does not replace an Authorization header the caller set', () => {
    const init = withAccessTokenHeaders({ headers: { Authorization: 'Bearer other' } }, TOKEN);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer other');
  });
});

describe('accessTokenFetch', () => {
  test('adds the bearer to every request', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = accessTokenFetch(TOKEN, async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response(null);
    });
    await fetchImpl('https://hub.test/api', { cache: 'no-store' });
    expect(seen).toEqual([{ url: 'https://hub.test/api', auth: `Bearer ${TOKEN}` }]);
  });

  test('returns the given fetch itself without a token', () => {
    const base = async () => new Response(null);
    expect(accessTokenFetch(null, base)).toBe(base);
  });
});

describe('withAccessTokenQuery', () => {
  test('appends the token with the right separator', () => {
    expect(withAccessTokenQuery('https://hub.test/stream.mjpeg', TOKEN)).toBe(
      `https://hub.test/stream.mjpeg?token=${TOKEN}`,
    );
    expect(withAccessTokenQuery('https://hub.test/appstate?device=UDID', TOKEN)).toBe(
      `https://hub.test/appstate?device=UDID&token=${TOKEN}`,
    );
  });

  test('URL-encodes the token and keeps a fragment last', () => {
    expect(withAccessTokenQuery('https://hub.test/a#frag', 'a b')).toBe(
      'https://hub.test/a?token=a%20b#frag',
    );
  });

  test('leaves the URL alone without a token or when it already names one', () => {
    expect(withAccessTokenQuery('https://hub.test/a', null)).toBe('https://hub.test/a');
    expect(withAccessTokenQuery('https://hub.test/a?token=x', TOKEN)).toBe(
      'https://hub.test/a?token=x',
    );
  });
});

describe('accessTokenSubprotocols', () => {
  test('names the token with the serve-sim prefix', () => {
    expect(accessTokenSubprotocols(TOKEN)).toEqual([`serve-sim.token.${TOKEN}`]);
  });

  test('is undefined without a token', () => {
    expect(accessTokenSubprotocols(null)).toBeUndefined();
    expect(accessTokenSubprotocols('')).toBeUndefined();
  });

  test('refuses a token a subprotocol cannot carry', () => {
    // `=` padding, whitespace, and a header-breaking CR are all outside RFC 7230 token chars.
    expect(accessTokenSubprotocols('YWJj=')).toBeUndefined();
    expect(accessTokenSubprotocols('a b')).toBeUndefined();
    expect(accessTokenSubprotocols('a\r\nb')).toBeUndefined();
  });
});

describe('openAccessTokenWebSocket', () => {
  const realWebSocket = globalThis.WebSocket;
  afterEach(() => {
    (globalThis as any).WebSocket = realWebSocket;
  });

  test('offers the subprotocol only when a token is present', () => {
    const calls: Array<[string, string[] | undefined]> = [];
    (globalThis as any).WebSocket = class {
      constructor(url: string, protocols?: string[]) {
        calls.push([url, protocols]);
      }
    };
    openAccessTokenWebSocket('ws://hub.test/exec-ws', TOKEN);
    openAccessTokenWebSocket('ws://hub.test/exec-ws', null);
    // A padded token falls back to a plain socket; exec-ws still takes it in the first frame.
    openAccessTokenWebSocket('ws://hub.test/exec-ws', 'YWJj=');
    expect(calls).toEqual([
      ['ws://hub.test/exec-ws', [`serve-sim.token.${TOKEN}`]],
      ['ws://hub.test/exec-ws', undefined],
      ['ws://hub.test/exec-ws', undefined],
    ]);
  });
});
