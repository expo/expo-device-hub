import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { androidStreamSettingsPatch, parseAndroidStreamSettings } from '../android-stream-settings';
import { deviceScreenPresentsMedia } from '../DeviceScreen';
import { useAndroidDeviceClient } from '../useAndroidDevice';
import { useStreamSettingsResource } from '../useStreamSettingsResource';
import { useWebRtcStream } from '../useWebRtcStream';
import { PLAYBACK_STALL_POLLS, PLAYBACK_STALL_POLL_MS } from '../webrtc-playback-stall';
import { createGlobalStubs } from './test-globals';

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
  beforeClose?: () => void;
  receivedTrack?: { onended?: () => void };
  receivedFrames = 0;
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
  async getStats() {
    this.receivedFrames += 100;
    return new Map([['video', {
      id: 'video', type: 'inbound-rtp', kind: 'video',
      framesReceived: this.receivedFrames, framesDecoded: 10,
    }]]);
  }
  close() {
    this.beforeClose?.();
    this.closeCount++;
  }
  receive(stream: object) {
    this.receivedTrack = {};
    this.ontrack?.({ streams: [stream], track: this.receivedTrack });
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  Peer.instances = [];
  ControlSocket.instances = [];
});

// The bearer header covers every close POST, so only the unload beacon carries `?token=`.
test('closes with the plain URL, and puts the token URL only on the unload beacon', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  const beaconUrls: string[] = [];
  stubGlobal('navigator', {
    sendBeacon: (url: string) => {
      beaconUrls.push(url);
      return true;
    },
  });
  const closeRequests: string[] = [];
  let offerStatus = 400;
  stubGlobal('fetch', async (url: string) => {
    if (url.includes('/close')) closeRequests.push(url);
    return Response.json({ type: 'answer', sdp: 'answer' }, { status: url.endsWith('/offer') ? offerStatus : 200 });
  });

  function Harness() {
    useWebRtcStream({
      offerUrl: 'https://hub.test/webrtc/offer',
      closeUrl: 'https://hub.test/webrtc/close',
      closeBeaconUrl: 'https://hub.test/webrtc/close?token=tok-1',
      enabled: true,
      codec: 'h264',
      allowCodecFallback: false,
    });
    return null;
  }

  // A refused offer fails the session for good, which closes it with a POST.
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(closeRequests).toEqual(['https://hub.test/webrtc/close']);
  await act(async () => renderer?.unmount());
  expect(beaconUrls).toEqual([]);

  // Leaving the page closes a live session with the beacon.
  offerStatus = 200;
  closeRequests.length = 0;
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(beaconUrls).toEqual(['https://hub.test/webrtc/close?token=tok-1']);
  expect(closeRequests).toEqual([]);
});

test('a known server restart replaces a still-connected peer without waiting for ICE failure', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
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
    expect(settings!.updateStreamSettings({ mjpegFps: 30 })).toBeUndefined();
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

async function androidHarness({
  delaySource = false,
  captureThrows = false,
  canvasContextUnavailable = false,
  canvasImage = 'data:image/png;base64,last-frame',
} = {}) {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const intervals = new Map<number, { callback: () => void; delay: number }>();
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
  stubGlobal('setInterval', (callback: () => void, delay: number) => {
    intervals.set(++timerId, { callback, delay });
    return timerId;
  });
  stubGlobal('clearInterval', (id: number) => intervals.delete(id));
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
      getContext: () => canvasContextUnavailable
        ? null
        : { drawImage: (video: Video) => captures.push(video) },
      toDataURL: () => {
        if (captureThrows) throw new Error('Canvas snapshot failed');
        return canvasImage;
      },
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
  const writes: { path: string; body: unknown; finish: (response: Response) => void }[] = [];
  const closedSessions: string[] = [];
  let finishSource!: (response: Response) => void;
  const sourceRead = new Promise<Response>((resolve) => {
    finishSource = resolve;
  });
  stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/webrtc/close') closedSessions.push(String(init?.body));
    if (init?.method === 'PATCH' || init?.method === 'PUT') {
      return new Promise<Response>((finish) => {
        writes.push({ path, body: JSON.parse(String(init.body)), finish });
      });
    }
    if (path === '/api/stream-settings') {
      return Response.json({ maxDimension: 1280, h264Fps: 60, h264Bitrate: 6_000_000 });
    }
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
    closedSessions,
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
    stallPlayback: async () => {
      for (let sample = 0; sample <= PLAYBACK_STALL_POLLS; sample++) {
        await act(async () => {
          for (const interval of intervals.values()) {
            if (interval.delay === PLAYBACK_STALL_POLL_MS) interval.callback();
          }
          for (let turn = 0; turn < 20; turn++) await Promise.resolve();
        });
      }
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
    paintReplacement: async (target = video) => {
      await act(async () => Peer.instances.at(-1)!.receive({ id: 'replacement' }));
      await act(async () => target.paint());
    },
  };
}

test('Android automatic stall recovery captures before closing and keeps its poster until fresh paint', async () => {
  const hub = await androidHarness();
  const peer = Peer.instances[0]!;
  const postersAtClose: string[] = [];
  peer.beforeClose = () => postersAtClose.push(hub.video.poster);
  await hub.stallPlayback();
  expect(peer.closeCount).toBe(1);
  expect(hub.captures).toEqual([hub.video]);
  expect(postersAtClose).toEqual(['data:image/png;base64,last-frame']);
  expect(hub.video.poster).toContain('data:image/png');
  await hub.fireTimer(500);
  expect(Peer.instances).toHaveLength(2);
  expect(peer.closeCount).toBe(1);
  expect(hub.captures).toEqual([hub.video]);
  expect(hub.video.poster).toContain('data:image/png');
  await hub.paintReplacement();
  expect(hub.client.status).toBe('streaming');
  expect(hub.video.poster).toBe('');
});

test('repeated Android restarts keep a saved poster without capturing a detached stream', async () => {
  const hub = await androidHarness();
  await act(async () => hub.client.updateStreamSettings({ maxDimension: 720 }));
  await hub.finishWrite({ maxDimension: 720 });
  const retainedPoster = hub.video.poster;
  expect(retainedPoster).toContain('data:image/png');
  expect(hub.captures).toEqual([hub.video]);
  await act(async () => ControlSocket.instances[0]!.serverClose(1012));
  expect(Peer.instances).toHaveLength(3);
  expect(hub.captures).toEqual([hub.video]);
  expect(hub.video.poster).toBe(retainedPoster);
});

test('a retry before replacement paint detaches that stream while retaining the original poster', async () => {
  const hub = await androidHarness();
  await hub.stallPlayback();
  const retainedPoster = hub.video.poster;
  await hub.fireTimer(500);
  const replacementPeer = Peer.instances[1]!;
  await act(async () => replacementPeer.receive({ id: 'not-yet-painted' }));
  expect(hub.video.srcObject).toEqual({ id: 'not-yet-painted' });
  await act(async () => replacementPeer.receivedTrack!.onended!());
  expect(replacementPeer.closeCount).toBe(1);
  expect(hub.video.srcObject).toBeNull();
  expect(hub.captures).toEqual([hub.video]);
  expect(hub.video.poster).toBe(retainedPoster);
});

test('automatic Android recovery captures the remounted video without replacing its peer or control socket early', async () => {
  const hub = await androidHarness();
  const remounted = new Video();
  await hub.attach(remounted);
  await act(async () => remounted.paint());
  expect(Peer.instances).toHaveLength(1);
  expect(ControlSocket.instances).toHaveLength(1);
  await hub.stallPlayback();
  expect(hub.captures).toEqual([remounted]);
  expect(hub.video.poster).toBe('');
  expect(remounted.poster).toContain('data:image/png');
  await hub.fireTimer(500);
  await hub.paintReplacement(remounted);
  expect(remounted.poster).toBe('');
  expect(hub.client.status).toBe('streaming');
});

for (const failure of ['throws', 'no-context', 'no-dimensions', 'empty-image'] as const) {
  test(`Android snapshot ${failure} keeps the old attachment while releasing the peer and session`, async () => {
    const hub = await androidHarness({
      captureThrows: failure === 'throws',
      canvasContextUnavailable: failure === 'no-context',
      canvasImage: failure === 'empty-image' ? 'data:,' : undefined,
    });
    if (failure === 'no-dimensions') hub.video.videoWidth = 0;
    const peer = Peer.instances[0]!;
    const previousStream = hub.video.srcObject;
    await hub.stallPlayback();
    expect(hub.video.srcObject).toBe(previousStream);
    expect(hub.video.poster).toBe('');
    expect(peer.closeCount).toBe(1);
    expect(hub.closedSessions).toHaveLength(1);
    await hub.fireTimer(500);
    expect(Peer.instances).toHaveLength(2);
    expect(peer.closeCount).toBe(1);
    expect(hub.closedSessions).toHaveLength(1);
    expect(hub.video.srcObject).toBe(previousStream);
    await hub.paintReplacement();
    expect(hub.video.srcObject).not.toBe(previousStream);
    expect(hub.client.status).toBe('streaming');
  });
}

test('peer cleanup uses the latest pre-disconnect callback without restarting for callback changes', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('fetch', async () => Response.json({ type: 'answer', sdp: 'answer' }));
  const disconnects: string[] = [];
  let client!: ReturnType<typeof useWebRtcStream>;
  function Harness({ beforeDisconnect }: { beforeDisconnect: () => void }) {
    client = useWebRtcStream({
      offerUrl: 'https://hub.test/webrtc/offer', closeUrl: 'https://hub.test/webrtc/close',
      enabled: true, codec: 'h264', onBeforeDisconnect: beforeDisconnect,
    });
    return null;
  }
  await act(async () => { renderer = create(<Harness beforeDisconnect={() => disconnects.push('old')} />); });
  const peer = Peer.instances[0]!;
  await act(async () => renderer!.update(<Harness beforeDisconnect={() => {
    expect(peer.closeCount).toBe(0);
    disconnects.push('latest');
  }} />));
  expect(Peer.instances).toHaveLength(1);
  expect(disconnects).toEqual([]);
  await act(async () => client.restart());
  expect(Peer.instances).toHaveLength(2);
  expect(peer.closeCount).toBe(1);
  expect(disconnects).toEqual(['latest']);
  await act(async () => renderer!.update(<Harness beforeDisconnect={() => {
    disconnects.push('unmount');
    throw new Error('Snapshot failed');
  }} />));
  const replacementPeer = Peer.instances[1]!;
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(replacementPeer.closeCount).toBe(1);
  expect(disconnects).toEqual(['latest', 'unmount']);
});

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

for (const patch of [{ h264Fps: 24 }, { h264Bitrate: 8_000_000 }]) {
  for (const success of [true, false]) {
    test(`Android ${Object.keys(patch)[0]} changes ${success ? 'restart after commit' : 'roll back on failure'}`, async () => {
      const hub = await androidHarness();
      expect(hub.client.capabilities.streamSettings).toMatchObject({
        h264Fps: true,
        h264Bitrate: true,
      });
      const previous = hub.client.streamSettings;
      await act(async () => hub.client.updateStreamSettings(patch));
      expect(hub.writes).toHaveLength(1);
      expect(hub.writes[0]).toMatchObject({ path: '/api/stream-settings', body: patch });
      expect(hub.client.streamSettingsPending).toBe(true);
      expect(Peer.instances).toHaveLength(1);
      await hub.finishWrite({ ...previous, ...patch }, success ? 200 : 503);
      if (success) {
        expect(Peer.instances).toHaveLength(2);
        expect(hub.client.streamSettings).toMatchObject(patch);
        await hub.paintReplacement();
      } else {
        expect(Peer.instances).toHaveLength(1);
        expect(hub.client.streamSettings).toEqual(previous);
      }
      expect(hub.client.status).toBe('streaming');
      expect(hub.client.streamSettingsPending).toBe(false);
    });
  }
}

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
    if (outcome === 'superseded') {
      expect(hub.video.srcObject).toBeNull();
      expect(hub.video.poster).toBe('');
    }
    await hub.finishWrite({ maxDimension: 720 }, outcome === 'failure' ? 503 : 200);
    expect(Peer.instances).toHaveLength(peersBeforeResponse);
    expect(hub.captures).toHaveLength(0);
    expect(hub.client.streamSettingsPending).toBe(false);
    expect(hub.client.streamSourcePending).toBe(false);
    expect(hub.client.streamSettings?.maxDimension).toBe(1280);
    if (outcome === 'failure') expect(hub.client.status).toBe('streaming');
  });
}
