import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FeatureSession } from '../feature-state';
import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useAppPermissions } from '../useAppPermissions';
import { useFeatureSession } from '../feature-state';
import { useWebRtcStreamStats, type WebRtcStatsConnection } from '../stream-stats';
import type { AppPermission, DeviceClient, DeviceStreamStats } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let client: DeviceClient;
let requests: Array<{ url: URL; init?: RequestInit; resolve(response: Response): void }>;
class Socket {
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}
class Events {
  static instances: Events[] = [];
  onopen?: () => void;
  onerror?: () => void;
  listeners = new Map<string, (event: unknown) => void>();
  constructor(readonly url: string) {
    Events.instances.push(this);
  }
  addEventListener(name: string, listener: (event: unknown) => void) {
    this.listeners.set(name, listener);
  }
  close() {}
}
beforeEach(() => {
  requests = [];
  Events.instances = [];
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    location: { href: 'https://hub.test/' },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', Socket);
  stubGlobal('EventSource', Events);
  stubGlobal(
    'fetch',
    (input: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        requests.push({ url: new URL(input), init, resolve });
      }),
  );
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});
function Harness({ device = 'a' }: { device?: string }) {
  client = useAndroidDeviceClient({ baseUrl: 'https://hub.test', device, streamMode: 'h264' });
  return null;
}
async function respond(path: string, payload: unknown, status = 200) {
  const request = requests.findLast((request) => request.url.pathname === path)!;
  expect(request).toBeDefined();
  await act(async () => request.resolve(Response.json(payload, { status })));
}
async function mount() {
  await act(async () => {
    renderer = create(<Harness />);
  });
}

test('discovery, first read, refresh and failure have distinct states and retain data', async () => {
  await mount();
  expect(client.streamSettings.status).toBe('resolving');
  expect(client.streamSettings.data).toBeUndefined();
  await respond('/api', {});
  expect(client.streamSettings.status).toBe('loading');
  await respond('/api/stream-settings', { maxDimension: 1280 });
  expect(client.streamSettings.status).toBe('ready');
  const previous = client.streamSettings.data;
  const refresh = client.streamSettings.refresh;
  await act(async () => refresh());
  expect(client.streamSettings.status).toBe('loading');
  expect(client.streamSettings.data).toBe(previous);
  await respond('/api/stream-settings', {}, 503);
  expect(client.streamSettings.status).toBe('error');
  expect(client.streamSettings.error?.retryable).toBe(true);
  expect(client.streamSettings.data).toBe(previous);
  await act(async () => refresh());
  await respond('/api/stream-settings', { maxDimension: 720 });
  expect(client.streamSettings.status).toBe('ready');
  expect(client.streamSettings.data?.maxDimension).toBe(720);
  expect(client.streamSettings.refresh).toBe(refresh);
});

test('configuration authentication failure is an error and refresh retries discovery', async () => {
  await mount();
  await respond('/api', {}, 401);
  expect(client.location.status).toBe('error');
  expect(client.location.error).toMatchObject({ code: 'auth', retryable: false });
  await act(async () => client.location.refresh());
  expect(client.location.status).toBe('resolving');
  await respond('/api', {});
  expect(client.location.status).toBe('loading');
  await respond('/api/location', { emulator: false });
  expect(client.location.status).toBe('unsupported');
});

test('a new device immediately loses the previous device data and ignores old reads', async () => {
  await mount();
  await respond('/api', {});
  await respond('/api/stream-settings', { maxDimension: 1280 });
  await act(async () => client.streamSettings.refresh());
  const oldRequest = requests.findLast(
    (request) => request.url.pathname === '/api/stream-settings',
  )!;
  await act(async () => renderer!.update(<Harness device="b" />));
  expect(client.streamSettings.status).toBe('resolving');
  expect(client.streamSettings.data).toBeUndefined();
  await act(async () => oldRequest.resolve(Response.json({ maxDimension: 999 })));
  await respond('/api', {});
  expect(client.streamSettings.data).toBeUndefined();
  await respond('/api/stream-settings', { maxDimension: 720 });
  expect(client.streamSettings.data?.maxDimension).toBe(720);
});

test('subscription intent survives discovery and an empty open log stream is ready', async () => {
  await mount();
  expect(client.logs.enabled).toBe(false);
  await act(async () => client.logs.attach());
  expect(client.logs.enabled).toBe(true);
  expect(client.logs.status).toBe('resolving');
  await respond('/api', {});
  expect(client.logs.status).toBe('loading');
  const events = Events.instances.find((source) => source.url.includes('/api/logcat'))!;
  await act(async () => events.onopen?.());
  expect(client.logs.status).toBe('ready');
  expect(client.logs.data).toEqual([]);
  await act(async () => events.listeners.get('log')?.({ data: JSON.stringify({ line: 'hello' }) }));
  await act(async () => client.logs.detach());
  expect(client.logs.status).toBe('idle');
  expect(client.logs.enabled).toBe(false);
  expect(client.logs.data?.[0]?.message).toBe('hello');
  await act(async () => events.listeners.get('log')?.({ data: JSON.stringify({ line: 'late' }) }));
  expect(client.logs.data).toHaveLength(1);
  await act(async () => renderer!.update(<Harness device="b" />));
  await respond('/api', {});
  await act(async () => client.logs.attach());
  const next = Events.instances.findLast((source) => source.url.includes('/api/logcat'))!;
  await act(async () => next.onopen?.());
  expect(client.logs.data).toEqual([]);
});

test('failed writes settle as results, expose per-field errors, and reject overlap', async () => {
  await mount();
  await respond('/api', {});
  await respond('/api/stream-settings', { maxDimension: 1280 });
  // Source must have finished loading before the encoder can be changed.
  await respond('/api/stream-mode', {
    mode: 'scrcpy',
    availableModes: ['scrcpy'],
    grpcImageMode: 'png',
    encoder: 'software',
    inputSource: 'scrcpy',
  });
  let result!: ReturnType<DeviceClient['streamSettings']['update']>;
  await act(async () => {
    result = client.streamSettings.update({ maxDimension: 720 });
  });
  expect(client.streamSettings.writes.pending.has('maxDimension')).toBe(true);
  const busy = await client.streamSettings.update({ maxDimension: 800 });
  expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } });
  await respond('/api/stream-settings', {}, 503);
  expect(await result).toMatchObject({ ok: false });
  expect(client.streamSettings.writes.pending.size).toBe(0);
  expect(client.streamSettings.writes.errors.has('maxDimension')).toBe(true);
  expect(client.streamSettings.data?.maxDimension).toBe(1280);
});

test('permissions discard app A reads after switching to app B', async () => {
  const lists: Array<{ app: string; resolve(items: AppPermission[]): void }> = [];
  const backend = {
    list: (app: string) => new Promise<AppPermission[]>((resolve) => lists.push({ app, resolve })),
    write: async () => [] as AppPermission[],
    reset: async () => [] as AppPermission[],
  };
  let value!: ReturnType<typeof useAppPermissions>;
  function Permissions({ app }: { app: string }) {
    const session = useFeatureSession('device');
    value = useAppPermissions({
      active: true,
      backend,
      appId: app,
      readState: session.read('permissions'),
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Permissions app="a" />);
  });
  await act(async () => renderer!.update(<Permissions app="b" />));
  await act(async () => lists[0]!.resolve([{ id: 'camera', label: 'Camera', state: 'granted' }]));
  expect(value.permissions).toBeNull();
  await act(async () => lists[1]!.resolve([{ id: 'camera', label: 'Camera', state: 'denied' }]));
  expect(value.permissionsAppId).toBe('b');
  expect(value.permissions?.[0]?.state).toBe('denied');
});

test('automatic recovery stops after a bounded number of failures and refresh starts a new attempt', () => {
  const session = new FeatureSession();
  const read = session.read('settings');
  read.ready();
  expect(read.fail(new Error('offline'), true)).toBe(true);
  expect(read.status).toBe('reconnecting');
  expect(read.loaded).toBe(true);
  read.fail(new Error('offline'), true);
  expect(read.fail(new Error('offline'), true)).toBe(false);
  expect(read.status).toBe('error');
  let attempts = 0;
  read.bind(() => {
    attempts++;
  });
  read.refresh();
  expect(attempts).toBe(1);
  expect(read.status).toBe('loading');
  read.ready();
  expect(read.error).toBeNull();
});

test('an open metrics subscription that never samples becomes a retryable error', async () => {
  const timers: Array<() => void> = [];
  stubGlobal('setInterval', (callback: () => void) => {
    timers.push(callback);
    return timers.length;
  });
  stubGlobal('clearInterval', () => {});
  await mount();
  await respond('/api', {});
  await act(async () => client.activity.attach());
  const source = Events.instances.find((event) => event.url.includes('/api/metrics'))!;
  await act(async () => source.onopen?.());
  expect(client.activity.status).toBe('ready');
  const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 9_000);
  try {
    await act(async () => timers.forEach((callback) => callback()));
    expect(client.activity.status).toBe('error');
    expect(client.activity.error).toMatchObject({ code: 'timeout', retryable: true });
    await act(async () => client.activity.refresh());
    expect(client.activity.status).toBe('loading');
    expect(Events.instances.filter((event) => event.url.includes('/api/metrics'))).toHaveLength(2);
  } finally {
    now.mockRestore();
  }
});

test('telemetry retains history on detach but clears it when its device changes', async () => {
  const connection: WebRtcStatsConnection = {
    sessionId: 'session',
    peerConnection: {
      getStats: async () =>
        new Map([
          [
            'video',
            {
              type: 'inbound-rtp',
              kind: 'video',
              bytesReceived: 100,
              framesDecoded: 1,
            },
          ],
        ]),
    } as unknown as RTCPeerConnection,
  };
  const frames = { current: 1 };
  let stats: DeviceStreamStats | null = null;
  function StatsHarness({ device, enabled }: { device: string; enabled: boolean }) {
    stats = useWebRtcStreamStats(connection, `https://hub.test/${device}/stats`, frames, enabled);
    return null;
  }
  await act(async () => {
    renderer = create(<StatsHarness device="a" enabled />);
  });
  expect(stats!.samples).toHaveLength(1);
  await act(async () => renderer!.update(<StatsHarness device="a" enabled={false} />));
  expect(stats!.samples).toHaveLength(1);
  await act(async () => renderer!.update(<StatsHarness device="b" enabled />));
  expect(stats!.samples).toHaveLength(1);
});
