import { afterEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  androidModeAvailability,
  parseServeEmuViewerTransports,
  useAndroidDeviceClient,
} from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const WEBRTC_STREAM = {
  transport: "webrtc",
  codec: "h264",
  iceServers: [],
  iceTransportPolicy: "all",
};

describe("serve-emu viewer transports", () => {
  test("follow the advertised list and keep the old rule when it is missing", () => {
    const webrtc = {
      transport: "webrtc" as const,
      codec: "h264" as const,
      iceServers: [],
      iceTransportPolicy: "all" as const,
    };
    // `--transport webrtc` refuses a video WebSocket.
    expect(
      androidModeAvailability(webrtc, parseServeEmuViewerTransports({ available: ["webrtc"] })),
    ).toEqual({ mjpeg: false, h264: false, webrtc: true });
    // Without H.264 there is no WebRTC, so the WebSocket keeps video.
    expect(
      androidModeAvailability(webrtc, parseServeEmuViewerTransports({ available: ["websocket"] })),
    ).toEqual({ mjpeg: false, h264: true, webrtc: false });
    // The client takes ICE settings only from a WebRTC host, as before.
    expect(
      androidModeAvailability(
        { transport: "websocket" },
        parseServeEmuViewerTransports({ available: ["websocket", "webrtc"] }),
      ),
    ).toEqual({ mjpeg: false, h264: true, webrtc: false });
    // An older serve-emu without the list.
    expect(androidModeAvailability(webrtc, parseServeEmuViewerTransports(undefined))).toEqual({
      mjpeg: false,
      h264: true,
      webrtc: true,
    });
    expect(parseServeEmuViewerTransports({ available: ["carrier-pigeon"] })).toBeNull();
    expect(parseServeEmuViewerTransports({ available: "webrtc" })).toBeNull();
  });
});

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

function stubBrowser(api: object) {
  const sockets: string[] = [];
  const requests: string[] = [];
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("VideoDecoder", class {});
  stubGlobal("EncodedVideoChunk", class {});
  stubGlobal("RTCRtpReceiver", { getCapabilities: () => null });
  stubGlobal(
    "RTCPeerConnection",
    class {
      iceGatheringState = "complete";
      connectionState = "new";
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
    },
  );
  stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      constructor(url: string) {
        sockets.push(url);
      }
      send() {}
      close() {}
    },
  );
  stubGlobal("fetch", async (url: string) => {
    requests.push(String(url));
    const path = new URL(url).pathname;
    if (path === "/api") return Response.json(api);
    if (path === "/webrtc/offer") return Response.json({ type: "answer", sdp: "answer" });
    return Response.json({}, { status: 404 });
  });
  return { sockets, requests };
}

async function renderAndroid() {
  let client!: ReturnType<typeof useAndroidDeviceClient>;
  function Harness() {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test",
      device: "emulator-5554",
      streamMode: "h264",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return client;
}

test("an H.264 viewer of a WebRTC-only host uses WebRTC and never opens a video WebSocket", async () => {
  const { sockets, requests } = stubBrowser({
    stream: WEBRTC_STREAM,
    viewerTransports: { default: "webrtc", available: ["webrtc"], webrtc: WEBRTC_STREAM },
  });
  const client = await renderAndroid();
  expect(client.streamCapabilities?.modeAvailability).toEqual({
    mjpeg: false,
    h264: false,
    webrtc: true,
  });
  expect(sockets.length).toBeGreaterThan(0);
  expect(sockets.every((url) => new URL(url).searchParams.get("video") === "0")).toBe(true);
  expect(requests.some((url) => url.endsWith("/webrtc/offer?device=emulator-5554"))).toBe(true);
  expect(client.videoKind).toBe("video");
});

test("an H.264 viewer of an older WebRTC host keeps the video WebSocket", async () => {
  const { sockets, requests } = stubBrowser({ stream: WEBRTC_STREAM });
  const client = await renderAndroid();
  expect(client.streamCapabilities?.modeAvailability).toEqual({
    mjpeg: false,
    h264: true,
    webrtc: true,
  });
  expect(sockets.map((url) => new URL(url).searchParams.get("frame-meta"))).toEqual(["1"]);
  expect(requests.some((url) => url.includes("/webrtc/offer"))).toBe(false);
  expect(client.videoKind).toBe("canvas");
});
