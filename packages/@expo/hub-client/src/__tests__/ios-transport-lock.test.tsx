import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useIosDeviceClient } from '../useIosDevice.js';
import { createGlobalStubs } from './test-globals.js';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; restoreGlobals(); });

test('an advertised WebRTC session never starts HTTP when the requested mode or offer fails', async () => {
  const requests: string[] = [];
  stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  stubGlobal('window', { location: { href: 'https://app.test/', protocol: 'https:', host: 'app.test' }, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout });
  stubGlobal('document', { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal('WebSocket', class { readyState = 0; close() {} send() {} });
  stubGlobal('RTCRtpReceiver', { getCapabilities: () => null });
  stubGlobal('RTCPeerConnection', class {
    iceGatheringState = 'complete'; localDescription = { type: 'offer', sdp: 'offer' };
    addTransceiver() { return {}; } async createOffer() { return this.localDescription; }
    async setLocalDescription() {} close() {}
  });
  stubGlobal('fetch', async (url: string) => {
    requests.push(String(url));
    if (String(url).endsWith('/api')) return Response.json({ url: 'https://sim.test/helper/A', device: 'A', basePath: '', proxyHelpers: true, streamSettings: { transport: 'webrtc', codec: 'h264' } });
    if (String(url).endsWith('/webrtc/offer')) return new Response(null, { status: 401 });
    return Response.json({ devices: [] });
  });
  let client!: ReturnType<typeof useIosDeviceClient>;
  function Harness() { client = useIosDeviceClient({ baseUrl: 'https://sim.test', streamMode: 'h264' }); return null; }
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(requests.some(url => url.endsWith('/webrtc/offer'))).toBe(true);
  expect(requests.some(url => /stream\.(avcc|mjpeg)/.test(url))).toBe(false);
  expect(client.videoKind).toBe('video');
  expect(client.status).toBe('error');
  expect(client.error).toContain('401');
});
