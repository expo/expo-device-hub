import { describe, expect, test } from 'bun:test';

import { dashboardAccessToken, readAccessTokenFromUrl } from '../accessToken';

describe('readAccessTokenFromUrl', () => {
  test('takes the token out of the query and leaves the rest', () => {
    expect(readAccessTokenFromUrl('http://localhost:3400/?token=abc&x=1')).toEqual({
      token: 'abc',
      cleanedUrl: 'http://localhost:3400/?x=1',
    });
    expect(readAccessTokenFromUrl('http://localhost:3400/?token=abc')).toEqual({
      token: 'abc',
      cleanedUrl: 'http://localhost:3400/',
    });
  });

  test('takes the token out of the fragment too', () => {
    expect(readAccessTokenFromUrl('http://localhost:3400/#token=abc')).toEqual({
      token: 'abc',
      cleanedUrl: 'http://localhost:3400/',
    });
    expect(readAccessTokenFromUrl('http://localhost:3400/#token=abc&tab=logs')).toEqual({
      token: 'abc',
      cleanedUrl: 'http://localhost:3400/#tab=logs',
    });
  });

  test('reports no token for a plain URL or an empty value', () => {
    expect(readAccessTokenFromUrl('http://localhost:3400/')).toEqual({
      token: null,
      cleanedUrl: 'http://localhost:3400/',
    });
    expect(readAccessTokenFromUrl('http://localhost:3400/?token=').token).toBeNull();
  });
});

function fakeWindow(href: string, stored: string | null = null) {
  const storage = new Map<string, string>();
  if (stored) storage.set('expo-device-hub:access-token', stored);
  const replaced: string[] = [];
  return {
    win: {
      location: { href },
      history: {
        state: { kept: true },
        replaceState: (_state: unknown, _unused: string, url?: string) => {
          if (url) replaced.push(url);
        },
      },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    },
    storage,
    replaced,
  };
}

describe('dashboardAccessToken', () => {
  test('stores a URL token for the tab and drops it from the address bar', () => {
    const { win, storage, replaced } = fakeWindow('http://localhost:3400/?token=abc');
    expect(dashboardAccessToken(win)).toBe('abc');
    expect(storage.get('expo-device-hub:access-token')).toBe('abc');
    expect(replaced).toEqual(['http://localhost:3400/']);
  });

  test('falls back to the token stored earlier in this tab', () => {
    const { win, replaced } = fakeWindow('http://localhost:3400/', 'stored');
    expect(dashboardAccessToken(win)).toBe('stored');
    expect(replaced).toEqual([]);
  });

  test('a fresh URL token replaces a stored one', () => {
    const { win, storage } = fakeWindow('http://localhost:3400/?token=new', 'old');
    expect(dashboardAccessToken(win)).toBe('new');
    expect(storage.get('expo-device-hub:access-token')).toBe('new');
  });

  test('is null with nothing in the URL or storage, and without a window', () => {
    expect(dashboardAccessToken(fakeWindow('http://localhost:3400/').win)).toBeNull();
    expect(dashboardAccessToken(undefined)).toBeNull();
  });

  test('still returns the URL token when storage throws', () => {
    const { win } = fakeWindow('http://localhost:3400/?token=abc');
    win.sessionStorage.setItem = () => {
      throw new Error('blocked');
    };
    expect(dashboardAccessToken(win)).toBe('abc');
  });
});
