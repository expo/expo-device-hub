import { afterEach, expect, test } from "bun:test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useIosDeviceClient } from "../useIosDevice.js";
import { createGlobalStubs } from "./test-globals.js";

class Peer {
  static instances: Peer[] = [];
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription = { type: "offer", sdp: "offer" };
  closeCount = 0;
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
  async setRemoteDescription() {
    this.ontrack?.({ streams: [{ id: Peer.instances.length }], track: {} });
    this.onconnectionstatechange?.();
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.closeCount++;
  }
}

class Video extends EventTarget {
  paused = true;
  videoWidth = 100;
  videoHeight = 200;
  srcObject: unknown = null;
  playCalls = 0;
  rejectPlay = false;
  async play() {
    this.playCalls++;
    if (this.rejectPlay) throw new Error("Playback suspended");
    this.paused = false;
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  Peer.instances = [];
});

function setup() {
  const listeners = new Set<() => void>();
  const document = {
    hidden: false,
    addEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "visibilitychange") listeners.delete(listener);
    },
  };
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("document", document);
  stubGlobal("window", {
    location: { href: "https://app.test/" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
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
  stubGlobal("fetch", async (value: string | URL) => {
    const url = new URL(value);
    if (url.pathname === "/api")
      return Response.json({
        url: `${url.origin}/helper/A`,
        device: "A",
        streamSettings: { transport: "webrtc", codec: "h264" },
      });
    return Response.json({ type: "answer", sdp: "answer", devices: [] });
  });
  function Harness({ baseUrl, video }: { baseUrl: string; video: Video }) {
    const { attachVideo } = useIosDeviceClient({ baseUrl, streamMode: "webrtc" });
    useLayoutEffect(() => {
      attachVideo(video as unknown as HTMLVideoElement);
      return () => attachVideo(null);
    }, [attachVideo, video]);
    return null;
  }
  return {
    document,
    listeners,
    async render(video: Video, baseUrl = "https://a.test") {
      await act(async () => {
        if (renderer) renderer.update(<Harness baseUrl={baseUrl} video={video} />);
        else renderer = create(<Harness baseUrl={baseUrl} video={video} />);
      });
      await act(async () => {
        video.dispatchEvent(new Event("loadeddata"));
      });
    },
    async visibility(hidden: boolean) {
      document.hidden = hidden;
      await act(async () => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}

test("visible iOS video resumes playback without replacing the peer", async () => {
  const harness = setup();
  const video = new Video();
  await harness.render(video);
  const peer = Peer.instances[0]!;
  const stream = video.srcObject;
  const calls = video.playCalls;
  video.paused = true;
  await harness.visibility(true);
  expect(video.playCalls).toBe(calls);
  await harness.visibility(false);
  expect(video.playCalls).toBe(calls + 1);
  expect(video.paused).toBe(false);
  expect(video.srcObject).toBe(stream);
  expect(Peer.instances).toEqual([peer]);
  expect(peer.closeCount).toBe(0);
  await harness.visibility(false);
  expect(video.playCalls).toBe(calls + 1);
});

test("foreground callbacks cannot resume a retired iOS video", async () => {
  const harness = setup();
  const previous = new Video();
  await harness.render(previous);
  const retired = [...harness.listeners];
  const current = new Video();
  await harness.render(current, "https://b.test");
  previous.paused = current.paused = true;
  const previousCalls = previous.playCalls;
  const currentCalls = current.playCalls;
  await act(async () => {
    for (const listener of retired) listener();
  });
  expect(previous.playCalls).toBe(previousCalls);
  expect(current.playCalls).toBe(currentCalls);
  await harness.visibility(false);
  expect(previous.playCalls).toBe(previousCalls);
  expect(current.playCalls).toBe(currentCalls + 1);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  expect(harness.listeners.size).toBe(0);
});

test("a rejected foreground play attempt does not close a healthy iOS peer", async () => {
  const harness = setup();
  const video = new Video();
  await harness.render(video);
  const peer = Peer.instances[0]!;
  const calls = video.playCalls;
  video.paused = video.rejectPlay = true;
  await harness.visibility(false);
  expect(video.playCalls).toBe(calls + 1);
  expect(peer.closeCount).toBe(0);
});
