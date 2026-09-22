import { describe, expect, test } from 'bun:test';

import { type ExecResult, fetchIosAppDetails, getIosAppDetails } from '../ios-app-details';
import { type HostActionParams } from '../exec-ws';

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

type Call = { action: string; params?: HostActionParams };

/** Fake host-action runner that routes by action name and records every call. */
function fakeRun(handlers: {
  container?: ExecResult;
  plist?: ExecResult;
  iconPath?: ExecResult;
  base64?: ExecResult;
}) {
  const calls: Call[] = [];
  const run = async (action: string, params?: HostActionParams): Promise<ExecResult> => {
    calls.push({ action, params });
    switch (action) {
      case 'app.container':
        return handlers.container ?? fail();
      case 'app.infoPlist':
        return handlers.plist ?? fail();
      case 'app.iconPath':
        return handlers.iconPath ?? fail('no icon found');
      case 'file.readBase64':
        return handlers.base64 ?? fail();
      default:
        throw new Error(`unexpected action: ${action}`);
    }
  };
  return { run, calls };
}

describe('fetchIosAppDetails', () => {
  test('maps Info.plist fields and encodes the icon as a data URL', async () => {
    const { run, calls } = fakeRun({
      container: ok(`${APP_PATH}\n`),
      plist: ok(JSON.stringify(INFO_PLIST)),
      iconPath: ok(`${APP_PATH}/AppIcon60x60@2x.png\n`),
      base64: ok('aWNvbg==\n'),
    });

    const details = await fetchIosAppDetails(run, 'UDID', 'com.example.foo');
    expect(details).toEqual({
      appPath: APP_PATH,
      label: 'Foo',
      version: '1.2.3',
      build: '456',
      minOS: '15.1',
      executable: 'Foo',
      iconDataUrl: 'data:image/png;base64,aWNvbg==',
    });
    // Only serve-sim's typed host actions are used — never a shell command.
    expect(calls.map((call) => call.action)).toEqual([
      'app.container',
      'app.infoPlist',
      'app.iconPath',
      'file.readBase64',
    ]);
    expect(calls[0]!.params).toEqual({ udid: 'UDID', bundleId: 'com.example.foo' });
    expect(calls[1]!.params).toEqual({ path: `${APP_PATH}/Info.plist` });
    // The icon probe asks for the *largest* icon variant from the plist first.
    expect(calls[2]!.params).toEqual({
      appPath: APP_PATH,
      candidates: [
        'AppIcon60x60@3x.png',
        'AppIcon60x60@2x.png',
        'AppIcon60x60.png',
        'AppIcon60x6060x60@3x.png',
        'AppIcon60x6060x60@2x.png',
      ],
    });
    expect(calls[3]!.params).toEqual({ path: `${APP_PATH}/AppIcon60x60@2x.png` });
  });

  test('returns null when the app container cannot be resolved', async () => {
    const { run } = fakeRun({ container: fail('No such file') });
    expect(await fetchIosAppDetails(run, 'UDID', 'com.apple.springboard')).toBeNull();
  });

  test('omits the icon when no loose PNG exists (Assets.car only)', async () => {
    const { run, calls } = fakeRun({
      container: ok(APP_PATH),
      plist: ok(JSON.stringify(INFO_PLIST)),
      iconPath: fail('no icon found'),
    });

    const details = await fetchIosAppDetails(run, 'UDID', 'com.example.foo');
    expect(details?.label).toBe('Foo');
    expect(details?.iconDataUrl).toBeUndefined();
    expect(calls.some((call) => call.action === 'file.readBase64')).toBe(false);
  });

  test('survives an unparseable Info.plist', async () => {
    const { run } = fakeRun({ container: ok(APP_PATH), plist: ok('not json') });
    const details = await fetchIosAppDetails(run, 'UDID', 'com.example.foo');
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
    let runCount = 0;
    const failing = async (): Promise<ExecResult> => {
      runCount++;
      throw new Error('socket down');
    };
    await expect(getIosAppDetails(failing, 'UDID-A', 'com.example.cache')).rejects.toThrow();
    // Rejection evicted the entry, so the retry hits the runner again…
    await expect(getIosAppDetails(failing, 'UDID-A', 'com.example.cache')).rejects.toThrow();
    expect(runCount).toBe(2);

    const { run, calls } = fakeRun({
      container: ok(APP_PATH),
      plist: ok(JSON.stringify(INFO_PLIST)),
      iconPath: fail(''),
    });
    const first = await getIosAppDetails(run, 'UDID-A', 'com.example.cache');
    const callsAfterFirst = calls.length;
    const second = await getIosAppDetails(run, 'UDID-A', 'com.example.cache');
    // …while a resolved value is served from cache without re-running actions.
    expect(second).toBe(first);
    expect(calls.length).toBe(callsAfterFirst);
  });
});
