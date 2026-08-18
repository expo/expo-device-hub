import { describe, expect, test } from 'bun:test';

import { avccFallbackReducer, initialAvccFallback } from '../avcc-fallback';

describe('AVCC fallback', () => {
  test('falls back when no decoded frame arrives', () => {
    expect(avccFallbackReducer(initialAvccFallback, 'timeout').fellBack).toBe(true);
  });

  test('keeps a stream that decoded before the timeout', () => {
    const streamed = avccFallbackReducer(initialAvccFallback, 'decoded-frame');
    expect(avccFallbackReducer(streamed, 'timeout').fellBack).toBe(false);
  });

  test('a fatal decoder error falls back even after streaming', () => {
    const streamed = avccFallbackReducer(initialAvccFallback, 'decoded-frame');
    expect(avccFallbackReducer(streamed, 'error').fellBack).toBe(true);
  });
});
