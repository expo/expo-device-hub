import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the exact stream hook recovers playback stalls and shares stats', () => {
  const fixture = fileURLToPath(new URL('./fixtures/webrtc-watchdog.fixture.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['test', fixture], { encoding: 'utf8' });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
