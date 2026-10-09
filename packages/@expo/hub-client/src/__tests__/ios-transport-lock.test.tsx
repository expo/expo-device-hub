import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useLayoutEffect } from 'react';
import { useIosDeviceClient } from '../useIosDevice';
import { createGlobalStubs } from './test-globals';

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; restoreGlobals(); });

function stubBrowser() {
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
}

test('an advertised WebRTC session never starts HTTP when the requested mode or offer fails', async () => {
  const requests: string[] = [];
  stubBrowser();
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

test('an HTTP fallback does not activate MJPEG after switching to a locked session', async () => {
  stubBrowser();
  const imageRequests: string[] = [];
  const offerRequests: string[] = [];
  const image = {
    naturalWidth: 0,
    naturalHeight: 0,
    set src(url: string) { imageRequests.push(url); },
    addEventListener() {},
    removeEventListener() {},
    removeAttribute() {},
  } as unknown as HTMLImageElement;
  stubGlobal('fetch', async (value: string | URL) => {
    const url = new URL(value);
    if (url.pathname === '/api') {
      const device = url.hostname === 'a.test' ? 'A' : 'B';
      return Response.json({
        url: `${url.origin}/helper/${device}`,
        device,
        basePath: '',
        streamSettings: { transport: device === 'A' ? 'http' : 'webrtc', codec: 'h264' },
      });
    }
    if (url.pathname.endsWith('/webrtc/offer')) {
      offerRequests.push(url.toString());
      return new Response(null, { status: 401 });
    }
    return Response.json({ devices: [] });
  });
  let client!: ReturnType<typeof useIosDeviceClient>;
  function Harness({ baseUrl }: { baseUrl: string }) {
    const current = useIosDeviceClient({ baseUrl, streamMode: 'webrtc' });
    client = current;
    const { attachVideo, videoKind } = current;
    useLayoutEffect(() => {
      attachVideo(videoKind === 'img' ? image : null);
    }, [attachVideo, videoKind]);
    return null;
  }
  await act(async () => { renderer = create(<Harness baseUrl="https://a.test" />); });
  expect(client.videoKind).toBe('img');
  expect(imageRequests.some(url => url.startsWith('https://a.test/'))).toBe(true);
  await act(async () => { renderer?.update(<Harness baseUrl="https://b.test" />); });
  expect(offerRequests.some(url => url.startsWith('https://b.test/'))).toBe(true);
  expect(imageRequests.some(url => url.startsWith('https://b.test/'))).toBe(false);
  expect(client.videoKind).toBe('video');
});
