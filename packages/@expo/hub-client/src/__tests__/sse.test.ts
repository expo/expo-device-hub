import { describe, expect, test } from 'bun:test';

import { type ParsedSseBlock, drainSseChunk } from '../sse';

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
