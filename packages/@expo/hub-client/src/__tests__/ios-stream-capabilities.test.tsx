import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { iosStreamCapabilities, useIosDeviceClient } from '../useIosDevice.js';
import { type DeviceClient } from '../types.js';
import { createGlobalStubs } from './test-globals.js';

const { stubGlobal, restoreGlobals } = createGlobalStubs();

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

test('an HTTP serve-sim offers MJPEG and H.264 but not WebRTC', () => {
  for (const settings of [undefined, null, {}, { transport: 'http' }, { transport: 'http', codec: 'mjpeg' }]) {
    expect(iosStreamCapabilities(settings)).toEqual({
      modeAvailability: { mjpeg: true, h264: true, webrtc: false },
      httpCodecs: ['auto', 'h264', 'mjpeg'],
      webRtcCodecs: [],
    });
  }
});

test('a WebRTC serve-sim offers only WebRTC', () => {
  expect(iosStreamCapabilities({ transport: 'webrtc', codec: 'vp9' })).toEqual({
    modeAvailability: { mjpeg: false, h264: false, webrtc: true },
    httpCodecs: [],
    webRtcCodecs: ['h264', 'vp9', 'vp8'],
  });
});

for (const { transport, webrtc } of [
  { transport: undefined, webrtc: false },
  { transport: 'http', webrtc: false },
  { transport: 'webrtc', webrtc: true },
]) {
  test(`iOS client reports WebRTC=${webrtc} for /api transport ${transport ?? '(none)'}`, async () => {
    stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    stubGlobal('window', {
      location: { href: 'https://hub.test/' },
      addEventListener() {},
      removeEventListener() {},
      setTimeout,
      clearTimeout,
    });
    stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
    stubGlobal('WebSocket', Socket);
    stubGlobal('fetch', async (url: string) => {
      if (new URL(url).pathname === '/api') {
        return Response.json({
          url: 'https://hub.test/helper/device-1',
          device: 'device-1',
          ...(transport
            ? { streamSettings: transport === 'webrtc' ? { transport, codec: 'h264' } : { transport } }
            : {}),
        });
      }
      return Response.json({}, { status: 404 });
    });

    let client!: DeviceClient;
    function Harness() {
      client = useIosDeviceClient({ baseUrl: 'https://hub.test', device: 'device-1', streamMode: 'mjpeg' });
      return null;
    }
    await act(async () => {
      renderer = create(<Harness />);
    });
    expect(client.streamCapabilities?.modeAvailability).toEqual({
      mjpeg: !webrtc,
      h264: !webrtc,
      webrtc,
    });
  });
}
