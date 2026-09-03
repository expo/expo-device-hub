import { describe, expect, test } from 'bun:test';

import { presentedVideoFrameDelta } from '../video-frame-metadata';

describe('video frame metadata', () => {
  test('counts frames skipped between video-frame callbacks', () => {
    expect(presentedVideoFrameDelta(null, 40)).toBe(1);
    expect(presentedVideoFrameDelta(40, 43)).toBe(3);
    expect(presentedVideoFrameDelta(43, 43)).toBe(1);
    expect(presentedVideoFrameDelta(43, 2)).toBe(1);
    expect(presentedVideoFrameDelta(43, Number.NaN)).toBe(1);
  });
});
