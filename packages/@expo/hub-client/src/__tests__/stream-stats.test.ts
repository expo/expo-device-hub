import { describe, expect, test } from 'bun:test';

import {
  appendStreamStatsSample,
  describeWebRtcClientCounters,
  readWebRtcClientCounters,
  readWebRtcServerFps,
} from '../stream-stats';

function statsReport(...entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry, index) => [`entry-${index}`, entry])) as unknown as RTCStatsReport;
}

describe('WebRTC stream statistics', () => {
  test('reads the active video receiver bytes and the browser presentation counter', () => {
    expect(
      readWebRtcClientCounters(
        statsReport(
          { type: 'inbound-rtp', kind: 'audio', framesDecoded: 900, bytesReceived: 9_000 },
          { type: 'inbound-rtp', kind: 'video', framesDecoded: 10, bytesReceived: 1_000 },
          { type: 'inbound-rtp', mediaType: 'video', framesDecoded: 20, bytesReceived: 2_000 },
        ),
        1_000,
        12,
      ),
    ).toEqual({ atMs: 1_000, presentedFrames: 12, bytesReceived: 2_000 });
  });

  test('derives presented FPS and actual received bitrate from a real elapsed window', () => {
    expect(
      describeWebRtcClientCounters(
        { atMs: 1_000, presentedFrames: 100, bytesReceived: 1_000_000 },
        { atMs: 2_000, presentedFrames: 125, bytesReceived: 2_000_000 },
      ),
    ).toEqual({ clientFps: 25, clientBitrateBps: 8_000_000 });
  });

  test('leaves rates unknown for the first, too-short, or reset window', () => {
    const current = { atMs: 1_000, presentedFrames: 30, bytesReceived: 10_000 };
    expect(describeWebRtcClientCounters(null, current)).toEqual({
      clientFps: null,
      clientBitrateBps: null,
    });
    expect(
      describeWebRtcClientCounters(current, {
        atMs: 1_100,
        presentedFrames: 33,
        bytesReceived: 11_000,
      }),
    ).toEqual({ clientFps: null, clientBitrateBps: null });
    expect(
      describeWebRtcClientCounters(current, {
        atMs: 2_000,
        presentedFrames: 1,
        bytesReceived: 100,
      }),
    ).toEqual({ clientFps: null, clientBitrateBps: null });
  });

  test('does not invent a zero baseline when inbound video stats are temporarily absent', () => {
    expect(
      readWebRtcClientCounters(
        statsReport({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 9_000 }),
        1_000,
        30,
      ),
    ).toBeNull();
  });

  test('reads Android source FPS and the matching serve-sim sender session', () => {
    expect(readWebRtcServerFps({ serverFps: 24 }, 'viewer')).toBe(24);
    expect(
      readWebRtcServerFps(
        {
          sessions: [
            { sessionId: 'other', reportedFps: 60, sourceFps: 55 },
            { sessionId: 'viewer', reportedFps: 29.8, sourceFps: 30 },
          ],
        },
        'viewer',
      ),
    ).toBe(29.8);
    expect(
      readWebRtcServerFps(
        { sessions: [{ sessionId: 'viewer', reportedFps: null, sourceFps: 12 }] },
        'viewer',
      ),
    ).toBe(12);
    expect(readWebRtcServerFps({ sessions: [{ sessionId: 'other', reportedFps: 60 }] }, 'viewer')).toBeNull();
  });

  test('keeps a bounded chronological history', () => {
    const samples = Array.from({ length: 60 }, (_, index) => ({
      atMs: index,
      serverFps: index,
      clientFps: index,
      clientBitrateBps: index,
    }));
    const next = { atMs: 60, serverFps: 60, clientFps: 60, clientBitrateBps: 60 };

    expect(appendStreamStatsSample(samples, next)).toEqual([...samples.slice(1), next]);
  });
});
