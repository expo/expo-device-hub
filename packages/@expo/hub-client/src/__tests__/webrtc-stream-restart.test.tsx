import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { androidStreamSettingsPatch, parseAndroidStreamSettings } from '../android-stream-settings';
import { deviceScreenPresentsMedia } from '../DeviceScreen';
import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useStreamSettingsResource } from '../useStreamSettingsResource';
import { useWebRtcStream } from '../useWebRtcStream';

// These tests exercise hook lifecycles with controlled transport/media events.
// react-test-renderer keeps them in the existing Bun runner without adding a
// browser DOM environment. Its deprecation warning is intentionally not hidden;
// actual decoding and presentation are also checked in the browser recording.

class Peer {
  static instances: Peer[] = [];
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription = { type: 'offer', sdp: 'offer' };
  closeCount = 0;
  ontrack?: (event: { streams: object[]; track: object }) => void;

  constructor() {
    Peer.instances.push(this);
  }
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return this.localDescription;
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() {
    this.closeCount++;
  }
  receive(stream: object) {
    this.ontrack?.({ streams: [stream], track: {} });
  }
}

const originals = new Map<string, PropertyDescriptor | undefined>();
function stubGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  Peer.instances = [];
  ControlSocket.instances = [];
});

test('a known server restart replaces a still-connected peer without waiting for ICE failure', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  const requests: string[] = [];
  stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return Response.json({ type: 'answer', sdp: 'answer' });
  });

  let client: ReturnType<typeof useWebRtcStream>;
  function Harness() {
    client = useWebRtcStream({
      offerUrl: 'https://hub.test/webrtc/offer',
      closeUrl: 'https://hub.test/webrtc/close',
      enabled: true,
      codec: 'h264',
      allowCodecFallback: false,
    });
    return null;
  }

  await act(async () => {
    renderer = create(<Harness />);
  });
  const previousPeer = Peer.instances[0]!;
  const previousStream = { id: 'previous' };
  await act(async () => previousPeer.receive(previousStream));
  await act(async () => client!.markFrameDecoded());
  expect<object | null>(client!.stream).toBe(previousStream);

  // serve-emu closes its control socket before the browser notices the dead
  // video peer. Restart without emitting any connectionstatechange event.
  await act(async () => client!.restart());
  expect(Peer.instances).toHaveLength(2);
  expect(previousPeer.closeCount).toBe(1);
  expect(requests.filter((url) => url.endsWith('/offer'))).toHaveLength(2);
  expect(requests.filter((url) => url.endsWith('/close'))).toHaveLength(1);
  expect(client!.stream).toBeNull();

  await act(async () => previousPeer.receive(previousStream));
  expect(client!.stream).toBeNull();
  const replacementStream = { id: 'replacement' };
  await act(async () => Peer.instances[1]!.receive(replacementStream));
  await act(async () => client!.markFrameDecoded());
  expect<object | null>(client!.stream).toBe(replacementStream);
  expect(client!.error).toBeNull();
});

for (const outcome of ['success', 'failure', 'superseded'] as const) {
  test(`encoder writes report ${outcome} so only committed settings restart WebRTC`, async () => {
    stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finishWrite!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finishWrite = resolve;
    });
    stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? response : Response.json({ maxDimension: 1280 }),
    );
    let settings: ReturnType<typeof useStreamSettingsResource>;
    function Harness({ url = 'https://hub.test/stream-settings' }: { url?: string | null }) {
      settings = useStreamSettingsResource({
        url,
        initialSettings: null,
        parse: parseAndroidStreamSettings,
        toPatch: androidStreamSettingsPatch,
      });
      return null;
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(settings!.updateStreamSettings({ h264Fps: 30 })).toBeUndefined();
    let write: Promise<boolean> | undefined;
    await act(async () => {
      write = settings!.updateStreamSettings({ maxDimension: 720 });
    });
    expect(settings!.streamSettingsPending).toBe(true);
    if (outcome === 'superseded') {
      await act(async () => renderer!.update(<Harness url={null} />));
    }
    await act(async () => {
      finishWrite(Response.json({ maxDimension: 720 }, { status: outcome === 'failure' ? 503 : 200 }));
      expect(await write).toBe(outcome === 'success');
    });
    expect(settings!.streamSettingsPending).toBe(false);
    expect(settings!.streamSettings?.maxDimension ?? null).toBe(
      outcome === 'success' ? 720 : outcome === 'failure' ? 1280 : null,
    );
  });
}

class ControlSocket {
  static OPEN = 1;
  static instances: ControlSocket[] = [];
  readyState = 0;
  closeCount = 0;
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;

  constructor(readonly url: string) {
    ControlSocket.instances.push(this);
  }
  send() {}
  open() {
    this.readyState = ControlSocket.OPEN;
    this.onopen?.();
  }
  close() {
    this.closeCount++;
    this.serverClose(1000);
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

class Video extends EventTarget {
  tagName = 'VIDEO';
  readyState = 2;
  videoWidth = 360;
  videoHeight = 720;
  srcObject: object | null = null;
  poster = '';
  async play() {}
  removeAttribute(name: string) {
    if (name === 'poster') this.poster = '';
  }
  paint() {
    this.dispatchEvent(new Event('loadeddata'));
  }
}

async function androidHarness({ delaySource = false } = {}) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const schedule = (callback: () => void, delay: number) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  const cancel = (id: number) => {
    timers.delete(id);
  };
  stubGlobal('setTimeout', schedule);
  stubGlobal('clearTimeout', cancel);
  stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: schedule,
    clearTimeout: cancel,
  });
  const captures: Video[] = [];
  stubGlobal('document', {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      getContext: () => ({ drawImage: (video: Video) => captures.push(video) }),
      toDataURL: () => 'data:image/png;base64,last-frame',
    }),
  });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('WebSocket', ControlSocket);
  const source = {
    ok: true,
    mode: 'scrcpy',
    grpcImageMode: 'mmap',
    inputSource: 'scrcpy',
    availableModes: ['scrcpy', 'grpc-screenshot'],
    availableInputSources: ['scrcpy', 'grpc'],
    sessionGeneration: 1,
  };
  const writes: { path: string; finish: (response: Response) => void }[] = [];
  let finishSource!: (response: Response) => void;
  const sourceRead = new Promise<Response>((resolve) => {
    finishSource = resolve;
  });
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === 'PATCH' || init?.method === 'PUT') {
      return new Promise<Response>((finish) => {
        writes.push({ path, finish });
      });
    }
    if (path === '/api/stream-settings') return Response.json({ maxDimension: 1280 });
    if (path === '/api/stream-mode') return delaySource ? sourceRead : Response.json(source);
    if (path === '/api') {
      return Response.json({
        stream: { transport: 'webrtc', codec: 'h264', iceServers: [], iceTransportPolicy: 'all' },
      });
    }
    if (path === '/webrtc/offer') return Response.json({ type: 'answer', sdp: 'answer' });
    return Response.json({}, { status: 404 });
  });
  let client!: ReturnType<typeof useAndroidDeviceClient>;
  function Harness({ device = 'emulator-test' }: { device?: string }) {
    client = useAndroidDeviceClient({ baseUrl: 'https://hub.test', device, streamMode: 'webrtc' });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attach = async (video: Video) => {
    await act(async () => client.attachVideo(video as unknown as HTMLVideoElement));
  };
  const video = new Video();
  await attach(video);
  await act(async () => {
    ControlSocket.instances.at(-1)!.open();
    Peer.instances.at(-1)!.receive({ id: 'initial' });
  });
  await act(async () => video.paint());
  expect(client.status).toBe('streaming');
  return {
    get client() {
      return client;
    },
    video,
    captures,
    writes,
    source,
    attach,
    finishSource: async () => {
      await act(async () => finishSource(Response.json(source)));
    },
    finishWrite: async (payload: object, status = 200) => {
      await act(async () => writes.at(-1)!.finish(Response.json(payload, { status })));
    },
    changeDevice: async () => {
      await act(async () => renderer!.update(<Harness device="another-emulator" />));
    },
    fireTimer: async (delay: number) => {
      const matching = [...timers].filter(([, timer]) => timer.delay === delay);
      expect(matching.length).toBeGreaterThan(0);
      await act(async () => {
        for (const [id, timer] of matching) {
          timers.delete(id);
          timer.callback();
        }
      });
    },
    paintReplacement: async () => {
      await act(async () => Peer.instances.at(-1)!.receive({ id: 'replacement' }));
      await act(async () => video.paint());
    },
  };
}

test('attaching and remounting the Android video keeps one control socket and uses the latest node', async () => {
  const hub = await androidHarness();
  expect(ControlSocket.instances).toHaveLength(1);
  const socket = ControlSocket.instances[0]!;
  const remounted = new Video();
  await hub.attach(remounted);
  await act(async () => remounted.paint());
  expect(ControlSocket.instances).toHaveLength(1);
  expect(socket.closeCount).toBe(0);
  await act(async () => socket.serverClose(1012));
  expect(Peer.instances).toHaveLength(2);
  expect(hub.captures).toEqual([remounted]);
  expect(hub.client.status).toBe('reconnecting');
});

test('Android settings wait for fresh video, preserve the poster past grace, and still time out', async () => {
  const hub = await androidHarness();
  await act(async () => hub.client.updateStreamSettings({ maxDimension: 720 }));
  expect(hub.client.status).toBe('reconnecting');
  expect(hub.client.streamSettingsPending).toBe(true);
  expect(Peer.instances).toHaveLength(1);
  await hub.finishWrite({ maxDimension: 720 });
  expect(Peer.instances).toHaveLength(2);
  expect(hub.video.poster).toContain('data:image/png');
  expect(hub.captures).toEqual([hub.video]);
  await hub.fireTimer(5000);
  expect(hub.client.status).toBe('reconnecting');
  expect(deviceScreenPresentsMedia(hub.client.status)).toBe(true);
  expect(hub.client.streamSettingsPending).toBe(true);
  await hub.fireTimer(8000);
  expect(hub.client.status).toBe('connecting');
  expect(hub.client.streamSettingsPending).toBe(false);
  await hub.paintReplacement();
  expect(hub.client.status).toBe('streaming');
  expect(hub.video.poster).toBe('');
});

test('Android source changes reject overlapping settings writes and wait for replacement frames', async () => {
  const hub = await androidHarness({ delaySource: true });
  await act(async () => hub.client.updateStreamSettings({ maxDimension: 720 }));
  expect(hub.writes).toHaveLength(0);
  await hub.finishSource();
  await act(async () => hub.client.setStreamSource('grpc-screenshot'));
  await act(async () => hub.client.updateStreamSettings({ maxDimension: 720 }));
  expect(hub.writes.map((write) => write.path)).toEqual(['/api/stream-mode']);
  await act(async () => ControlSocket.instances.at(-1)!.serverClose(1012));
  await hub.finishWrite({ ...hub.source, mode: 'grpc-screenshot', sessionGeneration: 2 });
  await hub.fireTimer(100);
  await act(async () => ControlSocket.instances.at(-1)!.open());
  expect(hub.client.status).toBe('reconnecting');
  expect(hub.client.streamSource?.mode).toBe('scrcpy');
  await hub.paintReplacement();
  expect(hub.client.status).toBe('streaming');
  expect(hub.client.streamSource?.mode).toBe('grpc-screenshot');
  expect(hub.client.streamSourcePending).toBe(false);
  expect(hub.client.streamSettingsPending).toBe(false);
  expect(hub.video.poster).toBe('');
});

for (const outcome of ['failure', 'superseded'] as const) {
  test(`Android ${outcome} settings writes do not restart the current peer`, async () => {
    const hub = await androidHarness();
    await act(async () => hub.client.updateStreamSettings({ maxDimension: 720 }));
    if (outcome === 'superseded') await hub.changeDevice();
    const peersBeforeResponse = Peer.instances.length;
    await hub.finishWrite({ maxDimension: 720 }, outcome === 'failure' ? 503 : 200);
    expect(Peer.instances).toHaveLength(peersBeforeResponse);
    expect(hub.captures).toHaveLength(0);
    expect(hub.client.streamSettingsPending).toBe(false);
    expect(hub.client.streamSourcePending).toBe(false);
    expect(hub.client.streamSettings?.maxDimension).toBe(1280);
    if (outcome === 'failure') expect(hub.client.status).toBe('streaming');
  });
}
