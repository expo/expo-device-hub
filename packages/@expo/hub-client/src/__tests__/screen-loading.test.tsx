import { afterEach, describe, expect, test } from "bun:test";
import { useLayoutEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import {
  SCREEN_LOAD_TIMEOUT_ERROR,
  SCREEN_LOAD_TIMEOUT_MS,
  presentScreen,
  useScreenPresentation,
} from "../screen-presentation";
import { type ConnectionStatus, type DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  Peer.instances = [];
});

/** Capture only the screen load timer; every other timer runs for real. */
function captureLoadTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Map<number, () => void>();
  let id = 0;
  stubGlobal("setTimeout", (callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== SCREEN_LOAD_TIMEOUT_MS) return realSetTimeout(callback, delay, ...args);
    pending.set(++id, callback);
    return -id;
  });
  stubGlobal("clearTimeout", (timer: unknown) => {
    if (typeof timer === "number" && timer < 0) pending.delete(-timer);
    else realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  });
  return {
    get count() {
      return pending.size;
    },
    async fire() {
      await act(async () => {
        for (const [key, callback] of [...pending]) {
          pending.delete(key);
          callback();
        }
      });
    },
  };
}

describe("presentScreen", () => {
  test("a session without a frame is loading, and a frame turns every gap into a reconnect", () => {
    expect(presentScreen("connecting", null, false, false)).toEqual({
      status: "connecting",
      error: null,
      framePresented: false,
    });
    expect(presentScreen("streaming", null, false, false).framePresented).toBe(true);
    for (const status of ["connecting", "reconnecting"] as const) {
      expect(presentScreen(status, null, true, false)).toEqual({
        status: "reconnecting",
        error: null,
        framePresented: true,
      });
    }
  });

  test("the load timeout is an error only before the first frame", () => {
    expect(presentScreen("connecting", null, false, true)).toEqual({
      status: "error",
      error: SCREEN_LOAD_TIMEOUT_ERROR,
      framePresented: false,
    });
    expect(presentScreen("connecting", null, true, true).status).toBe("reconnecting");
  });

  test("errors pass through in both phases, and idle has no frame", () => {
    expect(presentScreen("error", "Offer refused", false, false)).toEqual({
      status: "error",
      error: "Offer refused",
      framePresented: false,
    });
    expect(presentScreen("error", "Offer refused", true, false).framePresented).toBe(true);
    expect(presentScreen("idle", null, true, false).framePresented).toBe(false);
  });
});

describe("useScreenPresentation", () => {
  async function presentation() {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let current!: ReturnType<typeof useScreenPresentation>;
    function Harness({
      sessionKey,
      status,
    }: {
      sessionKey: string | null;
      status: ConnectionStatus;
    }) {
      current = useScreenPresentation(sessionKey, status, null);
      return null;
    }
    const render = async (sessionKey: string | null, status: ConnectionStatus) => {
      await act(async () => {
        if (renderer) renderer.update(<Harness sessionKey={sessionKey} status={status} />);
        else renderer = create(<Harness sessionKey={sessionKey} status={status} />);
      });
      return current;
    };
    return { render };
  }

  test("first load, then a drop without loading, then a new session loads again", async () => {
    const timers = captureLoadTimers();
    const { render } = await presentation();
    expect(await render("device-a", "connecting")).toMatchObject({
      status: "connecting",
      framePresented: false,
    });
    expect(timers.count).toBe(1);
    expect(await render("device-a", "streaming")).toMatchObject({ framePresented: true });
    expect(timers.count).toBe(0);
    expect(await render("device-a", "connecting")).toMatchObject({
      status: "reconnecting",
      framePresented: true,
    });
    // A drop never arms the load timeout.
    expect(timers.count).toBe(0);
    expect(await render("device-b", "connecting")).toMatchObject({
      status: "connecting",
      framePresented: false,
    });
    expect(timers.count).toBe(1);
  });

  test("a stale streaming status in the render that changes the session does not count", async () => {
    captureLoadTimers();
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let current!: ReturnType<typeof useScreenPresentation>;
    // Like the adapters: the status resets in the render that changes the session,
    // but this render still reads the previous session's `streaming`.
    function Adapter({ sessionKey }: { sessionKey: string }) {
      const [status, setStatus] = useState<ConnectionStatus>("streaming");
      const [statusKey, setStatusKey] = useState(sessionKey);
      if (statusKey !== sessionKey) {
        setStatusKey(sessionKey);
        setStatus("connecting");
      }
      current = useScreenPresentation(sessionKey, status, null);
      return null;
    }
    await act(async () => {
      renderer = create(<Adapter sessionKey="device-a" />);
    });
    expect(current.framePresented).toBe(true);
    await act(async () => renderer!.update(<Adapter sessionKey="device-b" />));
    expect(current).toMatchObject({ status: "connecting", framePresented: false });
  });

  test("no first frame in time becomes an error until a frame arrives", async () => {
    const timers = captureLoadTimers();
    const { render } = await presentation();
    await render("device-a", "connecting");
    await timers.fire();
    expect(await render("device-a", "connecting")).toMatchObject({
      status: "error",
      error: SCREEN_LOAD_TIMEOUT_ERROR,
      framePresented: false,
    });
    expect(await render("device-a", "streaming")).toMatchObject({
      status: "streaming",
      error: null,
      framePresented: true,
    });
  });
});

class Peer {
  static instances: Peer[] = [];
  iceGatheringState = "complete";
  connectionState = "connected";
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
  async setRemoteDescription() {
    this.ontrack?.({ streams: [{ id: Peer.instances.length }], track: {} });
    this.onconnectionstatechange?.();
  }
  async getStats() {
    return new Map();
  }
  close() {}
  fail() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

class Video extends EventTarget {
  tagName = "VIDEO";
  readyState = 2;
  paused = true;
  videoWidth = 100;
  videoHeight = 200;
  srcObject: unknown = null;
  poster = "";
  async play() {
    this.paused = false;
  }
  removeAttribute(name: string) {
    if (name === "poster") this.poster = "";
  }
  paint() {
    this.dispatchEvent(new Event("loadeddata"));
  }
}

function mountedClient(platform: "ios" | "android", { offerStatus = 200 } = {}) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("document", {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    createElement: () => ({
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => "data:image/png;base64,last-frame",
    }),
  });
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
    if (url.pathname.endsWith("/webrtc/offer") && offerStatus !== 200) {
      return new Response(null, { status: offerStatus });
    }
    return Response.json({ type: "answer", sdp: "answer", devices: [] });
  });
  const useClient = platform === "ios" ? useIosDeviceClient : useAndroidDeviceClient;
  let client!: DeviceClient;
  function Harness({ baseUrl, video }: { baseUrl: string; video: Video }) {
    client = useClient({ baseUrl, streamMode: "webrtc" });
    const { attachVideo } = client;
    useLayoutEffect(() => {
      attachVideo(video as unknown as HTMLVideoElement);
      return () => attachVideo(null);
    }, [attachVideo, video]);
    return null;
  }
  const video = new Video();
  return {
    video,
    get client() {
      return client;
    },
    async render(baseUrl = "https://a.test") {
      await act(async () => {
        if (renderer) renderer.update(<Harness baseUrl={baseUrl} video={video} />);
        else renderer = create(<Harness baseUrl={baseUrl} video={video} />);
      });
      // Let discovery and the offer settle.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    async paint() {
      await act(async () => video.paint());
    },
  };
}

for (const platform of ["ios", "android"] as const) {
  describe(`${platform} screen loading`, () => {
    test("loads until the first frame, then a dropped stream keeps its frame without loading", async () => {
      const hub = mountedClient(platform);
      await hub.render();
      expect(hub.client.status).toBe("connecting");
      expect(hub.client.framePresented).toBe(false);
      await hub.paint();
      expect(hub.client.status).toBe("streaming");
      expect(hub.client.framePresented).toBe(true);

      await act(async () => Peer.instances.at(-1)!.fail());
      expect(hub.client.status).toBe("reconnecting");
      expect(hub.client.error).toBeNull();
      expect(hub.client.framePresented).toBe(true);
      // The last frame stays on the element as its poster until fresh video paints.
      expect(hub.video.poster).toBe("data:image/png;base64,last-frame");
    });

    test("another device loads again and does not keep the previous device's frame", async () => {
      const hub = mountedClient(platform);
      await hub.render();
      await hub.paint();
      await act(async () => Peer.instances.at(-1)!.fail());
      expect(hub.video.poster).not.toBe("");
      await hub.render("https://b.test");
      expect(hub.client.status).toBe("connecting");
      expect(hub.client.framePresented).toBe(false);
      expect(hub.video.poster).toBe("");
    });

    test("a transport retry before the first frame stays loading, and the load timeout is an error", async () => {
      const timers = captureLoadTimers();
      const hub = mountedClient(platform, { offerStatus: 503 });
      await hub.render();
      expect(hub.client.status).toBe("connecting");
      expect(hub.client.error).toBeNull();
      await timers.fire();
      expect(hub.client.status).toBe("error");
      expect(hub.client.error).toBe(SCREEN_LOAD_TIMEOUT_ERROR);
      expect(hub.client.framePresented).toBe(false);
    });

    test("a refused offer is an error at once, not a spinner", async () => {
      const hub = mountedClient(platform, { offerStatus: 403 });
      await hub.render();
      expect(hub.client.status).toBe("error");
      expect(hub.client.error).toContain("403");
    });
  });
}
