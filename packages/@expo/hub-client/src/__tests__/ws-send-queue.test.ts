import { describe, expect, test } from 'bun:test';

import {
  encodeWsMessage,
  enqueueWsMessage,
  flushWsMessageQueue,
  sendOrQueueWsMessage,
  WS_OPEN_READY_STATE,
  type WsSendTarget,
} from '../ws-send-queue';

function sentPayload(data: Uint8Array) {
  return {
    tag: data[0],
    payload: JSON.parse(new TextDecoder().decode(data.subarray(1))),
  };
}

function openWs() {
  const sent: ArrayBuffer[] = [];
  const ws: WsSendTarget = {
    readyState: WS_OPEN_READY_STATE,
    send(data) {
      sent.push(data);
    },
  };
  return { ws, sent };
}

describe('ws send queue', () => {
  test('encodes a tagged JSON message', () => {
    expect(sentPayload(encodeWsMessage(0x03, { type: 'begin', x: 0.5 }))).toEqual({
      tag: 0x03,
      payload: { type: 'begin', x: 0.5 },
    });
  });

  test('queues messages while the WebSocket is not open', () => {
    const queue = sendOrQueueWsMessage(null, [], 0x03, { type: 'begin' }, 1_000);
    expect(queue).toEqual([{ tag: 0x03, payload: { type: 'begin' }, createdAt: 1_000 }]);
  });

  test('flushes queued messages before the current open-socket message', () => {
    const { ws, sent } = openWs();
    const queue = sendOrQueueWsMessage(
      ws,
      [{ tag: 0x03, payload: { type: 'begin' }, createdAt: 1_000 }],
      0x03,
      { type: 'end' },
      1_100,
    );

    expect(queue).toEqual([]);
    expect(sent.map((data) => sentPayload(new Uint8Array(data)))).toEqual([
      { tag: 0x03, payload: { type: 'begin' } },
      { tag: 0x03, payload: { type: 'end' } },
    ]);
  });

  test('drops stale queued messages instead of replaying old gestures', () => {
    const { ws, sent } = openWs();
    const queue = flushWsMessageQueue(
      ws,
      [{ tag: 0x03, payload: { type: 'begin' }, createdAt: 1_000 }],
      3_000,
    );

    expect(queue).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('caps the queue by trimming oldest messages', () => {
    const queue = enqueueWsMessage(
      [
        { tag: 0x03, payload: { i: 1 }, createdAt: 1 },
        { tag: 0x03, payload: { i: 2 }, createdAt: 2 },
      ],
      { tag: 0x03, payload: { i: 3 }, createdAt: 3 },
      2,
    );

    expect(queue.map((message) => message.payload)).toEqual([{ i: 2 }, { i: 3 }]);
  });

  test('resolves lazy payloads and reports successful sends in delivery order', () => {
    const { ws, sent } = openWs();
    let cursor = 0;
    const payload = () => ({ next: cursor + 1 });
    const onSent = (message: object) => { cursor = (message as { next: number }).next; };
    let queue = sendOrQueueWsMessage(null, [], 0x07, payload, 1000, onSent);
    queue = sendOrQueueWsMessage(null, queue, 0x07, payload, 1000, onSent);
    expect(cursor).toBe(0);
    queue = sendOrQueueWsMessage(ws, queue, 0x07, payload, 1100, onSent);
    expect(queue).toEqual([]);
    expect(cursor).toBe(3);
    expect(sent.map((data) => sentPayload(new Uint8Array(data)).payload)).toEqual([
      { next: 1 }, { next: 2 }, { next: 3 },
    ]);
  });

  test('does not resolve or report dropped lazy messages', () => {
    const { ws } = openWs();
    const payload = () => { throw new Error('must not resolve'); };
    const onSent = () => { throw new Error('must not report'); };
    const queue = sendOrQueueWsMessage(null, [], 0x07, payload, 1000, onSent);
    expect(flushWsMessageQueue(ws, queue, 3000)).toEqual([]);
    const evicted = enqueueWsMessage(queue, { tag: 3, payload: {}, createdAt: 1000 }, 1);
    expect(flushWsMessageQueue(ws, evicted, 1100)).toEqual([]);
  });

  test('does not report a send that throws', () => {
    let reported = false;
    const ws = { readyState: 1, send() { throw new Error('closed'); } };
    expect(() => sendOrQueueWsMessage(ws, [], 7, {}, 1000, () => { reported = true; })).toThrow('closed');
    expect(reported).toBe(false);
  });
});
