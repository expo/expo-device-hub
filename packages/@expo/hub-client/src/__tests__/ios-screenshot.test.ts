import { describe, expect, test } from 'bun:test';
import { fetchIosScreenshot } from '../ios-screenshot';

describe('iOS screenshot capture', () => {
  test('posts to the serve-sim screenshot endpoint for the selected device', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = async (input: string, init?: RequestInit) => {
      requests.push({ input, init });
      return new Response(png, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    };

    const blob = await fetchIosScreenshot(
      'http://localhost:3400/vendor/serve-sim/',
      'DEVICE A/B',
      fetchImpl,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.input).toBe(
      'http://localhost:3400/vendor/serve-sim/api/screenshot?device=DEVICE%20A%2FB',
    );
    expect(requests[0]!.init).toEqual({ method: 'POST', cache: 'no-store' });
    expect(blob?.type).toBe('image/png');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(png);
  });
});
