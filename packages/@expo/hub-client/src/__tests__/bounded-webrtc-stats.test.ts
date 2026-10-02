import { expect, test } from 'bun:test';
import { readStatsBeforeDeadline } from '../bounded-webrtc-stats.js';

test('timed-out readers share one underlying read until it settles', async () => {
  let reads = 0;
  let resolve!: (report: RTCStatsReport) => void;
  const peer = { getStats: () => { reads++; return new Promise<RTCStatsReport>(done => { resolve = done; }); } } as RTCPeerConnection;
  expect(await Promise.all([readStatsBeforeDeadline(peer, 5), readStatsBeforeDeadline(peer, 5)])).toEqual([null, null]);
  expect(await readStatsBeforeDeadline(peer, 5)).toBeNull();
  expect(reads).toBe(1);
  const next = readStatsBeforeDeadline(peer, 100);
  const report = new Map() as RTCStatsReport;
  resolve(report);
  expect(await next).toBe(report);
  const later = readStatsBeforeDeadline(peer, 100);
  await Promise.resolve();
  resolve(report);
  expect(await later).toBe(report);
  expect(reads).toBe(2);
});

test('a failed read does not block a later successful read', async () => {
  let reads = 0;
  const report = new Map() as RTCStatsReport;
  const peer = { getStats: async () => { if (++reads === 1) throw new Error('closed'); return report; } } as RTCPeerConnection;
  expect(await readStatsBeforeDeadline(peer)).toBeNull();
  expect(await readStatsBeforeDeadline(peer)).toBe(report);
  expect(await readStatsBeforeDeadline(null)).toBeNull();
});
