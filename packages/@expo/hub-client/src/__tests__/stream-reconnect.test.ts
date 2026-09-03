import { describe, expect, test } from 'bun:test';

import {
  isDeliberateServerClose,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  scheduleReconnect,
  SERVER_RESTART_RECONNECT_DELAY_MS,
  STREAM_RECONNECT_GRACE_MS,
} from '../stream-reconnect';

describe('stream reconnect policy', () => {
  test('recognizes the close codes a server sends on purpose', () => {
    expect(isDeliberateServerClose(1000)).toBe(true);
    // serve-emu: "server stopping" and "stream source switched".
    expect(isDeliberateServerClose(1001)).toBe(true);
    expect(isDeliberateServerClose(1012)).toBe(true);
    expect(isDeliberateServerClose(1006)).toBe(false);
    expect(isDeliberateServerClose(1008)).toBe(false);
    expect(isDeliberateServerClose(1011)).toBe(false);
  });

  test('retries a healthy stream almost immediately after a deliberate server close', () => {
    const schedule = scheduleReconnect({
      code: 1001,
      wasHealthy: true,
      currentDelay: RECONNECT_BASE_DELAY_MS,
    });

    expect(schedule.retryIn).toBe(SERVER_RESTART_RECONNECT_DELAY_MS);
    expect(schedule.retryIn).toBeLessThan(RECONNECT_BASE_DELAY_MS);
    expect(schedule.nextDelay).toBe(800);
  });

  test('keeps the backoff for abnormal closes and for sockets that never became healthy', () => {
    expect(
      scheduleReconnect({ code: 1006, wasHealthy: true, currentDelay: RECONNECT_BASE_DELAY_MS }),
    ).toEqual({ retryIn: RECONNECT_BASE_DELAY_MS, nextDelay: 800 });
    expect(scheduleReconnect({ code: 1001, wasHealthy: false, currentDelay: 800 })).toEqual({
      retryIn: 800,
      nextDelay: 1280,
    });
  });

  test('caps the backoff', () => {
    expect(
      scheduleReconnect({ code: 1006, wasHealthy: false, currentDelay: RECONNECT_MAX_DELAY_MS }),
    ).toEqual({ retryIn: RECONNECT_MAX_DELAY_MS, nextDelay: RECONNECT_MAX_DELAY_MS });
  });

  test('the grace period outlasts a typical source switch', () => {
    // Measured serve-emu switches: 1.3 s (MMAP) to 2.3 s (PNG) from the close
    // frame to the first frame of the replacement session.
    expect(STREAM_RECONNECT_GRACE_MS).toBeGreaterThanOrEqual(4_000);
  });
});
