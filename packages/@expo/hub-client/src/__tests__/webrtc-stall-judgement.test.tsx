import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useWebRtcStream } from '../useWebRtcStream';
import { createGlobalStubs } from './test-globals';

const FIRST_FRAME_TIMEOUT_MS = 4_000;

class Peer {
  static instances: Peer[] = [];
  iceGatheringState = 'complete';
  connectionState = 'connected';
  localDescription = { type: 'offer', sdp: 'offer' };
  ontrack?: (event: { streams: object[]; track: object }) => void;
  onconnectionstatechange?: () => void;
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
  close() {}
  /** The server's video arrives and the connection reports connected. */
  deliver() {
    this.onconnectionstatechange?.();
    this.ontrack?.({ streams: [{}], track: {} });
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  Peer.instances = [];
});

test('an inactive Duo panel never judges a missing first frame, and judges once it is shown', async () => {
  const timers = new Map<number, { delay: number; fn: () => void }>();
  let nextTimer = 1;
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { delay, fn });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
  });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('fetch', async () => Response.json({ type: 'answer', sdp: 'answer' }));
  const stallDeadlines = () => [...timers.values()].filter((timer) => timer.delay === FIRST_FRAME_TIMEOUT_MS);

  function Harness({ judgeStalls }: { judgeStalls: boolean }) {
    useWebRtcStream({
      offerUrl: 'https://hub.test/helper/duo/panel/3/webrtc/offer',
      closeUrl: 'https://hub.test/helper/duo/panel/3/webrtc/close',
      enabled: true,
      codec: 'h264',
      judgeStalls,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness judgeStalls={false} />);
  });
  await act(async () => {});
  const peer = Peer.instances[0]!;
  await act(async () => peer.deliver());
  // Silence on the hidden panel is expected, so no first-frame deadline runs.
  expect(stallDeadlines()).toHaveLength(0);

  // The panel becomes the shown one: the deadline arms without a reconnect.
  await act(async () => renderer!.update(<Harness judgeStalls />));
  expect(stallDeadlines()).toHaveLength(1);
  expect(Peer.instances).toHaveLength(1);

  // Hidden again before the deadline fires: the pending verdict is dropped.
  await act(async () => renderer!.update(<Harness judgeStalls={false} />));
  expect(stallDeadlines()).toHaveLength(0);
});
