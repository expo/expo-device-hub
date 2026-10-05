import { afterEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AVCC_FRAME_TIMEOUT_MS } from '../avcc-fallback';
import { DuoPanelStreams } from '../duo/DuoPanelStreams';
import { useMjpegPanel } from '../duo/useMjpegPanel';
import { type DuoPanelFeeds } from '../types';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function connect() {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  stubGlobal('createImageBitmap', async () => ({ width: 1398, height: 2034, close() {} }));
  const outputs: VideoDecoderInit['output'][] = [];
  stubGlobal(
    'VideoDecoder',
    class {
      state = 'configured';
      constructor({ output }: VideoDecoderInit) {
        outputs.push(output);
      }
      configure() {}
      close() {
        this.state = 'closed';
      }
    },
  );
  const deadlines = new Map<number, () => void>();
  let nextTimer = -1;
  const nativeTimeout = setTimeout;
  const nativeClearTimeout = clearTimeout;
  stubGlobal('setTimeout', (callback: () => void, ms: number) => {
    if (ms !== AVCC_FRAME_TIMEOUT_MS) return nativeTimeout(callback, ms);
    const id = nextTimer--;
    deadlines.set(id, callback);
    return id;
  });
  stubGlobal('clearTimeout', (id: ReturnType<typeof setTimeout>) => {
    if (!deadlines.delete(Number(id))) nativeClearTimeout(id);
  });
  stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // A JPEG seed followed by an avcC description; no H.264 output yet.
            controller.enqueue(new Uint8Array([0, 0, 0, 2, 4, 255, 0, 0, 0, 5, 1, 1, 66, 0, 30]));
          },
        }),
      ),
  );
  const events = { frames: 0, fallbacks: 0, streaming: false };
  const feeds: DuoPanelFeeds = {
    url: 'https://hub.test/helper/duo',
    mode: 'avcc',
    codec: 'h264',
    onFrame: () => events.frames++,
    onStreamingChange: (streaming) => {
      events.streaming = streaming;
    },
    onStreamError() {},
    onAvccError: () => events.fallbacks++,
    onWebRtcFailure() {},
  };
  await act(async () => {
    renderer = create(<DuoPanelStreams activeScreenId={1} feeds={feeds} />, {
      createNodeMock: (element) =>
        element.type === 'canvas'
          ? {
              width: 300,
              height: 150,
              getContext: () => ({ drawImage() {} }),
            }
          : null,
    });
  });
  expect(events.frames).toBe(1);
  expect(events.streaming).toBe(true);
  expect(deadlines.size).toBe(1);
  return {
    events,
    decode: (panelIndex: number) =>
      act(async () =>
        outputs[panelIndex]!({
          displayWidth: 1398,
          displayHeight: 2034,
          close() {},
        } as VideoFrame),
      ),
    expire: () =>
      act(async () => {
        for (const callback of deadlines.values()) callback();
      }),
    update: (activeScreenId: 1 | 3, url = feeds.url) =>
      act(async () => {
        renderer!.update(
          <DuoPanelStreams activeScreenId={activeScreenId} feeds={{ ...feeds, url }} />,
        );
      }),
  };
}

test('a JPEG seed stays visible but cannot satisfy the H.264 startup watchdog', async () => {
  const { events, expire } = await connect();
  await expire();
  expect(events.fallbacks).toBe(1);
});

test('an actual H.264 frame satisfies the startup watchdog', async () => {
  const { events, decode, expire } = await connect();
  await decode(0);
  await expire();
  expect(events.fallbacks).toBe(0);
});

test('a seeded inactive panel still needs H.264 output after a handoff', async () => {
  const { events, decode, expire, update } = await connect();
  await decode(0);
  await expire();
  expect(events.fallbacks).toBe(0);
  await update(3);
  await expire();
  expect(events.fallbacks).toBe(1);
});

test('a new feed must decode H.264 even when the previous feed succeeded', async () => {
  const { events, decode, expire, update } = await connect();
  await decode(0);
  await update(1, 'https://hub.test/helper/other-duo');
  await expire();
  expect(events.fallbacks).toBe(1);
});

/** A `<video>` whose events the test fires; it never runs frame callbacks, like a hidden tab. */
class FakeVideo {
  srcObject: unknown = null;
  listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  removeEventListener(type: string) {
    this.listeners.delete(type);
  }
  async play() {}
  fire(type: string) {
    this.listeners.get(type)?.();
  }
}

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
}

test("a WebRTC panel's first loaded frame counts without frame callbacks, as in serve-sim", async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('RTCPeerConnection', Peer);
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('fetch', async () => Response.json({ type: 'answer', sdp: 'answer' }));
  Peer.instances = [];
  const videos: FakeVideo[] = [];
  const events = { frames: 0, streaming: false };
  const feeds: DuoPanelFeeds = {
    url: 'https://hub.test/helper/duo',
    mode: 'webrtc',
    codec: 'h264',
    onFrame: () => events.frames++,
    onStreamingChange: (streaming) => {
      events.streaming = streaming;
    },
    onStreamError() {},
    onAvccError() {},
    onWebRtcFailure() {},
  };
  await act(async () => {
    renderer = create(<DuoPanelStreams activeScreenId={1} feeds={feeds} />, {
      createNodeMock: (element) => {
        if (element.type !== 'video') return null;
        const video = new FakeVideo();
        videos.push(video);
        return video;
      },
    });
  });
  await act(async () => {});
  for (const peer of Peer.instances) {
    await act(async () => {
      peer.onconnectionstatechange?.();
      peer.ontrack?.({ streams: [{}], track: {} });
    });
  }
  expect(events.streaming).toBe(false);
  // Panel 1 is shown; its first frame loads while frame callbacks stay quiet.
  await act(async () => videos[0]!.fire('loadeddata'));
  expect(events.streaming).toBe(true);
  expect(events.frames).toBe(1);
});

test('stopping an MJPEG panel mid-decode revokes the frame it was decoding', async () => {
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const created: string[] = [];
  const revoked: string[] = [];
  stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL() {
        const url = `blob:frame-${created.length}`;
        created.push(url);
        return url;
      }
      static revokeObjectURL(url: string) {
        revoked.push(url);
      }
    },
  );
  const jpeg = [0xff, 0xd8, 0xff, 0xd9];
  const part = new Uint8Array([
    ...new TextEncoder().encode(
      `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
    ),
    ...jpeg,
  ]);
  stubGlobal(
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(part);
          },
        }),
      ),
  );
  // The <img> never finishes decoding the frame before the panel stops.
  const img = {
    src: '',
    onload: null,
    onerror: null,
    removeAttribute(name: string) {
      if (name === 'src') this.src = '';
    },
  };
  function Harness({ url }: { url: string | null }) {
    const ref = useRef(img as unknown as HTMLImageElement);
    useMjpegPanel(url, ref);
    return null;
  }
  await act(async () => {
    renderer = create(<Harness url="https://hub.test/helper/duo/panel/1/stream.mjpeg" />);
  });
  await act(async () => {});
  expect(img.src).toBe('blob:frame-0');
  await act(async () => renderer!.update(<Harness url={null} />));
  expect(img.src).toBe('');
  expect(revoked).toEqual(['blob:frame-0']);
});
