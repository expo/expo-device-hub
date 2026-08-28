import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS,
  handleServeEmuStreamStatsRequest,
  readServeEmuStreamStats,
} from '../serve-emu-stream-stats';
import { EMU_PREFIX, handleEmuRequest } from '../serve-emu';

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

describe('serve-emu WebRTC stream stats compatibility route', () => {
  test('is mounted at the device-scoped serve-emu WebRTC stats URL', async () => {
    const response = await handleEmuRequest(
      new Request(`http://localhost${EMU_PREFIX}/webrtc/stats?sessionId=invalid`),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_session_id',
      message: 'Invalid WebRTC session ID',
    });
  });

  test('shapes only honest source metrics from broad multi-peer health', () => {
    const health = {
      codec: 'h264',
      frames: 1_234,
      sourceFps: 58.5,
      targetBitrateBps: 4_000_000,
      webRtcEnabled: true,
      session: { events: [{ payload: 'must not be serialized' }] },
      webrtc: {
        detail: [
          { sentFrames: 1_000, droppedFrames: 3, candidate: 'private peer data' },
          { sentFrames: 2_000, droppedFrames: 7, candidate: 'other private peer data' },
        ],
      },
    };

    expect(readServeEmuStreamStats(health, 42)).toEqual({
      sampledAt: 42,
      serverFps: 58.5,
      frames: 1_234,
      encoder: {
        codec: 'h264',
        encodeFps: 58.5,
        targetBitrateBps: 4_000_000,
        encodeMsPerFrame: null,
        framesEncoded: 1_234,
        framesSent: null,
        framesDropped: null,
        packetLossRatio: null,
        qualityLimitationReason: null,
      },
      capture: {
        screenFrames: null,
        idleFrames: null,
        offeredFrames: 1_234,
        forwardedFrames: null,
        pumpRestarts: null,
      },
    });
  });

  test('uses scrcpy defaults and nulls unsupported counters instead of reporting zero', () => {
    expect(
      readServeEmuStreamStats({ frames: 0, sourceFps: 0, webRtcEnabled: true }, 42),
    ).toEqual({
      sampledAt: 42,
      serverFps: 0,
      frames: 0,
      encoder: {
        codec: null,
        encodeFps: 0,
        targetBitrateBps: DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS,
        encodeMsPerFrame: null,
        framesEncoded: 0,
        framesSent: null,
        framesDropped: null,
        packetLossRatio: null,
        qualityLimitationReason: null,
      },
      capture: {
        screenFrames: null,
        idleFrames: null,
        offeredFrames: 0,
        forwardedFrames: null,
        pumpRestarts: null,
      },
    });
  });

  test('returns no-store JSON and accepts serve-sim-compatible session IDs', async () => {
    const response = await handleServeEmuStreamStatsRequest(
      new Request(`http://localhost/webrtc/stats?sessionId=${SESSION_ID}`),
      () => ({
        codec: 'h264',
        frames: 240,
        sourceFps: 60,
        targetBitrateBps: 6_000_000,
        webRtcEnabled: true,
      }),
      () => 1_725_000_000_000,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      sampledAt: 1_725_000_000_000,
      serverFps: 60,
      frames: 240,
      encoder: {
        codec: 'h264',
        encodeFps: 60,
        targetBitrateBps: 6_000_000,
        encodeMsPerFrame: null,
        framesEncoded: 240,
        framesSent: null,
        framesDropped: null,
        packetLossRatio: null,
        qualityLimitationReason: null,
      },
      capture: {
        screenFrames: null,
        idleFrames: null,
        offeredFrames: 240,
        forwardedFrames: null,
        pumpRestarts: null,
      },
    });
  });

  test('does not report WebRTC capture deliveries for a WebSocket stream', () => {
    const stats = readServeEmuStreamStats({ frames: 240, sourceFps: 60 }, 42);

    expect(stats.capture.offeredFrames).toBeNull();
  });

  test('rejects invalid session IDs before reading device health', async () => {
    let healthReads = 0;
    const response = await handleServeEmuStreamStatsRequest(
      new Request('http://localhost/webrtc/stats?sessionId=not-a-uuid'),
      () => {
        healthReads++;
        return { frames: 0, sourceFps: 0 };
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'invalid_session_id',
      message: 'Invalid WebRTC session ID',
    });
    expect(healthReads).toBe(0);
  });

  test('requires GET without reading device health', async () => {
    let healthReads = 0;
    const response = await handleServeEmuStreamStatsRequest(
      new Request('http://localhost/webrtc/stats', { method: 'POST' }),
      () => {
        healthReads++;
        return { frames: 0, sourceFps: 0 };
      },
    );

    expect(response.status).toBe(405);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'method_not_allowed' });
    expect(healthReads).toBe(0);
  });

  test('returns a no-store 503 when health is unavailable', async () => {
    const errors: unknown[] = [];
    const response = await handleServeEmuStreamStatsRequest(
      new Request('http://localhost/webrtc/stats'),
      async () => {
        throw new Error('device disconnected');
      },
      Date.now,
      (error) => errors.push(error),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'webrtc_stats_unavailable' });
    expect(errors).toHaveLength(1);
  });
});
