import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";

// Run the real hooks and ref lifecycle, with only browser/network APIs replaced.
// Window timers are manual so a hidden tab and a stalled peer are deterministic.
class TestWindow extends EventTarget {
  now = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };
  clearTimeout = (id: number) => {
    this.timers.delete(id);
  };
  advance(ms: number) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 1;
  messages: string[] = [];
  onopen: (() => void) | null = null;
  constructor() {
    TestSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(message: string) {
    this.messages.push(message);
  }
  close() {
    this.readyState = 3;
  }
}

class TestPeer extends EventTarget {
  static instances: TestPeer[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    super();
    TestPeer.instances.push(this);
  }
  addTransceiver() {
    return {};
  }
  async createOffer() {
    return { type: "offer", sdp: "test" };
  }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }
  async setRemoteDescription() {
    this.connectionState = "connected";
    this.onconnectionstatechange?.();
    this.ontrack?.({ track: {}, streams: [{ id: String(TestPeer.instances.length) }] });
  }
  close() {
    this.connectionState = "closed";
  }
}

class TestVideo extends EventTarget {
  tagName = "VIDEO";
  videoWidth = 570;
  videoHeight = 1280;
  currentTime = 0;
  paused = true;
  rejectPlay = false;
  srcObject: unknown = null;
  playCalls = 0;
  presentedFrames = 0;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  nextId = 1;
  async play() {
    this.playCalls++;
    if (this.rejectPlay) throw new Error("Playback suspended");
    this.paused = false;
  }
  requestVideoFrameCallback: ((callback: VideoFrameRequestCallback) => number) | undefined = (
    callback,
  ) => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };
  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id);
  }
  frame(advance = true) {
    if (this.paused || !this.srcObject || doc.hidden) return false;
    if (advance) {
      this.currentTime += 1 / 60;
      this.presentedFrames++;
    }
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback(performance.now(), {
        presentedFrames: this.presentedFrames,
        mediaTime: this.currentTime,
        presentationTime: performance.now(),
        expectedDisplayTime: performance.now(),
        width: this.videoWidth,
        height: this.videoHeight,
      });
    }
    this.dispatchEvent(new Event("timeupdate"));
    return true;
  }
}

const globals = [
  "window",
  "document",
  "fetch",
  "WebSocket",
  "RTCPeerConnection",
  "RTCRtpReceiver",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = new Map(
  globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
let testWindow: TestWindow;
let doc: EventTarget & { hidden: boolean };
let root: ReactTestRenderer | null;
let video: TestVideo;
let client: DeviceClient;

beforeEach(() => {
  TestSocket.instances = [];
  TestPeer.instances = [];
  root = null;
  testWindow = new TestWindow();
  doc = Object.assign(new EventTarget(), { hidden: false });
  const replacements = {
    window: testWindow,
    document: doc,
    IS_REACT_ACT_ENVIRONMENT: true,
    WebSocket: TestSocket,
    RTCPeerConnection: TestPeer,
    RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
    fetch: async (input: string) => {
      const path = new URL(input).pathname;
      return Response.json(
        path === "/api"
          ? {
              stream: {
                transport: "webrtc",
                codec: "h264",
                iceServers: [],
                iceTransportPolicy: "all",
              },
            }
          : path === "/webrtc/offer"
            ? { type: "answer", sdp: "test" }
            : {},
      );
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});

afterEach(async () => {
  await act(async () => root?.unmount());
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function Surface({ device = "emulator-5554" }: { device?: string }) {
  client = useAndroidDeviceClient({ baseUrl: "http://hub.test", device, streamMode: "webrtc" });
  return client.status === "idle"
    ? null
    : createElement(client.videoKind, { ref: client.attachVideo });
}

async function mount(frameCallbacks = true) {
  await act(async () => {
    root = create(createElement(Surface), {
      createNodeMock: (element) => {
        if (element.type !== "video") return { tagName: "CANVAS", getContext: () => null };
        video = new TestVideo();
        if (!frameCallbacks) video.requestVideoFrameCallback = undefined;
        return video;
      },
    });
  });
  await act(async () => {
    expect(video.frame()).toBe(true);
  });
  expect(client.status).toBe("streaming");
}

async function visibility(hidden: boolean) {
  await act(async () => {
    doc.hidden = hidden;
    doc.dispatchEvent(new Event("visibilitychange"));
  });
}

async function advance(ms: number) {
  await act(async () => {
    testWindow.advance(ms);
  });
}

const keyframeRequests = () =>
  TestSocket.instances
    .flatMap((socket) => socket.messages)
    .filter((message) => JSON.parse(message).type === "reset-video").length;

describe("Android WebRTC playback after returning to the tab", () => {
  test("resumes suspended playback and waits for a new frame without replacing the peer", async () => {
    await mount();
    const stream = video.srcObject;
    const requests = keyframeRequests();
    await visibility(true);
    video.paused = true;
    await visibility(false);

    expect(video.paused).toBe(false);
    expect(client.status).toBe("reconnecting");
    expect(video.srcObject).toBe(stream);
    await act(async () => {
      expect(video.frame()).toBe(true);
    });
    expect(client.status).toBe("streaming");
    await advance(5_000);
    expect(keyframeRequests()).toBe(requests);
    expect(TestPeer.instances).toHaveLength(1);
  });

  test("requests a keyframe for a stalled decoder, then reconnects if no frame arrives", async () => {
    await mount();
    const requests = keyframeRequests();
    await visibility(true);
    await visibility(false);
    await advance(1_000);
    expect(keyframeRequests()).toBe(requests + 1);
    expect(TestPeer.instances).toHaveLength(1);
    await advance(3_000);
    expect(TestPeer.instances).toHaveLength(2);
    expect(TestPeer.instances[0].connectionState).toBe("closed");
    await act(async () => {
      expect(video.frame()).toBe(true);
    });
    expect(client.status).toBe("streaming");
  });

  test("a frame after the keyframe request cancels the reconnect", async () => {
    await mount();
    await visibility(true);
    await visibility(false);
    await advance(1_000);
    await act(async () => {
      video.frame();
    });
    await advance(5_000);
    expect(TestPeer.instances).toHaveLength(1);
    expect(client.status).toBe("streaming");
  });

  test("cancels recovery while hidden and gives the next return a fresh deadline", async () => {
    await mount();
    const requests = keyframeRequests();
    await visibility(true);
    await visibility(false);
    await advance(500);
    await visibility(true);
    await advance(60_000);
    expect(keyframeRequests()).toBe(requests);
    expect(TestPeer.instances).toHaveLength(1);
    await visibility(false);
    await advance(999);
    expect(keyframeRequests()).toBe(requests);
    await act(async () => {
      video.frame();
    });
    await advance(5_000);
    expect(TestPeer.instances).toHaveLength(1);
  });

  test("a rejected play attempt still recovers through a replacement stream", async () => {
    await mount();
    await visibility(true);
    video.paused = true;
    video.rejectPlay = true;
    await visibility(false);
    expect(client.status).toBe("reconnecting");
    video.rejectPlay = false;
    await advance(4_000);
    expect(TestPeer.instances).toHaveLength(2);
    await act(async () => {
      expect(video.frame()).toBe(true);
    });
    expect(client.status).toBe("streaming");
  });

  test("a callback for the last presented frame does not satisfy recovery", async () => {
    await mount();
    await visibility(true);
    await visibility(false);
    await act(async () => {
      video.frame(false);
      video.dispatchEvent(new Event("loadeddata"));
    });
    expect(client.status).toBe("reconnecting");
    await advance(4_000);
    expect(TestPeer.instances).toHaveLength(2);
  });

  test("without frame callbacks, only advancing playback satisfies recovery", async () => {
    await mount(false);
    await visibility(true);
    await visibility(false);
    await act(async () => {
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("loadeddata"));
    });
    expect(client.status).toBe("reconnecting");
    await act(async () => {
      video.frame();
    });
    expect(client.status).toBe("streaming");
    await advance(5_000);
    expect(TestPeer.instances).toHaveLength(1);
  });

  test("device replacement cancels the previous stream recovery", async () => {
    await mount();
    await visibility(true);
    await visibility(false);
    await act(async () => {
      root!.update(createElement(Surface, { device: "emulator-5556" }));
    });
    await act(async () => {
      video.frame();
    });
    const peersAfterSwitch = TestPeer.instances.length;
    await advance(5_000);
    expect(TestPeer.instances).toHaveLength(peersAfterSwitch);
    expect(TestPeer.instances[0].connectionState).toBe("closed");
    expect(client.status).toBe("streaming");
  });

  test("unmount removes pending recovery and visibility listeners", async () => {
    await mount();
    await visibility(true);
    await visibility(false);
    await act(async () => {
      root!.unmount();
      root = null;
    });
    const calls = video.playCalls;
    const requests = keyframeRequests();
    await visibility(true);
    await visibility(false);
    await advance(60_000);
    expect(video.playCalls).toBe(calls);
    expect(keyframeRequests()).toBe(requests);
    expect(TestPeer.instances).toHaveLength(1);
    expect(testWindow.timers.size).toBe(0);
    expect(video.callbacks.size).toBe(0);
  });
});
