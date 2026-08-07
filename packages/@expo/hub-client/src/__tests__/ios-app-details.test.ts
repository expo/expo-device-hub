import { describe, expect, test } from 'bun:test';

import { type ExecResult, fetchIosAppDetails, getIosAppDetails } from '../ios-app-details';

const APP_PATH = '/Users/dev/Library/Developer/CoreSimulator/Devices/UDID/Foo.app';

const INFO_PLIST = {
  CFBundleDisplayName: 'Foo',
  CFBundleName: 'FooInternal',
  CFBundleShortVersionString: '1.2.3',
  CFBundleVersion: '456',
  MinimumOSVersion: '15.1',
  CFBundleExecutable: 'Foo',
  CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon20x20', 'AppIcon60x60'] } },
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = 'nope'): ExecResult => ({ stdout: '', stderr, exitCode: 1 });

/** Fake exec that routes by command prefix and records every call. */
function fakeExec(handlers: {
  container?: ExecResult;
  plist?: ExecResult;
  find?: ExecResult;
  base64?: ExecResult;
}) {
  const calls: string[] = [];
  const exec = async (command: string): Promise<ExecResult> => {
    calls.push(command);
    if (command.startsWith('xcrun simctl get_app_container')) return handlers.container ?? fail();
    if (command.startsWith('plutil')) return handlers.plist ?? fail();
    if (command.startsWith('bash -c')) return handlers.find ?? fail();
    if (command.startsWith('base64')) return handlers.base64 ?? fail();
    throw new Error(`unexpected command: ${command}`);
  };
  return { exec, calls };
}

describe('fetchIosAppDetails', () => {
  test('maps Info.plist fields and encodes the icon as a data URL', async () => {
    const { exec, calls } = fakeExec({
      container: ok(`${APP_PATH}\n`),
      plist: ok(JSON.stringify(INFO_PLIST)),
      find: ok(`${APP_PATH}/AppIcon60x60@2x.png\n`),
      base64: ok('aWNvbg==\n'),
    });

    const details = await fetchIosAppDetails(exec, 'UDID', 'com.example.foo');
    expect(details).toEqual({
      appPath: APP_PATH,
      label: 'Foo',
      version: '1.2.3',
      build: '456',
      minOS: '15.1',
      executable: 'Foo',
      iconDataUrl: 'data:image/png;base64,aWNvbg==',
    });
    // The icon probe asks for the *largest* icon variant from the plist.
    expect(calls.find((c) => c.startsWith('bash -c'))).toContain('AppIcon60x60@3x.png');
  });

  test('returns null when the app container cannot be resolved', async () => {
    const { exec } = fakeExec({ container: fail('No such file') });
    expect(await fetchIosAppDetails(exec, 'UDID', 'com.apple.springboard')).toBeNull();
  });

  test('omits the icon when no loose PNG exists (Assets.car only)', async () => {
    const { exec, calls } = fakeExec({
      container: ok(APP_PATH),
      plist: ok(JSON.stringify(INFO_PLIST)),
      find: fail(''),
    });

    const details = await fetchIosAppDetails(exec, 'UDID', 'com.example.foo');
    expect(details?.label).toBe('Foo');
    expect(details?.iconDataUrl).toBeUndefined();
    expect(calls.some((c) => c.startsWith('base64'))).toBe(false);
  });

  test('survives an unparseable Info.plist', async () => {
    const { exec } = fakeExec({ container: ok(APP_PATH), plist: ok('not json') });
    const details = await fetchIosAppDetails(exec, 'UDID', 'com.example.foo');
    expect(details).toEqual({
      appPath: APP_PATH,
      label: undefined,
      version: undefined,
      build: undefined,
      minOS: undefined,
      executable: undefined,
      iconDataUrl: undefined,
    });
  });
});

describe('getIosAppDetails', () => {
  test('caches per udid:bundleId and evicts on rejection', async () => {
    let execCount = 0;
    const failing = async (): Promise<ExecResult> => {
      execCount++;
      throw new Error('socket down');
    };
    await expect(getIosAppDetails(failing, 'UDID-A', 'com.example.cache')).rejects.toThrow();
    // Rejection evicted the entry, so the retry hits exec again…
    await expect(getIosAppDetails(failing, 'UDID-A', 'com.example.cache')).rejects.toThrow();
    expect(execCount).toBe(2);

    const { exec, calls } = fakeExec({
      container: ok(APP_PATH),
      plist: ok(JSON.stringify(INFO_PLIST)),
      find: fail(''),
    });
    const first = await getIosAppDetails(exec, 'UDID-A', 'com.example.cache');
    const callsAfterFirst = calls.length;
    const second = await getIosAppDetails(exec, 'UDID-A', 'com.example.cache');
    // …while a resolved value is served from cache without re-running exec.
    expect(second).toBe(first);
    expect(calls.length).toBe(callsAfterFirst);
  });
});
