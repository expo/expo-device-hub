import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient, ScreenSize } from "../types";
import { HINGE_DISCONNECTED_MESSAGE, HINGE_NOT_CONNECTED_MESSAGE } from "../useIosHinge";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const INNER = { width: 2007, height: 2853, orientation: "portrait", screenId: 3 } as const;
const OUTER = { width: 1398, height: 2034, orientation: "portrait", screenId: 1 } as const;

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

  frame(tag: number, payload: object) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const frame = new Uint8Array(json.length + 1);
    frame[0] = tag;
    frame.set(json, 1);
    this.onmessage?.({ data: frame.buffer });
  }

  screen(config: ScreenSize) {
    this.frame(0x82, config);
  }

  hingeRequests(): { requestId: number; command: unknown }[] {
    return this.sent.flatMap((data) => {
      const frame = new Uint8Array(data);
      return frame[0] === 0x10 ? [JSON.parse(new TextDecoder().decode(frame.subarray(1)))] : [];
    });
  }
}

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
  Socket.instances = [];
});

async function mount(initialScreen: ScreenSize | null = { ...INNER, supportsHingeAngle: true }) {
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
        inputAdmission: false,
      });
    }
    return Response.json({ devices: [] });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: "/sim", device: "DUO", streamMode: "mjpeg" });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  const helper = () => Socket.instances.filter((socket) => socket.url.includes("/helper/")).at(-1)!;
  if (initialScreen) await act(async () => helper().screen(initialScreen));
  return { client: () => client, helper };
}

test("a device without a hinge has no hinge controls", async () => {
  const { client } = await mount({ width: 1206, height: 2622, orientation: "portrait" });
  expect(client().hinge).toBeNull();
});

test("a hinge move that keeps the screen size reaches the client", async () => {
  const { client, helper } = await mount({
    ...INNER,
    supportsHingeAngle: true,
    hingeAngle: 180,
    hingePose: "open",
    physicalOrientation: "portrait",
    tableMode: false,
  });
  expect(client().hinge).toMatchObject({ angle: 180, pose: "open", activeScreenId: 3 });

  await act(async () =>
    helper().screen({
      ...INNER,
      supportsHingeAngle: true,
      hingeAngle: 90,
      hingePose: "book",
      physicalOrientation: "portrait",
      tableMode: false,
    }),
  );
  expect(client().screen?.hingeAngle).toBe(90);
  expect(client().hinge).toMatchObject({ angle: 90, pose: "book", activeScreenId: 3 });

  await act(async () =>
    helper().screen({ ...OUTER, supportsHingeAngle: true, hingeAngle: 0, hingePose: "closed" }),
  );
  expect(client().hinge).toMatchObject({ angle: 0, pose: "closed", activeScreenId: 1 });
});

test("the native observation replaces the last command, and names the pose it matches", async () => {
  const { client, helper } = await mount({
    ...INNER,
    supportsHingeAngle: true,
    hingeAngle: 180,
    hingePose: "open",
    observedDeviceState: {
      hingeAngle: 90,
      physicalOrientation: "landscape-left",
      tableMode: false,
    },
  });
  expect(client().hinge).toMatchObject({
    angle: 90,
    pose: "laptop",
    physicalOrientation: "landscape-left",
  });

  // Another client moved the hinge to an angle that no preset has.
  await act(async () =>
    helper().screen({
      ...INNER,
      supportsHingeAngle: true,
      hingeAngle: 180,
      hingePose: "open",
      observedDeviceState: { hingeAngle: 120, physicalOrientation: "portrait", tableMode: false },
    }),
  );
  expect(client().hinge).toMatchObject({ angle: 120, pose: null });
});

test("a hinge command waits for the reply with its request ID", async () => {
  const { client, helper } = await mount();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  const [request] = helper().hingeRequests();
  expect(request).toEqual({
    requestId: expect.any(Number),
    command: { control: "pose", value: "laptop" },
  });
  expect(client().hinge?.pending).toBe(true);

  // A reply to another request does not settle this one.
  await act(async () => helper().frame(0x90, { requestId: request!.requestId + 100, ok: true }));
  expect(client().hinge?.pending).toBe(true);

  await act(async () => helper().frame(0x90, { requestId: request!.requestId, ok: true }));
  expect(client().hinge).toMatchObject({ pending: false, error: null });
});

test("a failed hinge command shows the helper's error until the next command", async () => {
  const { client, helper } = await mount();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "tent" }));
  const [request] = helper().hingeRequests();
  await act(async () =>
    helper().frame(0x90, {
      requestId: request!.requestId,
      ok: false,
      error: "Simulator could not change the device pose.",
    }),
  );
  expect(client().hinge).toMatchObject({
    pending: false,
    error: "Simulator could not change the device pose.",
  });

  await act(async () => client().hinge!.setControl({ control: "angle", value: 45 }));
  expect(client().hinge).toMatchObject({ pending: true, error: null });
});

test("a disconnect fails the command without a reply and does not send it again", async () => {
  const { client, helper } = await mount();
  const first = helper();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await act(async () => first.onclose?.({ code: 1006, reason: "" }));
  expect(client().hinge).toMatchObject({ pending: false, error: HINGE_DISCONNECTED_MESSAGE });
  for (const socket of Socket.instances.filter((socket) => socket !== first)) {
    expect(socket.hingeRequests()).toEqual([]);
  }
});

test("a hinge command without an open input socket fails at once", async () => {
  const { client, helper } = await mount();
  helper().readyState = 3;
  await act(async () => client().hinge!.setControl({ control: "pose", value: "closed" }));
  expect(helper().hingeRequests()).toEqual([]);
  expect(client().hinge).toMatchObject({ pending: false, error: HINGE_NOT_CONNECTED_MESSAGE });
});
