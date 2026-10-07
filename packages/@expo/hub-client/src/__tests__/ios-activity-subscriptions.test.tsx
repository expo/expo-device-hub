import { afterEach, expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { DeviceClientProvider } from "../DeviceClientProvider";
import type { DeviceClient } from "../types";
import { useDeviceClient } from "../useDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let restoreClock: (() => void) | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreClock?.();
  restoreClock = undefined;
  restoreGlobals();
});

test("stale iOS activity stops rendering until a new metrics sample arrives", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://hub.test/" },
    addEventListener() {},
    removeEventListener() {},
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const intervals = new Map<number, () => void>();
  let nextInterval = 0;
  stubGlobal("setInterval", (callback: () => void) => {
    intervals.set(++nextInterval, callback);
    return nextInterval;
  });
  stubGlobal("clearInterval", (id: number) => intervals.delete(id));
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
  const sockets: Array<{ url: string; sent: string[]; onmessage?: (event: { data: string }) => void }> = [];
  stubGlobal(
    "WebSocket",
    class {
      readonly readyState = 1;
      sent: string[] = [];
      onmessage?: (event: { data: string }) => void;
      constructor(readonly url: string) {
        sockets.push(this);
      }
      send(message: string) { this.sent.push(message); }
      close() {}
    },
  );
  stubGlobal("fetch", async (url: string) =>
    new URL(url).pathname === "/ios/api"
      ? Response.json({
          url: "https://hub.test/ios/helper/DEVICE-A",
          device: "DEVICE-A",
          execToken: "test-token",
          metricsEndpoint: "/metrics",
        })
      : Response.json({}, { status: 404 }),
  );
  let activity!: DeviceClient["activity"];
  let renders = 0;
  let unrelatedRenders = 0;
  function Activity() {
    ({ activity } = useDeviceClient());
    renders++;
    return null;
  }
  function Unrelated() {
    unrelatedRenders++;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientProvider
        platform="ios"
        options={{ baseUrl: "https://hub.test/ios", streamMode: "mjpeg" }}
      >
        <Activity />
        <Unrelated />
      </DeviceClientProvider>,
    );
  });
  expect(unrelatedRenders).toBe(1);
  const metrics = sockets.find((socket) => socket.url.endsWith("/exec-ws"))!;
  await act(async () => metrics.onmessage?.({ data: JSON.stringify({ ready: true }) }));
  const subscription = metrics.sent.map(message => JSON.parse(message)).find(message => message.path === "/metrics");
  expect(subscription).toBeDefined();
  const sample = (t: number) =>
    metrics.onmessage?.({
      data: JSON.stringify({
        sub: subscription.sub,
        data: `data: ${JSON.stringify({ t, bundleId: "test.app", cpuPct: 10, memBytes: 0, netInBytesPerSec: 0, netOutBytesPerSec: 0 })}\n\n`,
      }),
    });
  const tick = async () => {
    await act(async () => {
      for (const callback of intervals.values()) callback();
    });
  };
  await act(async () => sample(now));
  expect(activity?.stale).toBe(false);
  const freshRenders = renders;
  now += 9000;
  await tick();
  expect(activity?.stale).toBe(true);
  expect(renders).toBe(freshRenders + 1);
  const staleActivity = activity;
  const staleRenders = renders;
  for (let i = 0; i < 2; i++) {
    now += 1000;
    await tick();
    expect(activity).toBe(staleActivity);
    expect(renders).toBe(staleRenders);
  }
  await act(async () => sample(now));
  expect(activity?.stale).toBe(false);
  expect(activity?.samples).toHaveLength(2);
  expect(renders).toBe(staleRenders + 1);
  expect(unrelatedRenders).toBe(1);
});
