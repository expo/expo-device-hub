import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { androidStreamSettingsPatch, parseAndroidStreamSettings } from '../android-stream-settings';
import { useStreamSettingsResource } from '../useStreamSettingsResource';
import { useWebRtcStream } from '../useWebRtcStream';

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
