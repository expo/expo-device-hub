import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientProvider, useDeviceClientSelector } from "../DeviceClientProvider";
import { type DeviceClient, type DevicePlatform } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { createGlobalStubs } from "./test-globals";

class Socket {
  static instances: Socket[] = [];
  static fail = false;
  closed = false;
  metrics = false;
  // Clients choose subscription ids; tests address streams by path.
  streams = new Map<string, number>();
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    if (Socket.fail) throw new Error("unavailable");
    Socket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string | ArrayBuffer) {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (message.token) queueMicrotask(() => this.onmessage?.({ data: '{"ready":true}' }));
    if (typeof message.sub === "number" && typeof message.path === "string") {
      this.streams.set(message.path.split("?")[0]!, message.sub);
      if (message.path === "/ios/metrics") this.metrics = true;
    }
    // serve-sim answers id-only health probes before host action dispatch.
    if (typeof message.id === "number" && !message.ui && !message.action)
      queueMicrotask(() =>
        this.onmessage?.({ data: JSON.stringify({ id: message.id, error: "unsupported request" }) }),
      );
    if (message.ui)
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            id: message.id,
            status: { appearance: "light" },
          }),
        }),
      );
  }
  close() {
    this.closed = true;
  }
}

class MetricsSource extends EventTarget {
  static instances: MetricsSource[] = [];
  static fail = false;
  onerror?: () => void;
  constructor(readonly url: string) {
    super();
    if (MetricsSource.fail) throw new Error("unavailable");
    MetricsSource.instances.push(this);
  }
  close() {}
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let discovery: "ready" | "unsupported" | "error";
let client: DeviceClient;
let trackedRenders: number;
let selectedRenders: number;
let controlRenders: number;

beforeEach(() => {
  jest.useFakeTimers();
  discovery = "ready";
  trackedRenders = selectedRenders = controlRenders = 0;
  Socket.instances = [];
  Socket.fail = false;
  MetricsSource.instances = [];
  MetricsSource.fail = false;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/", origin: "https://hub.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  stubGlobal("EventSource", MetricsSource);
  stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/ios/api") {
      return discovery === "error"
        ? Response.json({}, { status: 503 })
        : Response.json(iosConfig(discovery === "unsupported"));
    }
    return Response.json({}, { status: 404 });
  });
});

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  jest.useRealTimers();
});

function iosConfig(unsupported = false) {
  return {
    url: "https://hub.test/ios/helper/DEVICE-A",
    device: "DEVICE-A",
    pid: 1,
    execToken: "exec-token",
    basePath: "/ios",
    proxyHelpers: true,
    ...(unsupported ? {} : { metricsEndpoint: "/ios/metrics" }),
  };
}

function Observe() {
  client = useDeviceClientSelector((client) => client);
  return null;
}
function TrackedStatus() {
  const { activityStatus } = useDeviceClient();
  trackedRenders++;
  return <span>{activityStatus}</span>;
}
function SelectedStatus() {
  const status = useDeviceClientSelector((client) => client.activityStatus);
  selectedRenders++;
  return <span>{status}</span>;
}
function Controls() {
  const { rotate } = useDeviceClient();
  controlRenders++;
  return <button onClick={rotate}>Rotate</button>;
}

async function render(platform: DevicePlatform, options = {}) {
  await act(async () => {
    const tree = (
      <DeviceClientProvider
        platform={platform}
        options={{
          baseUrl: `https://hub.test/${platform}`,
          device: "DEVICE-A",
          streamMode: "mjpeg",
          ...options,
        }}
      >
        <Observe />
        <TrackedStatus />
        <SelectedStatus />
        <Controls />
      </DeviceClientProvider>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}

function channel(platform: DevicePlatform) {
  if (platform === "ios") {
    const socket = Socket.instances.findLast((socket) => socket.metrics && !socket.closed)!;
    return {
      frame: (event: string, value: unknown): void => {
        socket.onmessage?.({
          data: JSON.stringify({
            sub: socket.streams.get("/ios/metrics"),
            data: `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
          }),
        });
      },
      error: () => {
        socket.close();
        socket.onclose?.();
      },
    };
  }
  const source = MetricsSource.instances.at(-1)!;
  return {
    frame: (event: string, value: unknown): void => {
      source.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(value) }));
    },
    error: () => source.onerror?.(),
  };
}

const sample = {
  t: 1,
  bundleId: "test.app",
  cpuPct: 1,
  memBytes: 0,
  netInBytesPerSec: 0,
  netOutBytesPerSec: 0,
};

for (const platform of ["ios", "android"] as const) {
  test(`${platform} metrics readiness is independent of video and keeps status subscribers quiet`, async () => {
    await render(platform, { enabled: false });
    expect(client.activityStatus).toBe("idle");
    await render(platform);
    expect(client.activityStatus).toBe("loading");
    const stream = channel(platform);
    await act(async () => stream.frame("message", { invalid: true }));
    await act(async () => stream.frame("meta", null));
    expect(client.activityStatus).toBe("loading");
    await act(async () => stream.frame("meta", {}));
    expect(client.activityStatus).toBe("ready");
    expect(client.activity?.samples).toEqual([]);
    expect(client.status).not.toBe("streaming");
    const activity = client.activity;
    const renders = [trackedRenders, selectedRenders, controlRenders];
    await act(async () => stream.frame("meta", {}));
    expect(client.activity).toBe(activity);
    for (let t = 1; t <= 2; t++) {
      await act(async () => stream.frame("message", { ...sample, t }));
      expect([trackedRenders, selectedRenders, controlRenders]).toEqual(renders);
    }
    const samples = client.activity!.samples;
    await act(async () => stream.error());
    expect(client.activityStatus).toBe("error");
    expect(client.activity!.samples).toBe(samples);
    expect(trackedRenders).toBe(renders[0]! + 1);
    expect(selectedRenders).toBe(renders[1]! + 1);
    const errorRenders = [trackedRenders, selectedRenders];
    await act(async () => stream.error());
    expect([trackedRenders, selectedRenders]).toEqual(errorRenders);
    if (platform === "ios") {
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
    }
    await act(async () => channel(platform).frame("meta", {}));
    expect(client.activityStatus).toBe("ready");
    expect(client.activity!.samples).toBe(samples);
    expect(client.activity?.errored).toBe(false);
    const readyRenders = [trackedRenders, selectedRenders];
    await act(async () => {
      jest.advanceTimersByTime(9000);
    });
    expect(client.activityStatus).toBe("ready");
    expect(client.activity?.stale).toBe(true);
    expect([trackedRenders, selectedRenders]).toEqual(readyRenders);
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect([trackedRenders, selectedRenders]).toEqual(readyRenders);
  });

  test(`${platform} replaces device and token readiness and ignores old callbacks`, async () => {
    await render(platform);
    for (const options of [{ token: "new-token" }, { token: "new-token", device: "DEVICE-B" }]) {
      const old = channel(platform);
      await act(async () => old.frame("meta", { hostCores: 8 }));
      expect(client.activityStatus).toBe("ready");
      await render(platform, options);
      expect(client.activityStatus).toBe("loading");
      expect(client.activity?.samples).toEqual([]);
      await act(async () => {
        old.frame("message", sample);
        old.error();
      });
      expect(client.activityStatus).toBe("loading");
      expect(client.activity?.samples).toEqual([]);
      await act(async () => channel(platform).frame("meta", {}));
      expect(client.activityStatus).toBe("ready");
    }
    const old = channel(platform);
    await render(platform, { enabled: false });
    await act(async () => {
      old.frame("meta", {});
      old.error();
    });
    expect(client.activityStatus).toBe("idle");
    expect(client.activity).toBeNull();
  });

  test(`${platform} reports metrics socket construction failures`, async () => {
    if (platform === "ios") Socket.fail = true;
    else MetricsSource.fail = true;
    await render(platform);
    expect(client.activityStatus).toBe("error");
  });
}

test("iOS distinguishes discovery failures and unsupported activity", async () => {
  discovery = "error";
  await render("ios");
  expect(client.activityStatus).toBe("error");
  discovery = "unsupported";
  await act(async () => {
    jest.advanceTimersByTime(1500);
  });
  expect(client.activityStatus).toBe("idle");
  expect(client.capabilities.activity).toBe(false);
});

test("iOS resets readiness when a helper is replaced at the same metrics path", async () => {
  await render("ios");
  const old = channel("ios");
  await act(async () => old.frame("message", sample));
  expect(client.activityStatus).toBe("ready");
  const socket = Socket.instances.find((socket) => socket.metrics)!;
  await act(async () =>
    socket.onmessage?.({
      data: JSON.stringify({
        sub: socket.streams.get("/ios/api/events"),
        data: `data: ${JSON.stringify({ ...iosConfig(), pid: 2, execToken: "replacement" })}\n\n`,
      }),
    }),
  );
  expect(client.activityStatus).toBe("loading");
  expect(client.activity?.samples).toEqual([]);
  await act(async () => old.frame("message", sample));
  expect(client.activityStatus).toBe("loading");
  await act(async () => channel("ios").frame("meta", {}));
  expect(client.activityStatus).toBe("ready");
});

test("Android reports a stream that never supplies samples and recovers on a sample", async () => {
  await render("android");
  await act(async () => {
    jest.advanceTimersByTime(9000);
  });
  expect(client.activityStatus).toBe("error");
  await act(async () => channel("android").frame("message", sample));
  expect(client.activityStatus).toBe("ready");
  expect(client.activity?.errored).toBe(false);
});
