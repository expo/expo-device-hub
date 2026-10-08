import { expect, test } from 'bun:test';

import { duoPanelStatus, duoPanelUrl } from '../duo/duo-panels';

const live = { streaming: true, error: null, failure: null };
const waiting = { streaming: false, error: null, failure: null };

test('panel routes hang off the proxied helper mount, with or without a stream suffix', () => {
  const helper = 'http://localhost:8081/_expo/plugins/expo-device-hub/vendor/serve-sim/helper/UDID-1';
  expect(duoPanelUrl(helper, 1)).toBe(`${helper}/panel/1`);
  expect(duoPanelUrl(`${helper}/`, 3)).toBe(`${helper}/panel/3`);
  expect(duoPanelUrl(`${helper}/stream.mjpeg?codec=h264#x`, 3)).toBe(`${helper}/panel/3`);
  expect(duoPanelUrl('https://stream.example.test/helper/UDID-2/stream.avcc', 1)).toBe(
    'https://stream.example.test/helper/UDID-2/panel/1',
  );
});

test('a healthy inactive feed does not hide a disconnected displayed panel', () => {
  expect(duoPanelStatus('avcc', 3, { 1: live, 3: waiting })).toEqual({ streaming: false, error: null });
  expect(duoPanelStatus('avcc', 1, { 1: live, 3: waiting })).toEqual({ streaming: true, error: null });
  expect(duoPanelStatus('mjpeg', 1, { 1: waiting, 3: live })).toEqual({ streaming: false, error: null });
});

test('terminal codec failure is visible even when the decoder supplies no error string', () => {
  const failed = { ...live, failure: { kind: 'codec' as const, codec: 'vp9' as const, sessionId: 'inner' } };
  const result = duoPanelStatus('webrtc', 3, { 1: live, 3: failed });
  expect(result.streaming).toBe(false);
  expect(result.error).toContain('WebRTC');
  expect(duoPanelStatus('webrtc', 1, { 1: live, 3: failed })).toEqual({ streaming: true, error: null });
});

test('native WebRTC errors reach the selected panel and clear after recovery or HTTP fallback', () => {
  const failed = { ...live, error: 'WebRTC signaling failed. Retrying...' };
  expect(duoPanelStatus('webrtc', 3, { 1: live, 3: failed })).toEqual({
    streaming: false,
    error: failed.error,
  });
  expect(duoPanelStatus('webrtc', 3, { 1: live, 3: live })).toEqual({ streaming: true, error: null });
  expect(duoPanelStatus('mjpeg', 3, { 1: live, 3: failed })).toEqual({ streaming: true, error: null });
});
