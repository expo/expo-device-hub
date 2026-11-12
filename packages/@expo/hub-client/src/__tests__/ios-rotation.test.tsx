import { afterEach, expect, spyOn, test } from "bun:test";
import { StrictMode } from "react";
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

  screen(orientation: DeviceOrientation, extra: Record<string, unknown> = {}) {
    const json = new TextEncoder().encode(
      JSON.stringify({ width: 1206, height: 2622, orientation, ...extra }),
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

async function mount({ inputAdmission = false, initialScreen = true, strict = false } = {}) {
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
    renderer = create(
      strict ? (
        <StrictMode>
          <Harness device="DEVICE-A" />
        </StrictMode>
      ) : (
        <Harness device="DEVICE-A" />
      ),
    );
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

test("each iOS Rotate shows the next pose at once without changing the screen", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  expect(client().screen?.orientation).toBe("portrait");
  expect(client().orientation).toBe("landscape_right");
});

test("an earlier acknowledgement cannot reset a newer iOS rotation request", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  now = 500;
  await act(async () => helper().screen("landscape_left"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  expect(client().screen?.orientation).toBe("landscape_left");
});

test("iOS rotations follow external orientation again after the readback grace expires", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  now = 500;
  await act(async () => helper().screen("landscape_right"));
  now = 2000;
  await act(async () => helper().screen("portrait"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "landscape_left"]);
});

test("acknowledging the latest iOS request permits external rotation immediately", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  now = 500;
  await act(async () => helper().screen("portrait_upside_down"));
  now = 600;
  await act(async () => helper().screen("landscape_right"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down", "portrait"]);
});

test("repeated deferred readback cannot acknowledge a newer request for the same pose", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  now = 500;
  await act(async () => helper().screen("landscape_right"));
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  now = 600;
  await act(async () => helper().screen("landscape_right"));
  await act(async () => helper().screen("landscape_left"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
    "portrait",
  ]);
});

test("a declined iOS pose still advances after a pause without new orientation readback", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  now = 5000;
  await act(async () => helper().screen("portrait"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test("changing the iOS helper resets pending rotation requests to its first screen config", async () => {
  const { client, helper, switchDevice } = await mount();
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  const previous = helper();
  await switchDevice("DEVICE-B");
  expect(helper()).not.toBe(previous);
  await act(async () => helper().screen("landscape_right"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["portrait"]);
});

test("a replayed iOS rotation advances the cursor before the next click or readback", async () => {
  const { client, helper } = await mount();
  helper().readyState = 0;
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([]);
  helper().readyState = 1;
  await act(async () => helper().onopen?.());
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
  await act(async () => helper().screen("landscape_left"));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
});

test("an open but unadmitted socket queues iOS rotations until admission", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  await act(async () => helper().onopen?.());
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  expect(helper().sent).toEqual([]);
  await act(async () => helper().admit());
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([
    "landscape_left",
    "portrait_upside_down",
    "landscape_right",
  ]);
  // The initial config can precede those requests on the server.
  await act(async () => helper().screen("portrait"));
  await act(async () => client().rotate());
  expect(helper().rotations().at(-1)).toBe("portrait");
});

test("refused input does not skip the first iOS pose on retry", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  const refused = helper();
  await act(async () => refused.onopen?.());
  await act(async () => client().rotate());
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
  await act(async () => client().rotate());
  expect(retry.rotations()).toEqual(["landscape_left"]);
});

test("queued clicks wait for the explicit admission frame, and the newest one wins", async () => {
  const { client, helper } = await mount({ inputAdmission: true, initialScreen: false });
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  await act(async () => helper().screen("landscape_right"));
  expect(helper().rotations()).toEqual([]);
  expect(client().orientationPending).toBe(true);
  await act(async () => helper().admit());
  // The first click was already in the input queue; later clicks replace each other.
  expect(helper().rotations()).toEqual(["landscape_left", "landscape_right"]);
  await act(async () => client().rotate());
  expect(helper().rotations().at(-1)).toBe("portrait");
});

test("changing devices discards queued rotations instead of advancing the new cursor", async () => {
  const { client, helper, switchDevice } = await mount({
    inputAdmission: true,
    initialScreen: false,
  });
  await act(async () => client().rotate());
  await act(async () => client().rotate());
  await switchDevice("DEVICE-B");
  await act(async () => helper().screen("landscape_right"));
  expect(helper().rotations()).toEqual([]);
  await act(async () => helper().admit());
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["portrait"]);
});

test("legacy helpers still deliver queued rotations on open without admission frames", async () => {
  const { client, helper } = await mount({ initialScreen: false });
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual([]);
  await act(async () => helper().onopen?.());
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test.each(["unknown", "toString"])(
  "malformed orientation readback %s cannot poison iOS rotation requests",
  async (orientation) => {
    const { client, helper } = await mount();
    await act(async () => client().rotate());
    now = 2000;
    await act(async () => helper().screen(orientation as DeviceOrientation));
    await act(async () => client().rotate());
    expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
  },
);

test("a non-string orientation readback cannot throw or poison iOS rotation requests", async () => {
  const { client, helper } = await mount();
  await act(async () => client().rotate());
  now = 2000;
  await act(async () => helper().screen({ toString: null } as unknown as DeviceOrientation));
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test("an iOS orientation choice sends that pose and Rotate continues from it", async () => {
  const { client, helper } = await mount();
  expect(client().capabilities.orientation).toEqual({
    orientations: ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"],
  });
  await act(async () => client().setOrientation("landscape_right"));
  // The choice shows at once; the screen keeps the helper's readback.
  expect(client().orientation).toBe("landscape_right");
  expect(client().orientationPending).toBe(false);
  expect(client().screen?.orientation).toBe("portrait");
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_right", "portrait"]);

  expect(client().orientation).toBe("portrait");
  // The readback of the older choice does not replace the newer one.
  await act(async () => helper().screen("landscape_right"));
  expect(client().orientation).toBe("portrait");
  await act(async () => helper().screen("portrait"));
  expect(client().orientation).toBe("portrait");
});

test("a queued iOS orientation choice is pending until the helper admits input", async () => {
  const { client, helper } = await mount({ inputAdmission: true });
  await act(async () => client().setOrientation("portrait_upside_down"));
  expect(helper().rotations()).toEqual([]);
  expect(client().orientationPending).toBe(true);
  expect(client().orientation).toBe("portrait_upside_down");
  await act(async () => helper().admit());
  expect(client().orientationPending).toBe(false);
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["portrait_upside_down", "landscape_right"]);
});

test("an iOS orientation choice that the input queue does not send in 2 s fails", async () => {
  const { client, helper } = await mount({ inputAdmission: true });
  await act(async () => client().setOrientation("landscape_left"));
  expect(client().orientationPending).toBe(true);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2_100)));
  expect(helper().rotations()).toEqual([]);
  expect(client().orientationPending).toBe(false);
  expect(client().orientationError).toContain("was not sent");
  expect(client().orientation).toBe("portrait");
});

test("an iOS client without a connection offers no orientations and ignores a choice", async () => {
  await mount();
  let disabled!: DeviceClient;
  function Disabled() {
    disabled = useIosDeviceClient({
      baseUrl: "/sim",
      device: "DEVICE-A",
      enabled: false,
      streamMode: "mjpeg",
    });
    return null;
  }
  await act(async () => {
    renderer!.update(<Disabled />);
  });
  expect(disabled.capabilities.orientation).toBe(false);
  await act(async () => disabled.setOrientation("landscape_left"));
  expect(disabled.orientationPending).toBe(false);
  expect(disabled.orientation).toBeNull();
  expect(disabled.orientationError).toBeNull();
});

const liveImage = {
  naturalWidth: 1170,
  naturalHeight: 2532,
  addEventListener() {},
  removeEventListener() {},
  removeAttribute() {},
};

async function streamVideo(client: () => DeviceClient) {
  await act(async () => client().attachVideo(liveImage as unknown as HTMLImageElement));
  // The stream effect checks the image every 400 ms; wait for two checks under load.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 850)));
}

test("iOS orientation follows the input socket, not the video: no video, admitted input", async () => {
  const { client, helper } = await mount();
  expect(client().status).toBe("connecting");
  expect(client().orientationUnavailable).toBeNull();
  await act(async () => client().setOrientation("landscape_left"));
  expect(helper().rotations()).toEqual(["landscape_left"]);
});

test("iOS orientation follows the input socket, not the video: live video, input unavailable", async () => {
  const { client, helper } = await mount();
  await streamVideo(client);
  expect(client().status).toBe("streaming");
  expect(client().orientationUnavailable).toBeNull();
  await act(async () => helper().screen("portrait", { inputUnavailable: true }));
  expect(client().status).toBe("streaming");
  expect(client().orientationUnavailable).toBe("input-unavailable");
  await act(async () => helper().screen("portrait"));
  expect(client().orientationUnavailable).toBeNull();
});

test("iOS orientation is unavailable until the helper admits input, and after a disconnect", async () => {
  const { client, helper } = await mount({ inputAdmission: true });
  expect(client().orientationUnavailable).toBe("input-unavailable");
  await act(async () => helper().admit());
  expect(client().orientationUnavailable).toBeNull();
  await act(async () => helper().onclose?.({ code: 1006, reason: "" }));
  expect(client().orientationUnavailable).toBe("input-unavailable");
});

test("an iOS orientation choice is still sent under Strict Mode, which runs effects twice", async () => {
  const { client, helper } = await mount({ strict: true });
  await act(async () => client().setOrientation("landscape_right"));
  expect(helper().rotations()).toEqual(["landscape_right"]);
});

test("ordinary-device controls follow observed pose independently of a portrait-only app", async () => {
  const { client, helper } = await mount();
  await act(async () =>
    helper().screen("landscape_right", {
      supportsHingeAngle: false,
      screenOrientation: "portrait",
      deviceOrientation: "landscape-left",
    }),
  );
  expect(client().orientation).toBe("landscape_left");
  expect(client().screen?.orientation).toBe("portrait");
  expect(client().screen?.deviceOrientation).toBe("landscape-left");
  await act(async () =>
    client().sendTouch({ phase: "begin", x: 0.2, y: 0.4, edgeGestures: false }),
  );
  const touch = helper()
    .sent.map((frame) => new Uint8Array(frame))
    .find((frame) => frame[0] === 0x03)!;
  const point = JSON.parse(new TextDecoder().decode(touch.subarray(1)));
  expect(point.x).toBeCloseTo(0.6);
  expect(point.y).toBeCloseTo(0.2);
  await act(async () => client().setOrientation("landscape_left"));
  expect(helper().rotations().at(-1)).toBe("landscape_right");
  now = 2000;
  await act(async () =>
    helper().screen("landscape_right", {
      supportsHingeAngle: false,
      screenOrientation: "portrait",
      deviceOrientation: "portrait",
    }),
  );
  expect(client().orientation).toBe("portrait");
  await act(async () =>
    helper().screen("landscape_right", {
      supportsHingeAngle: false,
      screenOrientation: "portrait",
      deviceOrientation: null,
    }),
  );
  // An unknown pose leaves the controls to the legacy readback.
  expect(client().orientation).toBe("landscape_right");
});

test("Rotate follows the legacy readback while the native pose stays unknown", async () => {
  const { client, helper } = await mount();
  const unknownPose = {
    supportsHingeAngle: false,
    screenOrientation: "portrait",
    deviceOrientation: null,
  };
  await act(async () => helper().screen("portrait", unknownPose));
  expect(client().orientation).toBe("portrait");
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left"]);
  now = 2000;
  await act(async () => helper().screen("landscape_left", unknownPose));
  expect(client().orientation).toBe("landscape_left");
  await act(async () => client().rotate());
  expect(helper().rotations()).toEqual(["landscape_left", "portrait_upside_down"]);
});

test("Duo Rotate advances from observed pose when Home stays portrait", async () => {
  const { client, helper } = await mount();
  await act(async () =>
    helper().screen("portrait", {
      supportsHingeAngle: true,
      supportsPhysicalOrientation: true,
      screenOrientation: "portrait",
      deviceOrientation: "landscape-left",
      observedDeviceState: { hingeAngle: 0, physicalOrientation: "landscape-left" },
    }),
  );
  expect(client().orientation).toBe("landscape_left");
  const turns: number[] = [];
  const stop = client().fold?.observe?.((event) => {
    if (event.type === "rotated") turns.push(event.quarterTurns);
  });
  await act(async () => client().rotate());
  expect(helper().rotations().at(-1)).toBe("portrait_upside_down");
  expect(turns).toEqual([1]);
  stop?.();
});

test("observed Duo keeps its clockwise physical turn from portrait", async () => {
  const { client, helper } = await mount();
  await act(async () =>
    helper().screen("portrait", {
      supportsHingeAngle: true,
      supportsPhysicalOrientation: true,
      screenOrientation: "portrait",
      deviceOrientation: "portrait",
    }),
  );
  const turns: number[] = [];
  const stop = client().fold?.observe?.((event) => {
    if (event.type === "rotated") turns.push(event.quarterTurns);
  });
  await act(async () => client().rotate());
  expect(client().orientation).toBe("landscape_left");
  expect(turns).toEqual([1]);
  stop?.();
});

test("external Duo turns update the model without sending a rotation back", async () => {
  const { client, helper } = await mount();
  const config = {
    supportsHingeAngle: true,
    supportsPhysicalOrientation: true,
    screenOrientation: "portrait",
    deviceOrientation: "portrait",
  };
  await act(async () => helper().screen("portrait", config));
  const turns: number[] = [];
  const stop = client().fold?.observe?.((event) => {
    if (event.type === "rotated") turns.push(event.quarterTurns);
  });
  await act(async () =>
    helper().screen("portrait", { ...config, deviceOrientation: "landscape-left" }),
  );
  expect(turns).toEqual([1]);
  expect(helper().rotations()).toEqual([]);
  await act(async () => client().rotate());
  expect(turns).toEqual([1, 1]);
  await act(async () => helper().screen("portrait", { ...config, deviceOrientation: "pud" }));
  expect(turns).toEqual([1, 1]);
  stop?.();
});

for (const [actual, correction] of [
  ["landscape-right", 2],
  ["portrait", -1],
] as const) {
  test(`Duo reconciles native ${actual} after the local rotation grace`, async () => {
    const { client, helper } = await mount();
    const config = {
      supportsHingeAngle: true,
      supportsPhysicalOrientation: true,
      deviceOrientation: "portrait",
      observedDeviceState: { hingeAngle: 0, physicalOrientation: "portrait", tableMode: false },
    };
    await act(async () => helper().screen("portrait", config));
    const turns: number[] = [];
    const stop = client().fold?.observe?.((event) => {
      if (event.type === "rotated") turns.push(event.quarterTurns);
    });
    await act(async () => client().rotate());
    const readback = {
      ...config,
      deviceOrientation: actual,
      observedDeviceState: { ...config.observedDeviceState, physicalOrientation: actual },
    };
    await act(async () => helper().screen("portrait", readback));
    expect(turns).toEqual([1]);
    now = 2000;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1600));
    });
    expect(turns).toEqual([1, correction]);
    await act(async () => helper().screen("portrait", readback));
    expect(turns).toEqual([1, correction]);
    stop?.();
  });
}

test("observed Duo choices target physical poses on both panels", async () => {
  const { client, helper } = await mount();
  for (const screenId of [1, 3]) {
    await act(async () =>
      helper().screen("portrait", {
        screenId,
        supportsHingeAngle: true,
        supportsPhysicalOrientation: true,
        screenOrientation: "portrait",
        deviceOrientation: "portrait",
      }),
    );
    for (const [choice, physical] of [
      ["portrait", "portrait"],
      ["portrait_upside_down", "pud"],
      ["landscape_left", "landscape-left"],
      ["landscape_right", "landscape-right"],
    ] as const) {
      await act(async () => client().setOrientation(choice));
      const frame = helper()
        .sent.filter((data) => new Uint8Array(data)[0] === 0x07)
        .at(-1)!;
      expect(
        JSON.parse(new TextDecoder().decode(new Uint8Array(frame).subarray(1))).deviceOrientation,
      ).toBe(physical);
    }
  }
});

test("portrait-locked landscape home swipes retain the interface edge through release", async () => {
  const { client, helper } = await mount();
  await act(async () =>
    helper().screen("landscape_right", {
      supportsHingeAngle: false,
      screenOrientation: "portrait",
      deviceOrientation: "landscape-left",
    }),
  );
  await act(async () => {
    client().sendTouch({ phase: "begin", x: 0.99, y: 0.5 });
    client().sendTouch({ phase: "move", x: 0.7, y: 0.5 });
    client().sendTouch({ phase: "end", x: 0.6, y: 0.5 });
    client().sendTouch({ phase: "begin", x: 0.5, y: 0.99 });
    client().sendTouch({ phase: "end", x: 0.5, y: 0.99 });
  });
  const touches = helper()
    .sent.map((frame) => new Uint8Array(frame))
    .filter((frame) => frame[0] === 0x03)
    .map((frame) => JSON.parse(new TextDecoder().decode(frame.subarray(1))));
  expect(touches.slice(0, 3).map((touch) => touch.edge)).toEqual([3, 3, 3]);
  expect(touches[0].x).toBeCloseTo(0.5);
  expect(touches[0].y).toBeCloseTo(0.99);
  expect(touches.slice(3).map((touch) => touch.edge)).toEqual([undefined, undefined]);
});
