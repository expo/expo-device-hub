import { describe, expect, test } from 'bun:test';
import { fetchScreenshot } from '../screenshot.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function pngResponse(headers: Record<string, string> = {}) {
  return async () =>
    new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png', ...headers } });
}

describe('screenshot capture', () => {
  test('posts to the screenshot endpoint for the selected device', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const respond = pngResponse();
    const fetchImpl = async (input: string, init?: RequestInit) => {
      requests.push({ input, init });
      return respond();
    };

    const capture = await fetchScreenshot(
      'http://localhost:3400/vendor/serve-sim/',
      'DEVICE A/B',
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.input).toBe(
      'http://localhost:3400/vendor/serve-sim/api/screenshot?device=DEVICE%20A%2FB',
    );
    expect(requests[0]!.init).toEqual({ method: 'POST', cache: 'no-store' });
    expect(capture?.blob.type).toBe('image/png');
    expect(new Uint8Array(await capture!.blob.arrayBuffer())).toEqual(PNG);
    expect(capture?.artifact).toBeNull();
  });

  test('reads the session artifact outcome from the response headers', async () => {
    const artifact = async (headers: Record<string, string>) =>
      (await fetchScreenshot('', null, pngResponse(headers)))?.artifact;

    expect(await artifact({ 'X-Expo-Screenshot-Artifact': 'saved' })).toEqual({ status: 'saved' });
    expect(await artifact({ 'X-Expo-Screenshot-Artifact': 'disabled' })).toEqual({
      status: 'disabled',
    });
    expect(
      await artifact({
        'X-Expo-Screenshot-Artifact': 'failed',
        'X-Expo-Screenshot-Artifact-Error': 'ENOSPC: no space left on device',
      }),
    ).toEqual({ status: 'failed', error: 'ENOSPC: no space left on device' });
    expect(await artifact({ 'X-Expo-Screenshot-Artifact': 'failed' })).toEqual({
      status: 'failed',
    });
    expect(await artifact({ 'X-Expo-Screenshot-Artifact': 'later' })).toBeNull();
  });

  test('resolves null when the capture fails', async () => {
    expect(
      await fetchScreenshot('', null, async () =>
        Response.json({ ok: false, error: 'screencap failed' }, { status: 400 }),
      ),
    ).toBeNull();
    expect(
      await fetchScreenshot('', null, async () => {
        throw new TypeError('network down');
      }),
    ).toBeNull();
  });
});
