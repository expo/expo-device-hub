import { afterEach, describe, expect, test } from 'bun:test';

import { sessionTokenFetch, sessionTokenProtocols, withSessionTokenQuery } from '../session-token';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function recordFetch() {
  const calls: Array<{ url: string; headers: Headers; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, headers: new Headers(init?.headers), init });
    return new Response(null);
  }) as typeof fetch;
  return calls;
}

describe('sessionTokenFetch', () => {
  test('sends the token as a bearer header and keeps the rest of the request', async () => {
    const calls = recordFetch();

    await sessionTokenFetch('tok-1')('https://hub.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(calls[0]!.url).toBe('https://hub.test/api');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok-1');
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.init?.body).toBe('{}');
  });

  test('adds nothing without a token', async () => {
    const calls = recordFetch();

    await sessionTokenFetch(null)('https://hub.test/api');

    expect(calls[0]!.headers.has('authorization')).toBe(false);
  });
});

describe('withSessionTokenQuery', () => {
  test('appends the token to a URL with or without a query', () => {
    expect(withSessionTokenQuery('https://hub.test/logs', 'tok')).toBe('https://hub.test/logs?token=tok');
    expect(withSessionTokenQuery('https://hub.test/logs?device=A', 'a+b')).toBe(
      'https://hub.test/logs?device=A&token=a%2Bb'
    );
    expect(withSessionTokenQuery('https://hub.test/logs', undefined)).toBe('https://hub.test/logs');
  });
});

describe('sessionTokenProtocols', () => {
  test("names serve-sim's prefix", () => {
    expect(sessionTokenProtocols('ios', 'tok')).toEqual(['serve-sim.token.tok']);
    expect(sessionTokenProtocols('ios', '')).toBeUndefined();
  });
});
