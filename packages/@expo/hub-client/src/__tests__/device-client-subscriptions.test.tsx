import { afterEach, expect, test } from "bun:test";
import { useLayoutEffect, type ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";

import {
  DeviceClientProvider,
  DeviceClientStoreContext,
  useDeviceClientSelector,
} from "../DeviceClientProvider";
import { createDeviceClientStore } from "../device-client-store";
import { useDeviceClient } from "../useDeviceClient";
import { useDeviceScreenClient } from "../useDeviceScreenClient";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import type { DeviceClient, DevicePlatform } from "../types";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

/** Publish a feature-shaped stream update. */
function withStream(client: DeviceClient, patch: Partial<DeviceClient["stream"]>): DeviceClient {
  return { ...client, stream: { ...client.stream, ...patch } } as DeviceClient;
}
/** Change only the FPS; the screen object and the status keep their identity. */
function withFps(client: DeviceClient, fps: number): DeviceClient {
  return withStream(client, {
    data: { screen: client.stream.data?.screen ?? null, fps },
  } as Partial<DeviceClient["stream"]>);
}

async function mount(children: ReactElement) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(children);
  });
}

for (const { platform, streamMode, videoKind, decoder } of [
  { platform: "android", streamMode: "webrtc", videoKind: "canvas", decoder: undefined },
  { platform: "ios", streamMode: "webrtc", videoKind: "video", decoder: undefined },
  { platform: "ios", streamMode: "h264", videoKind: "canvas", decoder: class {} },
  { platform: "ios", streamMode: "h264", videoKind: "img", decoder: undefined },
] as const) {
  test(`the first ${platform} ${streamMode} render uses the backend's ${videoKind} client`, async () => {
    stubGlobal("VideoDecoder", decoder);
    const seen: string[] = [];
    function Screen() {
      const client = useDeviceClient();
      seen.push(`${client.platform}/${client.stream.videoKind}`);
      return null;
    }
    await mount(
      <DeviceClientProvider
        platform={platform}
        options={{ baseUrl: "", streamMode, enabled: false }}
      >
        <Screen />
      </DeviceClientProvider>,
    );
    expect(seen[0]).toBe(`${platform}/${videoKind}`);
  });
}

test("metrics and FPS updates only render their subscribers", async () => {
  const store = createDeviceClientStore();
  const renders = { screen: 0, metrics: 0, fps: 0, controls: 0 };
  let metrics: DeviceClient["activity"]["data"];
  let fps = 0;
  function Screen() {
    useDeviceScreenClient();
    renders.screen++;
    return null;
  }
  function Metrics() {
    metrics = useDeviceClientSelector((client) => client.activity.data);
    renders.metrics++;
    return null;
  }
  function Fps() {
    fps = useDeviceClientSelector((client) => client.stream.data?.fps ?? 0);
    renders.fps++;
    return null;
  }
  function Controls() {
    useDeviceClientSelector((client) => client.pressButton);
    renders.controls++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Screen />
      <Metrics />
      <Fps />
      <Controls />
    </DeviceClientStoreContext.Provider>,
  );
  const initialRenders = { ...renders };
  for (let i = 1; i <= 2; i++) {
    const activity = {
      hostCores: null,
      samples: [
        {
          t: i,
          bundleId: "test.app",
          cpuPct: i,
          memBytes: 0,
          netInBytesPerSec: 0,
          netOutBytesPerSec: 0,
        },
      ],
      stale: false,
    };
    await act(async () => {
      const client = store.getSnapshot();
      store.publish({
        ...client,
        activity: { ...client.activity, status: "ready", data: activity, error: null },
      } as DeviceClient);
    });
    expect(renders).toEqual({
      screen: initialRenders.screen,
      controls: initialRenders.controls,
      metrics: initialRenders.metrics + i,
      fps: initialRenders.fps + i - 1,
    });
    await act(async () => store.publish(withFps(store.getSnapshot(), i)));
    expect(renders).toEqual({
      screen: initialRenders.screen,
      controls: initialRenders.controls,
      metrics: initialRenders.metrics + i,
      fps: initialRenders.fps + i,
    });
  }
  expect(metrics!.samples.at(-1)?.cpuPct).toBe(2);
  expect(fps).toBe(2);
});

test("screen, status, and error changes reach the screen subscriber", async () => {
  const store = createDeviceClientStore();
  let screen!: ReturnType<typeof useDeviceScreenClient>;
  let renders = 0;
  function Screen() {
    screen = useDeviceScreenClient();
    renders++;
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Screen />
    </DeviceClientStoreContext.Provider>,
  );
  const initialRenders = renders;
  await act(async () =>
    store.publish(
      withStream(store.getSnapshot(), {
        status: "loading",
        data: { screen: { width: 1170, height: 2532 }, fps: 0 },
      } as Partial<DeviceClient["stream"]>),
    ),
  );
  expect(renders).toBe(initialRenders + 1);
  expect(screen.screen).toEqual({ width: 1170, height: 2532 });

  await act(async () =>
    store.publish(withStream(store.getSnapshot(), { status: "ready" } as Partial<DeviceClient["stream"]>)),
  );
  expect(renders).toBe(initialRenders + 2);
  expect(screen.status).toBe("ready");

  await act(async () =>
    store.publish(
      withStream(store.getSnapshot(), {
        status: "error",
        error: { code: "network", message: "Disconnected", retryable: true },
      } as Partial<DeviceClient["stream"]>),
    ),
  );
  expect(renders).toBe(initialRenders + 3);
  expect(screen.error).toBe("Disconnected");

  // FPS changes the stream object but none of the screen inputs.
  await act(async () => store.publish(withFps(store.getSnapshot(), 60)));
  expect(renders).toBe(initialRenders + 3);
});

test("selectors follow new props and a changed equality function without a store update", async () => {
  const store = createDeviceClientStore();
  store.publish(
    withFps(
      withStream(NOOP_DEVICE_CLIENT, { status: "ready" } as Partial<DeviceClient["stream"]>),
      30,
    ),
  );
  let selected: unknown;
  function Selected({
    field,
    ignoreChanges = false,
  }: {
    field: "fps" | "status";
    ignoreChanges?: boolean;
  }) {
    selected = useDeviceClientSelector(
      (client) => ({ value: field === "fps" ? client.stream.data?.fps : client.stream.status }),
      ignoreChanges ? () => true : (previous, next) => previous.value === next.value,
    );
    return null;
  }
  const tree = (field: "fps" | "status", ignoreChanges = false) => (
    <DeviceClientStoreContext.Provider value={store}>
      <Selected field={field} ignoreChanges={ignoreChanges} />
    </DeviceClientStoreContext.Provider>
  );
  await mount(tree("fps"));
  expect(selected).toEqual({ value: 30 });
  await act(async () => renderer!.update(tree("status")));
  expect(selected).toEqual({ value: "ready" });
  await act(async () => renderer!.update(tree("status", true)));
  await act(async () =>
    store.publish(withStream(store.getSnapshot(), { status: "error" } as Partial<DeviceClient["stream"]>)),
  );
  expect(selected).toEqual({ value: "ready" });
  await act(async () => renderer!.update(tree("status")));
  expect(selected).toEqual({ value: "error" });
});

test("separate sessions do not share state or retain unmounted subscribers", async () => {
  const first = createDeviceClientStore();
  const second = createDeviceClientStore();
  const seen: number[] = [];
  function Fps() {
    seen.push(useDeviceClientSelector((client) => client.stream.data?.fps ?? 0));
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={first}>
      <Fps />
    </DeviceClientStoreContext.Provider>,
  );
  await act(async () => first.publish(withFps(first.getSnapshot(), 30)));
  await act(async () =>
    renderer!.update(
      <DeviceClientStoreContext.Provider value={second}>
        <Fps />
      </DeviceClientStoreContext.Provider>,
    ),
  );
  expect(seen.at(-1)).toBe(0);
  const renderCount = seen.length;
  await act(async () => first.publish(withFps(first.getSnapshot(), 60)));
  expect(seen).toHaveLength(renderCount);
  await act(async () => second.publish(withFps(second.getSnapshot(), 24)));
  expect(seen.at(-1)).toBe(24);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  const finalRenderCount = seen.length;
  first.publish(withFps(first.getSnapshot(), 90));
  second.publish(withFps(second.getSnapshot(), 48));
  expect(seen).toHaveLength(finalRenderCount);
});

test("an update before the subscription is attached is still displayed", async () => {
  const store = createDeviceClientStore();
  let fps = 0;
  function Fps() {
    fps = useDeviceClientSelector((client) => client.stream.data?.fps ?? 0);
    return null;
  }
  function Publish() {
    useLayoutEffect(() => {
      store.publish(withFps(store.getSnapshot(), 30));
    }, []);
    return null;
  }
  await mount(
    <DeviceClientStoreContext.Provider value={store}>
      <Fps />
      <Publish />
    </DeviceClientStoreContext.Provider>,
  );
  expect(fps).toBe(30);
});

test("the provider opens only the selected backend and owns its cleanup", async () => {
  stubGlobal("window", {
    location: { href: "https://hub.test/", origin: "https://hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const sockets: { url: string; closed: boolean }[] = [];
  stubGlobal(
    "WebSocket",
    class {
      readonly OPEN = 1;
      readonly readyState = 1;
      closed = false;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {
        this.closed = true;
      }
    },
  );
  const requests: string[] = [];
  stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    return new URL(url).pathname === "/ios/api"
      ? Response.json({ url: "https://hub.test/ios/helper/DEVICE-A", device: "DEVICE-A" })
      : Response.json({}, { status: 404 });
  });
  const platforms: DevicePlatform[] = [];
  function Status() {
    const { platform } = useDeviceClient();
    platforms.push(platform);
    return null;
  }
  function Controls() {
    const { pressButton } = useDeviceClient();
    void pressButton;
    return null;
  }
  const tree = (platform: DevicePlatform, enabled = true) => (
    <DeviceClientProvider
      platform={platform}
      options={{
        baseUrl: `https://hub.test/${platform}`,
        device: "DEVICE-A",
        enabled,
        streamMode: "mjpeg",
      }}
    >
      <Status />
      <Controls />
    </DeviceClientProvider>
  );
  await mount(tree("ios"));
  expect(requests.filter((url) => new URL(url).pathname === "/ios/api")).toHaveLength(1);
  expect(sockets.some((socket) => socket.url.includes("/ios/helper/"))).toBe(true);
  expect(requests.some((url) => url.includes("/android/"))).toBe(false);
  await act(async () => renderer!.update(tree("android")));
  expect(platforms.at(-1)).toBe("android");
  expect(
    sockets.filter((socket) => socket.url.includes("/ios/")).every((socket) => socket.closed),
  ).toBe(true);
  expect(requests.some((url) => url.includes("/android/"))).toBe(true);
  await act(async () => renderer!.update(tree("android", false)));
  expect(sockets.every((socket) => socket.closed)).toBe(true);
});

test("server rendering starts without data and without opening a connection", () => {
  const requests: string[] = [];
  stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    return Response.json({});
  });
  function Status() {
    const { stream } = useDeviceClient();
    return <span>{stream.status}</span>;
  }
  const html = renderToString(
    <DeviceClientProvider
      platform="ios"
      options={{ baseUrl: "https://hub.test", streamMode: "mjpeg" }}
    >
      <Status />
    </DeviceClientProvider>,
  );
  // The server snapshot is the inert client: every feature reads as unavailable.
  expect(html).toBe("<span>unsupported</span>");
  expect(requests).toHaveLength(0);
});
