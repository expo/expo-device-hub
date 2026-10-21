import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { AVCC_FRAME_TIMEOUT_MS } from "../avcc-fallback";
import { type DeviceClient, type DeviceConnectionOptions } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

// A helper restart for the same device is a temporary drop (LLP 0015): the
// screen keeps its last frame, its media element, and its surface while
// `/api` has no config, and the retry loads off screen.

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  Socket.instances = [];
  FakeImage.instances = [];
  restoreGlobals();
});

class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (event: Pick<CloseEvent, "code" | "reason">) => void;
  onmessage?: (event: { data: string | ArrayBuffer }) => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** An `<img>` that paints when the test says so. */
class FakeImage extends EventTarget {
  static instances: FakeImage[] = [];
  tagName = "IMG";
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  style: Record<string, string> = {};
  srcs: string[] = [];
  #src = "";
  constructor() {
    super();
    FakeImage.instances.push(this);
  }
  get src() {
    return this.#src;
  }
  set src(value: string) {
    this.#src = value;
    this.srcs.push(value);
  }
  removeAttribute(name: string) {
    if (name === "src") {
      this.#src = "";
      this.complete = true;
      this.naturalWidth = this.naturalHeight = 0;
    }
  }
  paint(width = 390, height = 844) {
    this.complete = true;
    this.naturalWidth = width;
    this.naturalHeight = height;
    this.onload?.();
    this.dispatchEvent(new Event("load"));
  }
  fail() {
    this.onerror?.();
    this.dispatchEvent(new Event("error"));
  }
}

async function iosClient(options: Partial<DeviceConnectionOptions> = {}) {
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const intervals = new Map<number, () => void>();
  let id = 0;
  const schedule = (callback: () => void, delay: number) => {
    timers.set(++id, { callback, delay });
    return id;
  };
  const cancel = (timer: number) => {
    timers.delete(timer);
  };
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("setTimeout", schedule);
  stubGlobal("clearTimeout", cancel);
  stubGlobal("setInterval", (callback: () => void) => {
    intervals.set(++id, callback);
    return id;
  });
  stubGlobal("clearInterval", (timer: number) => intervals.delete(timer));
  stubGlobal("window", {
    location: { href: "https://hub.test/" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: schedule,
    clearTimeout: cancel,
  });
  stubGlobal("document", {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => "data:image/jpeg;base64,retry-frame",
    }),
  });
  stubGlobal("WebSocket", Socket);
  stubGlobal("Image", FakeImage);
  stubGlobal("RTCPeerConnection", undefined);
  const discoveries: Array<(response: Response) => void> = [];
  stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (/\/api$/.test(new URL(url).pathname) && !url.includes("/grid/")) {
      return new Promise<Response>((resolve) => discoveries.push(resolve));
    }
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "device-1",
      streamMode: "mjpeg",
      ...options,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const settle = async () => {
    await act(async () => {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    });
  };
  return {
    get client() {
      return client;
    },
    discoveries,
    /** Answer the next pending `/api` request. */
    async discover(config: Record<string, unknown> | null) {
      const pending = discoveries.length;
      for (let wait = 0; discoveries.length === pending && wait < 20; wait++) await settle();
      await act(async () => discoveries.at(-1)!(Response.json(config)));
      await settle();
    },
    /** The helper went away: its socket closes and the client asks `/api` again. */
    async loseHelper() {
      const helperSocket = Socket.instances.findLast((socket) => socket.url.includes("/helper/"));
      await act(async () => helperSocket?.close(1006));
      await this.fireTimers(1500);
    },
    async fireTimers(delay: number) {
      await act(async () => {
        for (const [timer, entry] of [...timers]) {
          if (entry.delay !== delay) continue;
          timers.delete(timer);
          entry.callback();
        }
      });
      await settle();
    },
    async tick() {
      await act(async () => {
        for (const callback of [...intervals.values()]) callback();
      });
    },
  };
}

const helper = (extra: Record<string, unknown> = {}) => ({
  url: "https://hub.test/helper/device-1",
  device: "device-1",
  pid: 1,
  ...extra,
});

test("an MJPEG retry after the first frame loads off screen and keeps the last frame", async () => {
  const hub = await iosClient();
  const visible = new FakeImage();
  await act(async () => hub.client.attachVideo(visible as unknown as HTMLImageElement));
  await hub.discover(helper());
  expect(visible.srcs).toHaveLength(1);
  await act(async () => visible.paint());
  expect(hub.client.status).toBe("streaming");

  // The request fails, but the element still shows its last frame.
  await act(async () => visible.fail());
  expect(hub.client.status).toBe("reconnecting");
  expect(hub.client.framePresented).toBe(true);
  // That frame is old: the frame poll must not read it as a live stream.
  await hub.tick();
  expect(hub.client.status).toBe("reconnecting");
  await hub.fireTimers(1500);
  const probe = FakeImage.instances.find((image) => image !== visible)!;
  expect(probe.src).toContain("/helper/device-1/stream.mjpeg");
  // Only the off-screen image retries; the visible one keeps its frame.
  expect(visible.srcs).toHaveLength(1);

  // A failed retry stays off screen too.
  await act(async () => probe.fail());
  expect(visible.srcs).toHaveLength(1);
  expect(hub.client.status).toBe("reconnecting");
  await hub.fireTimers(1500);
  const next = FakeImage.instances.at(-1)!;
  expect(next).not.toBe(probe);
  const working = next.src;
  await act(async () => next.paint());
  // The stream is back: the visible image takes the working request, and the probe stops.
  expect(visible.srcs.at(-1)).toBe(working);
  expect(next.src).toBe("");
  expect(hub.client.status).toBe("streaming");
  // The browser clears the visible <img> while its new request loads, so the
  // retry's frame stays behind it until the <img> paints its own.
  expect(visible.style.backgroundImage).toContain("retry-frame");
  visible.naturalWidth = 0;
  await hub.tick();
  expect(visible.style.backgroundImage).toContain("retry-frame");
  await act(async () => visible.paint());
  await hub.tick();
  expect(visible.style.backgroundImage).toBe("");
});

test("a helper restart keeps the MJPEG frame, the screen size, and the media element", async () => {
  const hub = await iosClient();
  const visible = new FakeImage();
  await act(async () => hub.client.attachVideo(visible as unknown as HTMLImageElement));
  await hub.discover(helper());
  await act(async () => visible.paint());
  await hub.tick();
  expect(hub.client.status).toBe("streaming");
  expect(hub.client.screen).toMatchObject({ width: 390, height: 844 });

  await hub.loseHelper();
  await hub.discover(null);
  expect(hub.client.status).toBe("reconnecting");
  expect(hub.client.framePresented).toBe(true);
  expect(visible.src).not.toBe("");
  expect(hub.client.videoKind).toBe("img");
  expect(hub.client.screen).toMatchObject({ width: 390, height: 844 });

  // The replacement helper streams through an off-screen request first.
  await hub.fireTimers(1500);
  await hub.discover(helper({ pid: 2 }));
  const probe = FakeImage.instances.find((image) => image !== visible)!;
  expect(probe).toBeDefined();
  expect(visible.srcs).toHaveLength(1);
  await act(async () => probe.paint());
  expect(visible.srcs).toHaveLength(2);
  expect(hub.client.status).toBe("streaming");
});

test("a helper restart keeps a locked WebRTC stream's element and the Duo's 3D model", async () => {
  const hub = await iosClient({ streamMode: "h264" });
  await hub.discover(
    helper({
      streamSettings: { transport: "webrtc", codec: "h264" },
      chrome: { identifier: "phone15" },
    }),
  );
  expect(hub.client.videoKind).toBe("video");
  const modelUrl = hub.client.deviceModelUrl;
  expect(modelUrl).toContain("devicekit-model");
  expect(hub.client.displays).not.toBeNull();

  await hub.loseHelper();
  await hub.discover(null);
  // The requested H.264 would replace the <video>; the last config still names WebRTC.
  expect(hub.client.videoKind).toBe("video");
  expect(hub.client.deviceModelUrl).toBe(modelUrl);
  expect(hub.client.fold).not.toBeNull();
  expect(hub.client.displays).not.toBeNull();
});

test("a new helper pid keeps the H.264 to MJPEG fallback", async () => {
  stubGlobal("VideoDecoder", class {});
  const hub = await iosClient({ streamMode: "h264" });
  await hub.discover(helper());
  expect(hub.client.videoKind).toBe("canvas");
  // No H.264 frame in time: this browser falls back to MJPEG.
  await hub.fireTimers(AVCC_FRAME_TIMEOUT_MS);
  expect(hub.client.videoKind).toBe("img");

  await hub.loseHelper();
  await hub.discover(null);
  expect(hub.client.videoKind).toBe("img");
  await hub.fireTimers(1500);
  await hub.discover(helper({ pid: 2 }));
  expect(hub.client.videoKind).toBe("img");
});

test("an <img> attached during a retry loads its own request; the retry does not hand over to the old one", async () => {
  const hub = await iosClient();
  const first = new FakeImage();
  await act(async () => hub.client.attachVideo(first as unknown as HTMLImageElement));
  await hub.discover(helper());
  await act(async () => first.paint());
  await act(async () => first.fail());
  await hub.fireTimers(1500);
  const probe = FakeImage.instances.find((image) => image !== first)!;
  expect(probe.src).toContain("stream.mjpeg");

  // DeviceScreen mounts a new <img> while the retry loads.
  const second = new FakeImage();
  await act(async () => hub.client.attachVideo(second as unknown as HTMLImageElement));
  expect(second.srcs).toHaveLength(1);
  expect(first.src).toBe("");
  // The next poll stops the moot retry; a late paint of it changes nothing.
  await hub.tick();
  expect(probe.src).toBe("");
  await act(async () => probe.paint());
  expect(first.srcs).toHaveLength(1);
  expect(hub.client.status).toBe("reconnecting");

  // The new element's own request paints: the stream is back.
  await act(async () => second.paint());
  await hub.tick();
  await hub.tick();
  expect(hub.client.status).toBe("streaming");
  expect(hub.client.error).toBeNull();
});

test("a retry that paints after a new <img> attached does not hold the screen in reconnecting", async () => {
  const hub = await iosClient();
  const first = new FakeImage();
  await act(async () => hub.client.attachVideo(first as unknown as HTMLImageElement));
  await hub.discover(helper());
  await act(async () => first.paint());
  await act(async () => first.fail());
  await hub.fireTimers(1500);
  const probe = FakeImage.instances.find((image) => image !== first)!;
  const second = new FakeImage();
  await act(async () => hub.client.attachVideo(second as unknown as HTMLImageElement));
  // The retry paints before any poll: its hand-over finds the new element.
  await act(async () => probe.paint());
  expect(first.srcs).toHaveLength(1);
  await act(async () => second.paint());
  await hub.tick();
  expect(hub.client.status).toBe("streaming");
});
