import { expect, test } from 'bun:test';

import { ARGENT_INTERACTION_MESSAGE_TYPE } from '../../argent-interaction-protocol';
import {
  ArgentInteractionBroadcaster,
  type ArgentInteractionSocket,
} from '../argent-interaction-websocket';
import { type AgentInteraction } from '@expo/hub-client';

const FIRST: AgentInteraction = {
  id: 'first',
  deviceId: 'device-1',
  timestamp: '2026-08-10T13:59:21.315Z',
  segments: [{ startMs: 0, frames: [{ atMs: 0, points: [{ x: 0.2, y: 0.5 }] }] }],
};

const SECOND: AgentInteraction = {
  ...FIRST,
  id: 'second',
  timestamp: '2026-08-10T13:59:22.315Z',
  segments: [{ startMs: 0, frames: [{ atMs: 0, points: [{ x: 0.8, y: 0.5 }] }] }],
};

class FakeSocket implements ArgentInteractionSocket {
  sent: string[] = [];
  listeners = { close: [] as Array<() => void>, error: [] as Array<() => void> };

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit('close');
  }
  on(event: 'close' | 'error', listener: () => void): void {
    this.listeners[event].push(listener);
  }
  emit(event: 'close' | 'error'): void {
    for (const listener of this.listeners[event]) listener();
  }
}

function manualScheduler() {
  let callback: (() => void) | null = null;
  return {
    schedule(next: () => void) {
      callback = next;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancelSchedule() {
      callback = null;
    },
    run() {
      const next = callback;
      callback = null;
      if (!next) throw new Error('No poll scheduled');
      next();
    },
  };
}

async function flushPoll(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('sends only the latest historical interaction, then streams new calls', async () => {
  const scheduler = manualScheduler();
  const batches = [[FIRST, SECOND], [FIRST]];
  const broadcaster = new ArgentInteractionBroadcaster({
    read: async () => batches.shift() ?? [],
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });
  const socket = new FakeSocket();
  broadcaster.subscribe(socket);
  await flushPoll();

  expect(socket.sent).toHaveLength(1);
  expect(JSON.parse(socket.sent[0]!)).toEqual({
    type: ARGENT_INTERACTION_MESSAGE_TYPE,
    interaction: SECOND,
  });

  scheduler.run();
  await flushPoll();
  expect(socket.sent).toHaveLength(2);
  expect(JSON.parse(socket.sent[1]!).interaction).toEqual(FIRST);
});
