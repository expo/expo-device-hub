import { describe, expect, test } from 'bun:test';

import {
  type AdbRunner,
  getNetworkStatus,
  handleServeEmuDeviceOptionRequest,
} from '../serve-emu-device-options';

function deviceRunner(initial?: { wifi?: string; mobileData?: string; fontScale?: string }) {
  let wifi = initial?.wifi ?? '1';
  let mobileData = initial?.mobileData ?? '1';
  let fontScale = initial?.fontScale ?? '1';
  const commands: string[][] = [];
  const timeouts: number[] = [];

  const runner: AdbRunner = async (args, options) => {
    const command = [...args];
    commands.push(command);
    timeouts.push(options.timeout);
    const shell = command.slice(3);
    if (shell.join(' ') === 'settings get global wifi_on') {
      return { status: 0, stdout: `${wifi}\n`, stderr: '' };
    }
    if (shell.join(' ') === 'settings get global mobile_data') {
      return { status: 0, stdout: `${mobileData}\n`, stderr: '' };
    }
    if (shell.join(' ') === 'settings get system font_scale') {
      return { status: 0, stdout: `${fontScale}\n`, stderr: '' };
    }
    if (shell[0] === 'svc' && shell[1] === 'wifi') {
      wifi = shell[2] === 'enable' ? '1' : '0';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (shell[0] === 'svc' && shell[1] === 'data') {
      mobileData = shell[2] === 'enable' ? '1' : '0';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (shell.join(' ').startsWith('settings put system font_scale ')) {
      fontScale = shell[4]!;
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: `unexpected command: ${shell.join(' ')}` };
  };

  return { runner, commands, timeouts };
}

describe('serve-emu network compatibility route', () => {
  test('reports both radios using serve-emu response semantics', async () => {
    const { runner } = deviceRunner({ wifi: '0', mobileData: '1' });
    const response = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/network'),
      'emulator-5554',
      runner,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      network: {
        enabled: true,
        wifi: 'disabled',
        mobileData: 'enabled',
        raw: { wifi: '0', mobileData: '1' },
      },
    });
  });

  test('reports an unknown aggregate when neither radio setting is known', async () => {
    const { runner } = deviceRunner({ wifi: 'null', mobileData: '' });
    expect(await getNetworkStatus('emulator-5554', runner)).toEqual({
      enabled: null,
      wifi: 'unknown',
      mobileData: 'unknown',
      raw: { wifi: 'null', mobileData: '' },
    });
  });

  test('toggles wifi and mobile data before returning authoritative state', async () => {
    const { runner, commands, timeouts } = deviceRunner();
    const response = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/network', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      }),
      'emulator-5554',
      runner,
    );

    expect(response?.status).toBe(200);
    if (!response) throw new Error('Expected network response');
    expect((await response.json()).network.enabled).toBe(false);
    expect(commands).toEqual([
      ['-s', 'emulator-5554', 'shell', 'svc', 'wifi', 'disable'],
      ['-s', 'emulator-5554', 'shell', 'svc', 'data', 'disable'],
      ['-s', 'emulator-5554', 'shell', 'settings', 'get', 'global', 'wifi_on'],
      ['-s', 'emulator-5554', 'shell', 'settings', 'get', 'global', 'mobile_data'],
    ]);
    expect(timeouts).toEqual([5_000, 5_000, 2_000, 2_000]);
  });

  test('rejects malformed writes and unsupported methods', async () => {
    const { runner } = deviceRunner();
    const malformed = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/network', { method: 'POST', body: '{}' }),
      'emulator-5554',
      runner,
    );
    const unsupported = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/network', { method: 'DELETE' }),
      'emulator-5554',
      runner,
    );

    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toEqual({ ok: false, error: 'enabled must be a boolean' });
    expect(unsupported?.status).toBe(405);
  });

  test('bounds streamed JSON bodies before parsing or running adb', async () => {
    const { runner, commands } = deviceRunner();
    const response = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/network', {
        method: 'POST',
        body: JSON.stringify({ enabled: false, padding: 'x'.repeat(9_000) }),
      }),
      'emulator-5554',
      runner,
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ ok: false, error: 'request body too large' });
    expect(commands).toEqual([]);
  });
});

describe('serve-emu font-scale compatibility route', () => {
  test('normalizes the numeric scale exactly like serve-emu', async () => {
    const { runner, commands, timeouts } = deviceRunner({ fontScale: '1' });
    const response = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/font-scale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scale: 1.3 }),
      }),
      'emulator-5554',
      runner,
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      ok: true,
      fontScale: { scale: 1.3, raw: '1.3' },
    });
    expect(commands).toEqual([
      ['-s', 'emulator-5554', 'shell', 'settings', 'put', 'system', 'font_scale', '1.3'],
      ['-s', 'emulator-5554', 'shell', 'settings', 'get', 'system', 'font_scale'],
    ]);
    expect(timeouts).toEqual([5_000, 2_000]);
  });

  test('enforces serve-emu bounds and leaves unrelated routes alone', async () => {
    const { runner } = deviceRunner();
    const invalid = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/font-scale', {
        method: 'POST',
        body: JSON.stringify({ scale: 2.1 }),
      }),
      'emulator-5554',
      runner,
    );
    const unrelated = await handleServeEmuDeviceOptionRequest(
      new Request('http://localhost/api/uimode'),
      'emulator-5554',
      runner,
    );

    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toEqual({
      ok: false,
      error: 'scale must be a number between 0.7 and 2.0',
    });
    expect(unrelated).toBeNull();
  });
});
