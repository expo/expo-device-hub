import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DuoPanelStreams } from "../duo/DuoPanelStreams";
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

class Peer {
  iceGatheringState = "complete";
  localDescription = { type: "offer", sdp: "offer" };
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

/** A Duo in the 3D preview whose serve-sim session is locked to VP8 over WebRTC. */
async function connectLockedVp8Duo() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/", protocol: "https:", host: "hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
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
  // The ladder's first restart waits 2 s; the test fires it instead.
  const restarts: Array<() => void> = [];
  const nativeTimeout = setTimeout;
  stubGlobal("setTimeout", (callback: () => void, ms: number) => {
    if (ms !== 2_000) return nativeTimeout(callback, ms);
    restarts.push(callback);
    return 0;
  });
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
    if (pathname.endsWith("/webrtc/offer")) {
      offers.push(pathname);
      return Response.json({ type: "answer", sdp: "answer" });
    }
    return Response.json({}, { status: 404 });
  });

  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "duo",
      enabled: true,
      streamMode: "webrtc",
      duoPreview: "3d",
    });
    const panels = client.hinge?.panels;
    return panels ? <DuoPanelStreams feeds={panels} activeScreenId={1} /> : null;
  }
  await act(async () => {
    renderer = create(<Harness />, { createNodeMock: () => null });
  });
  await act(async () => {});
  return { client: () => client, offers, restarts };
}

test("a locked VP8 panel failure restarts the panel feeds, which the flat stream cannot", async () => {
  const { client, offers, restarts } = await connectLockedVp8Duo();
  const panels = client().hinge!.panels!;
  expect(panels).toMatchObject({ mode: "webrtc", codec: "vp8", transportLocked: true });
  expect(offers).toEqual(["/helper/duo/panel/1/webrtc/offer", "/helper/duo/panel/3/webrtc/offer"]);

  // VP8 has no codec to fall back to, so the locked ladder restarts on VP8.
  await act(async () => panels.onWebRtcFailure({ kind: "codec", codec: "vp8", sessionId: "s1" }));
  expect(restarts).toHaveLength(1);
  await act(async () => restarts[0]!());
  await act(async () => {});
  expect(offers.slice(2).sort()).toEqual([
    "/helper/duo/panel/1/webrtc/offer",
    "/helper/duo/panel/3/webrtc/offer",
  ]);

  // Reselecting the failed codec retries the panels at once.
  await act(async () =>
    client().hinge!.panels!.onWebRtcFailure({ kind: "codec", codec: "vp8", sessionId: "s2" }),
  );
  await act(async () => client().setWebRtcCodec("vp8"));
  await act(async () => {});
  expect(offers).toHaveLength(6);
});
