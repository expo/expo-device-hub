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
  onclose?: (event: { code: number; reason: string }) => void;

  constructor(readonly url: string) {
    Socket.instances.push(this);
  }

  send(data: ArrayBuffer) {
    this.sent.push(data);
  }

  close() {}

  admit() {
    this.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  }

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
let queueClock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined;
let now = 0;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  clock?.mockRestore();
  clock = undefined;
  queueClock?.mockRestore();
  queueClock = undefined;
  restoreGlobals();
  Socket.instances = [];
});

async function mount({ inputAdmission = false, initialScreen = true } = {}) {
  now = 0;
  clock = spyOn(performance, "now").mockImplementation(() => now);
  queueClock = spyOn(Date, "now").mockImplementation(() => now);
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
        inputAdmission,
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
  if (initialScreen) await act(async () => helper().screen("portrait"));
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

test.each([
  [1499, "portrait_upside_down"],
  [1500, "portrait"],
] as const)("repeated deferred iOS readback at %i ms requests %s next", async (time, next) => {
  const { client, helper } = await mount();
  client().rotate();
  now = 500;
  await act(async () => helper().screen("landscape_right"));
  now = time;
  await act(async () => helper().screen("landscape_right"));
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", next]);
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

test("repeated deferred readback cannot acknowledge a newer request for the same pose", async () => {
  const { client, helper } = await mount();
  client().rotate();
  now = 500;
  await act(async () => helper().screen("landscape_right"));
  client().rotate();
  client().rotate();
  now = 600;
  await act(async () => helper().screen("landscape_right"));
  await act(async () => helper().screen("landscape_left"));
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left", "portrait_upside_down", "landscape_right", "portrait",
  ]);
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

test("a replayed iOS rotation advances the cursor before the next click or readback", async () => {
  const { client, helper } = await mount();
  helper().readyState = 0;
  client().rotate();
  expect(helper().rotations()).toEqual([]);
  helper().readyState = 1;
  await act(async () => helper().onopen?.());
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
  await act(async () => helper().screen("landscape_left"));
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
});

test("an open but unadmitted socket queues iOS rotations until admission", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  await act(async () => helper().onopen?.());
  client().rotate();
  client().rotate();
  expect(helper().sent).toEqual([]);
  await act(async () => helper().admit());
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  // The initial config can precede those requests on the server.
  await act(async () => helper().screen("portrait"));
  client().rotate();
  expect(helper().rotations().at(-1)).toBe("portrait");
});

test("refused input does not skip the first iOS pose on retry", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  const refused = helper();
  await act(async () => refused.onopen?.());
  client().rotate();
  expect(refused.rotations()).toEqual([]);
  await act(async () => refused.onclose?.({ code: 1013, reason: "busy" }));
  now = 1600; // Refused input expires before the normal reconnect.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1550)));
  const retry = helper();
  expect(retry).not.toBe(refused);
  await act(async () => {
    retry.onopen?.();
    retry.admit();
  });
  client().rotate();
  expect(retry.rotations()).toEqual(["landscape_left"]);
});

test("queued clicks advance in delivery order from the admitting screen config", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  client().rotate();
  client().rotate();
  client().rotate();
  await act(async () => helper().screen("landscape_right"));
  expect(helper().rotations()).toEqual(["portrait", "landscape_left", "portrait_upside_down"]);
  client().rotate();
  expect(helper().rotations().at(-1)).toBe("landscape_right");
});

test("expired and capacity-evicted iOS rotations do not advance the cursor", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  client().rotate();
  now = 2000;
  client().rotate();
  // The second click is then evicted by ordinary input, not another rotation.
  for (let i = 0; i < 32; i++) client().pressButton("home");
  await act(async () => helper().admit());
  expect(helper().rotations()).toEqual([]);
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left"]);
});

test("a failed iOS rotation send leaves the cursor unchanged", async () => {
  const { client, helper } = await mount();
  const send = helper().send.bind(helper());
  helper().send = () => {
    throw new Error("send failed");
  };
  expect(() => client().rotate()).toThrow("send failed");
  helper().send = send;
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left"]);
});

test("a partial queued flush does not apply a successfully sent rotation twice", async () => {
  const { client, helper } = await mount();
  helper().readyState = 0;
  client().rotate();
  client().rotate();
  const send = helper().send.bind(helper());
  let attempts = 0;
  helper().send = (data) => {
    if (++attempts === 2) throw new Error("send failed");
    send(data);
  };
  helper().readyState = 1;
  expect(() => helper().onopen?.()).toThrow("send failed");
  expect(helper().rotations()).toEqual(["landscape_left"]);
  helper().send = send;
  client().rotate();
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
});

test("changing devices discards queued rotations instead of advancing the new cursor", async () => {
  const { client, helper, switchDevice } = await mount({
    inputAdmission: true,
    initialScreen: false,
  });
  client().rotate();
  client().rotate();
  await switchDevice("DEVICE-B");
  await act(async () => helper().screen("landscape_right"));
  expect(helper().rotations()).toEqual([]);
  client().rotate();
  expect(helper().rotations()).toEqual(["portrait"]);
});

test("legacy helpers still deliver queued rotations on open without admission frames", async () => {
  const { client, helper } = await mount({ initialScreen: false });
  client().rotate();
  expect(helper().rotations()).toEqual([]);
  await act(async () => helper().onopen?.());
  client().rotate();
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
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
