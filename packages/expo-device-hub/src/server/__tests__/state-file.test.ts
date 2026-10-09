import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearHubState, hubStateFile, localHubUrl, writeHubState } from '../cli/state-file';

const directories: string[] = [];
function stateEnv(): Record<string, string | undefined> {
  const directory = mkdtempSync(join(tmpdir(), 'hub-state-test-'));
  directories.push(directory);
  return { EXPO_DEVICE_HUB_STATE_DIR: join(directory, 'nested') };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// The EAS worker reads the token here, as it reads serve-sim's from `server-<udid>.json`.
describe('the CLI state file', () => {
  test('records the port, URL, and token where the process that started the Hub finds them', () => {
    const env = stateEnv();

    const file = writeHubState({ pid: 4242, port: 3400, url: 'http://127.0.0.1:3400', token: 'tok-1' }, env);

    expect(file).toBe(join(env.EXPO_DEVICE_HUB_STATE_DIR!, 'server-3400.json'));
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({
      pid: 4242,
      port: 3400,
      url: 'http://127.0.0.1:3400',
      token: 'tok-1',
    });
    // Only the owner can read the token, and no temporary file is left behind.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(env.EXPO_DEVICE_HUB_STATE_DIR!)).toEqual(['server-3400.json']);
  });

  test('defaults to an expo-device-hub directory in the temporary directory', () => {
    expect(hubStateFile(3400, {})).toBe(join(tmpdir(), 'expo-device-hub', 'server-3400.json'));
  });

  test('is removed only by the process that wrote it', () => {
    const env = stateEnv();
    const file = writeHubState({ pid: 4242, port: 3400, url: 'http://127.0.0.1:3400' }, env);

    clearHubState(3400, 1111, env);
    expect(existsSync(file)).toBe(true);
    clearHubState(3400, 4242, env);
    expect(existsSync(file)).toBe(false);
    // Clearing a missing file is not an error.
    clearHubState(3400, 4242, env);
  });

  test('names a URL that answers on this machine', () => {
    expect(localHubUrl('127.0.0.1', 3400)).toBe('http://127.0.0.1:3400');
    expect(localHubUrl('0.0.0.0', 3400)).toBe('http://127.0.0.1:3400');
    expect(localHubUrl('::', 3400)).toBe('http://[::1]:3400');
    expect(localHubUrl('192.168.1.20', 3400)).toBe('http://192.168.1.20:3400');
  });
});
