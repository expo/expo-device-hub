import { afterEach, expect, test } from "bun:test";
import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useIosDeviceClient } from "../useIosDevice";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

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
  tagName = "VIDEO";
  readyState = 2;
  paused = true;
  videoWidth = 100;
  videoHeight = 200;
  srcObject: unknown = null;
  playCalls = 0;
  rejectPlay = false;
  frameCallbacks = new Map<number, VideoFrameRequestCallback>();
  nextFrameCallback = 0;
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    this.frameCallbacks.set(++this.nextFrameCallback, callback);
    return this.nextFrameCallback;
  }
  cancelVideoFrameCallback(id: number) {
    this.frameCallbacks.delete(id);
  }
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
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

function setup(platform: "ios" | "android") {
  const sockets: object[] = [];
  const useClient = platform === "ios" ? useIosDeviceClient : useAndroidDeviceClient;
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
      constructor() {
        sockets.push(this);
      }
      close() {}
      send() {}
    },
  );
  stubGlobal(
    "EventSource",
    class extends EventTarget {
      close() {}
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
        size: { width: 100, height: 200 },
        stream: { transport: "webrtc", codec: "h264", iceServers: [], iceTransportPolicy: "all" },
      });
    return Response.json({ type: "answer", sdp: "answer", devices: [] });
  });
  function Harness({
    baseUrl,
    video,
    onAttach,
  }: {
    baseUrl: string;
    video: Video | null;
    onAttach?: () => void;
  }) {
    const { attachVideo } = useClient({ baseUrl, streamMode: "webrtc" });
    useLayoutEffect(() => {
      attachVideo(video as unknown as HTMLVideoElement);
      onAttach?.();
      return () => attachVideo(null);
    }, [attachVideo, video, onAttach]);
    return null;
  }
  return {
    document,
    listeners,
    sockets,
    async render(video: Video | null, baseUrl = "https://a.test", onAttach?: () => void) {
      await act(async () => {
        if (renderer)
          renderer.update(<Harness baseUrl={baseUrl} video={video} onAttach={onAttach} />);
        else renderer = create(<Harness baseUrl={baseUrl} video={video} onAttach={onAttach} />);
      });
      await act(async () => {
        video?.dispatchEvent(new Event("loadeddata"));
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

for (const platform of ["ios", "android"] as const) {
  test(`${platform} video resumes playback without replacing the peer`, async () => {
    const harness = setup(platform);
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

  test(`foreground callbacks cannot resume a retired ${platform} video`, async () => {
    const harness = setup(platform);
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

  test(`rejected foreground play does not close a healthy ${platform} peer`, async () => {
    const harness = setup(platform);
    const video = new Video();
    await harness.render(video);
    const peer = Peer.instances[0]!;
    const calls = video.playCalls;
    video.paused = video.rejectPlay = true;
    await harness.visibility(false);
    expect(video.playCalls).toBe(calls + 1);
    expect(peer.closeCount).toBe(0);
  });

  test(`${platform} video replacement keeps the current peer and retires the old surface`, async () => {
    const harness = setup(platform);
    const previous = new Video();
    await harness.render(previous);
    const stream = previous.srcObject;
    expect(stream).not.toBeNull();
    const peer = Peer.instances[0]!;
    const sockets = [...harness.sockets];
    const retired = [...harness.listeners];
    const retiredFrame = [...previous.frameCallbacks.values()][0]!;
    const current = new Video();
    previous.paused = true;
    const beforeReplacement = previous.playCalls;
    await harness.render(current, undefined, () => {
      for (const listener of retired) listener();
    });
    expect(previous.playCalls).toBe(beforeReplacement);
    expect(Peer.instances).toEqual([peer]);
    expect(peer.closeCount).toBe(0);
    expect(harness.sockets).toEqual(sockets);
    expect(previous.srcObject).toBeNull();
    expect(previous.frameCallbacks.size).toBe(0);
    await act(async () =>
      retiredFrame(0, {
        presentedFrames: 1,
        width: 100,
        height: 200,
        mediaTime: 0,
        presentationTime: 0,
        expectedDisplayTime: 0,
      }),
    );
    expect(previous.frameCallbacks.size).toBe(0);
    expect(current.frameCallbacks.size).toBe(1);
    expect(current.srcObject).toBe(stream);
    expect(current.playCalls).toBe(1);
    previous.paused = current.paused = true;
    const previousCalls = previous.playCalls;
    await act(async () => {
      for (const listener of retired) listener();
    });
    expect(previous.playCalls).toBe(previousCalls);
    expect(current.playCalls).toBe(1);
    await harness.visibility(true);
    expect(current.playCalls).toBe(1);
    await harness.visibility(false);
    expect(current.playCalls).toBe(2);
    expect(previous.playCalls).toBe(previousCalls);
    expect(current.srcObject).toBe(stream);
  });

  test(`${platform} video attached after negotiation uses the existing peer`, async () => {
    const harness = setup(platform);
    await harness.render(null);
    const peer = Peer.instances[0]!;
    const sockets = [...harness.sockets];
    const video = new Video();
    await harness.render(video);
    expect(video.srcObject).not.toBeNull();
    expect(video.playCalls).toBe(1);
    expect(Peer.instances).toEqual([peer]);
    expect(peer.closeCount).toBe(0);
    expect(harness.sockets).toEqual(sockets);
  });
}
