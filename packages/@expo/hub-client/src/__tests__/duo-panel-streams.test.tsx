import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AVCC_FRAME_TIMEOUT_MS } from '../avcc-fallback';
import { DuoPanelStreams } from '../duo/DuoPanelStreams';
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
