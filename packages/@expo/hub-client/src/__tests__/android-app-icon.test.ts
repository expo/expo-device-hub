import { describe, expect, test } from 'bun:test';
import {
  carryForwardAppIcon,
  fetchAndroidAppIcon,
  getAndroidAppIcon,
  parseAndroidAppIcon,
} from '../android-app-icon';

const BASE = 'http://localhost:3400/vendor/serve-emu';

function jsonFetch(body: unknown, status = 200) {
  const requests: string[] = [];
  const fetchImpl = async (input: string) => {
    requests.push(input);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { requests, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('Android app icon', () => {
  test('asks serve-emu for the selected device and package', async () => {
    const { requests, fetchImpl } = jsonFetch({
      ok: true,
      packageName: 'com.android.settings',
      icon: { mimeType: 'image/png', data: 'aWNvbg==' },
    });

    const dataUrl = await fetchAndroidAppIcon(
      BASE,
      'emulator-5554',
      'com.android.settings',
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect(url.pathname).toBe('/vendor/serve-emu/api/apps/icon');
    expect(url.searchParams.get('device')).toBe('emulator-5554');
    expect(url.searchParams.get('packageName')).toBe('com.android.settings');
    expect(dataUrl).toBe('data:image/png;base64,aWNvbg==');
  });

  test('carries the backend MIME type instead of assuming PNG', async () => {
    const { fetchImpl } = jsonFetch({
      ok: true,
      packageName: 'com.android.chrome',
      icon: { mimeType: 'image/webp', data: 'd2VicA==' },
    });

    expect(await fetchAndroidAppIcon(BASE, null, 'com.android.chrome', fetchImpl)).toBe(
      'data:image/webp;base64,d2VicA==',
    );
  });

  test('returns null when the package exposes no bitmap', async () => {
    const { fetchImpl } = jsonFetch({ ok: true, packageName: 'com.example.app', icon: null });

    expect(await fetchAndroidAppIcon(BASE, null, 'com.example.app', fetchImpl)).toBeNull();
  });

  test('throws on a failure response so the cache does not keep the miss', async () => {
    const { fetchImpl } = jsonFetch({ ok: false, error: 'packageName is invalid' }, 400);

    await expect(fetchAndroidAppIcon(BASE, null, 'com.example.app', fetchImpl)).rejects.toThrow(
      '400',
    );
  });

  test('caches a resolved icon and retries after a failure', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? new Response('nope', { status: 503 })
        : new Response(
            JSON.stringify({ ok: true, packageName: 'com.example.app', icon: { mimeType: 'image/png', data: 'aWNvbg==' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
    }) as unknown as typeof fetch;

    await expect(getAndroidAppIcon(BASE, 'a', 'com.example.app', fetchImpl)).rejects.toThrow();
    expect(await getAndroidAppIcon(BASE, 'a', 'com.example.app', fetchImpl)).toBe(
      'data:image/png;base64,aWNvbg==',
    );
    expect(await getAndroidAppIcon(BASE, 'a', 'com.example.app', fetchImpl)).toBe(
      'data:image/png;base64,aWNvbg==',
    );
    expect(calls).toBe(2);
  });
});

describe('parseAndroidAppIcon', () => {
  test('accepts every MIME type the backend can return', () => {
    for (const mimeType of ['image/png', 'image/webp', 'image/jpeg', 'image/gif']) {
      expect(parseAndroidAppIcon({ ok: true, icon: { mimeType, data: 'aWNvbg==' } })).toBe(
        `data:${mimeType};base64,aWNvbg==`,
      );
    }
  });

  test('rejects a MIME type outside that set instead of building its data URL', () => {
    expect(() =>
      parseAndroidAppIcon({ ok: true, icon: { mimeType: 'image/svg+xml', data: 'PHN2Zz4=' } }),
    ).toThrow('mimeType is invalid');
    expect(() =>
      parseAndroidAppIcon({ ok: true, icon: { mimeType: 'text/html;base64,x', data: 'eA==' } }),
    ).toThrow('mimeType is invalid');
  });

  test('rejects a payload that is not a success envelope', () => {
    expect(() => parseAndroidAppIcon(null)).toThrow('response is invalid');
    expect(() => parseAndroidAppIcon([{ ok: true, icon: null }])).toThrow('response is invalid');
    expect(() => parseAndroidAppIcon({ ok: false, error: 'nope' })).toThrow('response is invalid');
  });

  test('rejects a missing or malformed icon member', () => {
    expect(() => parseAndroidAppIcon({ ok: true })).toThrow('must be an object');
    expect(() => parseAndroidAppIcon({ ok: true, icon: 'data:image/png;base64,aWNvbg==' })).toThrow(
      'must be an object',
    );
    expect(() => parseAndroidAppIcon({ ok: true, icon: { mimeType: 'image/png' } })).toThrow(
      'data is invalid',
    );
    expect(() =>
      parseAndroidAppIcon({ ok: true, icon: { mimeType: 'image/png', data: '' } }),
    ).toThrow('data is invalid');
  });
});

describe('carryForwardAppIcon', () => {
  const settings = { id: 'com.android.settings', iconDataUrl: 'data:image/png;base64,aWNvbg==' };

  test('keeps the resolved icon when another field of the same app changes', () => {
    const next = { id: 'com.android.settings', pid: 4242 };

    expect(carryForwardAppIcon(settings, next)).toEqual({ ...next, iconDataUrl: settings.iconDataUrl });
  });

  test('drops it when the foreground app changes', () => {
    const next = { id: 'com.android.chrome' };

    expect(carryForwardAppIcon(settings, next)).toEqual(next);
  });

  test('never overwrites an icon the update already carries', () => {
    const next = { id: 'com.android.settings', iconDataUrl: 'data:image/webp;base64,d2VicA==' };

    expect(carryForwardAppIcon(settings, next)).toEqual(next);
  });

  test('passes the first sighting through', () => {
    const next = { id: 'com.android.settings' };

    expect(carryForwardAppIcon(null, next)).toEqual(next);
  });
});
