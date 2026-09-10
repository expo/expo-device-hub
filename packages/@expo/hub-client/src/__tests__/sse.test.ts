import { describe, expect, test } from 'bun:test';

import { type ParsedSseBlock, type SseFetch, drainSseChunk, readSseSnapshot } from '../sse';

function drainAll(chunks: readonly string[]): { blocks: ParsedSseBlock[]; tail: string } {
  const blocks: ParsedSseBlock[] = [];
  let tail = '';
  for (const chunk of chunks) {
    tail = drainSseChunk(tail, chunk, (block) => blocks.push(block));
  }
  return { blocks, tail };
}

describe('drainSseChunk', () => {
  test('emits complete blocks and keeps the partial tail', () => {
    const { blocks, tail } = drainAll(['data: one\n\ndata: tw']);
    expect(blocks).toEqual([{ event: 'message', data: 'one' }]);
    expect(tail).toBe('data: tw');
  });

  test('joins a block split across chunks', () => {
    const { blocks, tail } = drainAll(['event: metrics\nda', 'ta: {"t":1}\n\n']);
    expect(blocks).toEqual([{ event: 'metrics', data: '{"t":1}' }]);
    expect(tail).toBe('');
  });

  test('normalizes CRLF line endings', () => {
    const { blocks } = drainAll(['event: meta\r\ndata: a\r\n\r\ndata: b\r\n\r\n']);
    expect(blocks).toEqual([
      { event: 'meta', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  test('joins multiple data lines and skips comment-only blocks', () => {
    const { blocks } = drainAll([':\n\ndata: a\ndata: b\n\n']);
    expect(blocks).toEqual([{ event: 'message', data: 'a\nb' }]);
  });
});

interface SseScript {
  push: (text: string) => void;
  close: () => void;
  fail: (cause: Error) => void;
}

function sseFetch(script: (emit: SseScript) => void): SseFetch {
  return (_url, init) => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        ended = true;
      },
    });
    init?.signal?.addEventListener('abort', () => {
      if (ended) return;
      ended = true;
      controller.error(new Error('aborted'));
    });
    script({
      push: (text) => {
        if (!ended) controller.enqueue(encoder.encode(text));
      },
      close: () => {
        if (ended) return;
        ended = true;
        controller.close();
      },
      fail: (cause) => {
        if (ended) return;
        ended = true;
        controller.error(cause);
      },
    });
    return Promise.resolve(new Response(stream));
  };
}

describe('readSseSnapshot', () => {
  test('returns the newest block when a second arrives inside the settle window', async () => {
    const fetchImpl = sseFetch(({ push }) => {
      push('data: cached\n\n');
      setTimeout(() => push('data: fresh\n\n'), 5);
    });
    const snapshot = await readSseSnapshot('http://sim/ax', {
      fetchImpl,
      signal: new AbortController().signal,
      settleMs: 500,
    });
    expect(snapshot).toBe('fresh');
  });

  test('returns the only block once the settle window closes the stream', async () => {
    const fetchImpl = sseFetch(({ push }) => push('data: cached\n\n'));
    const snapshot = await readSseSnapshot('http://sim/ax', {
      fetchImpl,
      signal: new AbortController().signal,
      settleMs: 20,
    });
    expect(snapshot).toBe('cached');
  });

  test('rejects a mid-read stream failure instead of passing off the stale first block', async () => {
    const fetchImpl = sseFetch(({ push, fail }) => {
      push('data: cached\n\n');
      setTimeout(() => fail(new Error('connection reset')), 5);
    });
    await expect(
      readSseSnapshot('http://sim/ax', {
        fetchImpl,
        signal: new AbortController().signal,
        settleMs: 5000,
      }),
    ).rejects.toThrow('connection reset');
  });

  test('rejects a non-2xx answer with its status instead of draining the body as SSE', async () => {
    const fetchImpl: SseFetch = () =>
      Promise.resolve(new Response('No serve-sim device', { status: 404 }));
    await expect(
      readSseSnapshot('http://sim/ax', {
        fetchImpl,
        signal: new AbortController().signal,
        settleMs: 500,
      }),
    ).rejects.toThrow('HTTP 404');
  });

  test('returns null when the stream ends before any block', async () => {
    const fetchImpl = sseFetch(({ close }) => close());
    const snapshot = await readSseSnapshot('http://sim/ax', {
      fetchImpl,
      signal: new AbortController().signal,
      settleMs: 500,
    });
    expect(snapshot).toBeNull();
  });

  test('returns null when the caller aborts before any block', async () => {
    const controller = new AbortController();
    const fetchImpl = sseFetch(() => setTimeout(() => controller.abort(), 5));
    const snapshot = await readSseSnapshot('http://sim/ax', {
      fetchImpl,
      signal: controller.signal,
      settleMs: 5000,
    });
    expect(snapshot).toBeNull();
  });

  test('never opens the stream when the signal is already aborted', async () => {
    let opened = false;
    const fetchImpl = sseFetch(() => {
      opened = true;
    });
    const snapshot = await readSseSnapshot('http://sim/ax', {
      fetchImpl,
      signal: AbortSignal.abort(),
      settleMs: 500,
    });
    expect(snapshot).toBeNull();
    expect(opened).toBe(false);
  });
});
