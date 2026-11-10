import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const nativeTimeout = setTimeout;

class Peer {
  static instances: Peer[] = [];
  connectionState = "connected";
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "offer" };
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
  // No video RTP arrives.
  async getStats() {
    return new Map();
  }
  close() {}
}

const fakeVideo = () => ({
  srcObject: null,
  addEventListener() {},
  removeEventListener() {},
  async play() {},
});

/** A Duo streaming both displays from a serve-sim session locked to VP8 over WebRTC. */
async function connectLockedVp8Duo() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The test fires the panels' 4 s first-frame deadlines itself.
  const firstFrameDeadlines: Array<() => void> = [];
  stubGlobal("window", {
    location: { href: "https://hub.test/", protocol: "https:", host: "hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (callback: () => void, ms: number) => {
      if (ms !== 4_000) return nativeTimeout(callback, ms);
      firstFrameDeadlines.push(callback);
      return 0;
    },
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      close() {}
      send() {}
    },
  );
  stubGlobal("RTCPeerConnection", Peer);
  stubGlobal("RTCRtpReceiver", { getCapabilities: () => null });
  Peer.instances = [];
  const offers: string[] = [];
  stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input));
    if (pathname === "/api") {
      return Response.json({
        url: "https://hub.test/helper/duo",
        wsUrl: "wss://hub.test/helper/duo/ws",
        device: "duo",
        basePath: "/",
        streamSettings: { transport: "webrtc", codec: "vp8" },
        chrome: { identifier: "phone15", screen: { width: 466, height: 678 }, screenRadius: 33.5 },
      });
    }
    // The flat stream's offer before the displays attach is not of interest here.
    if (pathname.includes("/panel/") && pathname.endsWith("/webrtc/offer")) {
      offers.push(pathname);
      return Response.json({ type: "answer", sdp: "answer" });
    }
    // The sender's stats say nothing about its encoder, so a silent panel blames the codec.
    return Response.json({});
  });

  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "duo",
      enabled: true,
      streamMode: "webrtc",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {});
  await act(async () => {
    for (const display of client.displays!) {
      display.attachVideo(fakeVideo() as unknown as HTMLVideoElement);
    }
  });
  await act(async () => {});
  return { offers, firstFrameDeadlines };
}

test("a locked VP8 display failure restarts the display streams, which the flat stream cannot", async () => {
  const { offers, firstFrameDeadlines } = await connectLockedVp8Duo();
  expect(offers).toEqual(["/helper/duo/panel/1/webrtc/offer", "/helper/duo/panel/3/webrtc/offer"]);

  // Both displays connect, but the shown one never paints, so its first-frame verdict blames VP8.
  for (const peer of Peer.instances) {
    await act(async () => {
      peer.onconnectionstatechange?.();
      peer.ontrack?.({ streams: [{}], track: {} });
    });
  }
  expect(firstFrameDeadlines).toHaveLength(1);
  await act(async () => firstFrameDeadlines[0]!());
  // The verdict reads the receiver and sender stats, then closes the remote session.
  for (let tick = 0; tick < 5; tick++) await act(async () => {});

  // VP8 has no codec to fall back to, so the locked ladder restarts on VP8
  // after its first 2 s backoff.
  const deadline = Date.now() + 3_000;
  while (offers.length < 4 && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => nativeTimeout(resolve, 100));
    });
  }
  expect(offers.slice(2).sort()).toEqual([
    "/helper/duo/panel/1/webrtc/offer",
    "/helper/duo/panel/3/webrtc/offer",
  ]);
}, 10_000);
