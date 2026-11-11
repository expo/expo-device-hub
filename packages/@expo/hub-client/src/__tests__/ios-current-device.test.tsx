import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

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

function stubBrowser() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: {
      href: "http://localhost:3200/",
      origin: "http://localhost:3200",
      protocol: "http:",
      host: "localhost:3200",
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      constructor(readonly url: string) {}
      send() {}
      close() {}
    },
  );
  stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  stubGlobal("fetch", async (url: string) => {
    const endpoint = new URL(String(url), "http://localhost:3200");
    if (endpoint.pathname === "/sim/api") {
      const device = endpoint.searchParams.get("device");
      return Response.json({
        device,
        pid: 1,
        url: `http://localhost:3200/sim/helper/${device}`,
        streamUrl: `http://localhost:3200/sim/helper/${device}/stream.mjpeg`,
        wsUrl: `ws://localhost:3200/sim/helper/${device}/ws`,
      });
    }
    if (endpoint.pathname.endsWith("/grid/api")) {
      // Two simulators, both with a running helper; the server lists the other one first.
      return Response.json({
        devices: [
          { device: "PRO", name: "iPhone 17 Pro", helper: { pid: 2 } },
          { device: "PRO-MAX", name: "iPhone 17 Pro Max", helper: { pid: 1 } },
        ],
      });
    }
    return Response.json({ devices: [] });
  });
}

test("marks only the streamed simulator as current when two run a helper", async () => {
  stubBrowser();
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: "/sim", device: "PRO-MAX", streamMode: "mjpeg" });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  for (let i = 0; i < 20 && client.devices.length < 2; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }

  expect(client.devices.map(({ id, current }) => ({ id, current }))).toEqual([
    { id: "PRO", current: false },
    { id: "PRO-MAX", current: true },
  ]);
});
