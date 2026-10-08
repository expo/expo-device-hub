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
  /** Stats reads wait until the test answers them. */
  pendingStats: ((stats: Map<string, object>) => void)[] = [];
  getStats() {
    return new Promise<Map<string, object>>((resolve) => this.pendingStats.push(resolve));
  }
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

test('a first-frame verdict read while the panel goes inactive is dropped, and the deadline arms again', async () => {
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
  const stallDeadlines = () =>
    [...timers.entries()].filter(([, timer]) => timer.delay === FIRST_FRAME_TIMEOUT_MS);

  let failure: unknown = null;
  function Harness({ judgeStalls }: { judgeStalls: boolean }) {
    failure = useWebRtcStream({
      offerUrl: 'https://hub.test/helper/duo/panel/3/webrtc/offer',
      closeUrl: 'https://hub.test/helper/duo/panel/3/webrtc/close',
      enabled: true,
      codec: 'h264',
      judgeStalls,
    }).failure;
    return null;
  }
  await act(async () => {
    renderer = create(<Harness judgeStalls />);
  });
  await act(async () => {});
  const peer = Peer.instances[0]!;
  await act(async () => peer.deliver());
  const [armed] = stallDeadlines();
  expect(armed).toBeDefined();
  const [id, deadline] = armed!;
  // The shown panel's deadline fires and reads the peer's stats.
  await act(async () => {
    timers.delete(id);
    deadline.fn();
  });
  expect(peer.pendingStats).toHaveLength(1);
  // The device folds to the other display before the read returns no frames.
  await act(async () => renderer!.update(<Harness judgeStalls={false} />));
  await act(async () => peer.pendingStats[0]!(new Map()));
  expect(failure).toBeNull();
  // Shown again, the panel gets a fresh deadline on the same connection.
  await act(async () => renderer!.update(<Harness judgeStalls />));
  expect(stallDeadlines()).toHaveLength(1);
  expect(Peer.instances).toHaveLength(1);
});

test('a hidden tab suspends the first-frame deadline and discards a verdict already being read', async () => {
  const timers = new Map<number, { delay: number; fn: () => void }>();
  let nextTimer = 1;
  const listeners = new Map<string, () => void>();
  const page = {
    visibilityState: 'hidden',
    addEventListener: (type: string, fn: () => void) => {
      listeners.set(type, fn);
    },
    removeEventListener: (type: string) => {
      listeners.delete(type);
    },
  };
  stubGlobal('document', page);
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
  let failure: unknown = null;
  function Harness() {
    failure = useWebRtcStream({
      offerUrl: 'https://hub.test/offer',
      closeUrl: 'https://hub.test/close',
      enabled: true,
      codec: 'h264',
    }).failure;
    return null;
  }
  const deadlines = () =>
    [...timers.entries()].filter(([, timer]) => timer.delay === FIRST_FRAME_TIMEOUT_MS);
  await act(async () => {
    renderer = create(<Harness />);
  });
  const peer = Peer.instances[0]!;
  await act(async () => peer.deliver());
  expect(deadlines()).toHaveLength(0);
  await act(async () => {
    page.visibilityState = 'visible';
    listeners.get('visibilitychange')?.();
  });
  expect(deadlines()).toHaveLength(1);
  const [id, timer] = deadlines()[0]!;
  await act(async () => {
    timers.delete(id);
    timer.fn();
  });
  expect(peer.pendingStats).toHaveLength(1);
  await act(async () => {
    page.visibilityState = 'hidden';
    listeners.get('visibilitychange')?.();
  });
  await act(async () => peer.pendingStats[0]!(new Map()));
  expect(failure).toBeNull();
  await act(async () => {
    page.visibilityState = 'visible';
    listeners.get('visibilitychange')?.();
  });
  expect(deadlines()).toHaveLength(1);
});

test('playback stalls reconnect the same codec once before a repeated receiving stall falls back', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let now = 10_000;
  stubGlobal(
    'performance',
    new Proxy(performance, {
      get: (target, key) => {
        if (key === 'now') return () => now;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  );
  stubGlobal('window', {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  const polls = new Map<number, () => void>();
  let timerId = 0;
  stubGlobal('setInterval', (fn: () => void) => {
    const id = ++timerId;
    polls.set(id, fn);
    return id;
  });
  stubGlobal('clearInterval', (id: number) => {
    polls.delete(id);
  });
  class PlayingPeer extends Peer {
    received = 20;
    async getStats() {
      return new Map([
        [
          'video',
          {
            id: 'video',
            type: 'inbound-rtp',
            kind: 'video',
            framesReceived: this.received++,
            framesDecoded: 1,
          },
        ],
      ]);
    }
  }
  stubGlobal('RTCPeerConnection', PlayingPeer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('fetch', async () => Response.json({ type: 'answer', sdp: 'answer' }));
  let stream: ReturnType<typeof useWebRtcStream>;
  function Harness() {
    stream = useWebRtcStream({
      offerUrl: 'https://hub.test/offer',
      closeUrl: 'https://hub.test/close',
      enabled: true,
      codec: 'h264',
    });
    return null;
  }
  const stall = async () => {
    for (let tick = 0; tick < 9; tick++) {
      now += 1_000;
      await act(async () => {
        for (const poll of polls.values()) poll();
      });
    }
  };
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    Peer.instances[0]!.deliver();
    stream!.markFrameDecoded();
  });
  await stall();
  expect(stream!.failure).toBeNull();
  expect(stream!.error).toContain('playback stalled');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
  expect(Peer.instances).toHaveLength(2);
  await act(async () => {
    Peer.instances[1]!.deliver();
    stream!.markFrameDecoded();
  });
  await stall();
  expect(stream!.failure?.kind).toBe('codec');
});
