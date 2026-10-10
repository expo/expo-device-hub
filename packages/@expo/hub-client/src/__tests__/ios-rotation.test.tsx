import { afterEach, expect, spyOn, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient, DeviceOrientation } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

class Socket {
  static instances: Socket[] = [];
  readyState = 1;
  sent: ArrayBuffer[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: ArrayBuffer }) => void;

  constructor(readonly url: string) {
    Socket.instances.push(this);
  }

  send(data: ArrayBuffer) {
    this.sent.push(data);
  }

  close() {}

  screen(orientation: DeviceOrientation) {
    const json = new TextEncoder().encode(
      JSON.stringify({ width: 1206, height: 2622, orientation }),
    );
    const frame = new Uint8Array(json.length + 1);
    frame[0] = 0x82;
    frame.set(json, 1);
    this.onmessage?.({ data: frame.buffer });
  }

  rotations(): DeviceOrientation[] {
    return this.sent.flatMap((data) => {
      const frame = new Uint8Array(data);
      return frame[0] === 0x07
        ? [JSON.parse(new TextDecoder().decode(frame.subarray(1))).orientation]
        : [];
    });
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
let clock: ReturnType<typeof spyOn<typeof performance, "now">> | undefined;
let now = 0;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  clock?.mockRestore();
  clock = undefined;
  restoreGlobals();
  Socket.instances = [];
});

async function mount() {
  now = 0;
  clock = spyOn(performance, "now").mockImplementation(() => now);
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
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  stubGlobal(
    "EventSource",
    class {
      close() {}
    },
  );
  stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://localhost:3200");
    if (url.pathname === "/sim/api") {
      const device = url.searchParams.get("device");
      const helper = `http://localhost:3200/sim/helper/${device}`;
      return Response.json({
        device,
        url: helper,
        streamUrl: `${helper}/stream.mjpeg`,
        wsUrl: `${helper.replace("http:", "ws:")}/ws`,
      });
    }
    return Response.json({ devices: [] });
  });
  let client!: DeviceClient;
  function Harness({ device }: { device: string }) {
    client = useIosDeviceClient({ baseUrl: "/sim", device, streamMode: "mjpeg" });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness device="DEVICE-A" />);
  });
  const helper = () => Socket.instances.filter((socket) => socket.url.includes("/helper/")).at(-1)!;
  await act(async () => helper().screen("portrait"));
  return {
    client: () => client,
    helper,
    switchDevice: (device: string) =>
      act(async () => {
        renderer!.update(<Harness device={device} />);
      }),
  };
}

test("rapid iOS rotations advance requests without optimistically changing the screen", async () => {
  const { client, helper } = await mount();
  client().rotate();
  client().rotate();
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  expect(client().screen?.orientation).toBe("portrait");
});

test("an earlier acknowledgement cannot reset a newer iOS rotation request", async () => {
  const { client, helper } = await mount();
  client().rotate();
  client().rotate();
  now = 500;
  await act(async () => helper().screen("landscape_left"));
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  expect(client().screen?.orientation).toBe("landscape_left");
});

test("iOS rotations follow external orientation again after the readback grace expires", async () => {
  const { client, helper } = await mount();
  client().rotate();
  now = 500;
  await act(async () => helper().screen("landscape_right"));
  now = 2000;
  await act(async () => helper().screen("portrait"));
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "landscape_left"]);
});

test("acknowledging the latest iOS request permits external rotation immediately", async () => {
  const { client, helper } = await mount();
  client().rotate();
  client().rotate();
  now = 500;
  await act(async () => helper().screen("portrait_upside_down"));
  now = 600;
  await act(async () => helper().screen("landscape_right"));
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down", "portrait"]);
});

test("a declined iOS pose still advances after a pause without new orientation readback", async () => {
  const { client, helper } = await mount();
  client().rotate();
  now = 5000;
  await act(async () => helper().screen("portrait"));
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test("changing the iOS helper resets pending rotation requests to its first screen config", async () => {
  const { client, helper, switchDevice } = await mount();
  client().rotate();
  client().rotate();
  const previous = helper();
  await switchDevice("DEVICE-B");
  expect(helper()).not.toBe(previous);
  await act(async () => helper().screen("landscape_right"));
  client().rotate();
  expect(helper().rotations()).toEqual(["portrait"]);
});

test("queued disconnected iOS rotations do not speculatively advance the request cursor", async () => {
  const { client, helper } = await mount();
  helper().readyState = 0;
  client().rotate();
  expect(helper().rotations()).toEqual([]);
  helper().readyState = 1;
  await act(async () => helper().onopen?.());
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "landscape_left"]);
  await act(async () => helper().screen("landscape_left"));
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "landscape_left",
    "portrait_upside_down",
  ]);
});

test.each(["unknown", "toString"])(
  "malformed orientation readback %s cannot poison iOS rotation requests",
  async (orientation) => {
    const { client, helper } = await mount();
    client().rotate();
    now = 2000;
    await act(async () => helper().screen(orientation as DeviceOrientation));
    client().rotate();
    expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
  },
);

test("a non-string orientation readback cannot throw or poison iOS rotation requests", async () => {
  const { client, helper } = await mount();
  client().rotate();
  now = 2000;
  await act(async () => helper().screen({ toString: null } as unknown as DeviceOrientation));
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});
