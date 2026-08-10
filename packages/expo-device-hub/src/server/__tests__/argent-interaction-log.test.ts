import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ArgentInteractionLog } from '../argent-interaction-log';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

function call(x: number): string {
  return JSON.stringify({
    ts: `2026-08-10T13:59:2${x}.315Z`,
    event: 'tool_called',
    name: 'gesture-tap',
    args: { udid: 'device-1', x: x / 10, y: 0.5 },
  });
}

describe('ArgentInteractionLog', () => {
  test('reads appended complete records once and retains partial lines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'expo-device-hub-argent-'));
    tempDirectories.push(directory);
    const path = join(directory, 'mcp-calls.log');
    const second = call(2);
    const splitAt = Math.floor(second.length / 2);
    await writeFile(path, `${call(1)}\n${second.slice(0, splitAt)}`);
    const log = new ArgentInteractionLog(path);

    expect((await log.read()).map((event) => event.segments[0]?.frames[0]?.points[0]?.x)).toEqual([
      0.1,
    ]);
    expect(await log.read()).toEqual([]);

    await appendFile(path, `${second.slice(splitAt)}\n${call(3)}\n`);
    expect((await log.read()).map((event) => event.segments[0]?.frames[0]?.points[0]?.x)).toEqual([
      0.2, 0.3,
    ]);
  });

  test('returns an empty list while the log does not exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'expo-device-hub-argent-'));
    tempDirectories.push(directory);
    expect(await new ArgentInteractionLog(join(directory, 'missing.log')).read()).toEqual([]);
  });
});
