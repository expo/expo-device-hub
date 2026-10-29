import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient, ScreenSize } from "../types";
import {
  HINGE_DISCONNECTED_MESSAGE,
  HINGE_INVALID_COMMAND_MESSAGE,
  HINGE_NOT_CONNECTED_MESSAGE,
} from "../useIosHinge";
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

async function mount(
  initialScreen: ScreenSize | null = { ...INNER, supportsHingeAngle: true },
  { inputAdmission = false } = {},
) {
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
        pid: 1,
        execToken: "exec-token",
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
    renderer = create(<Harness device="DUO" />);
  });
  const helper = () => Socket.instances.filter((socket) => socket.url.includes("/helper/")).at(-1)!;
  if (initialScreen) await act(async () => helper().screen(initialScreen));
  const switchDevice = (device: string) =>
    act(async () => {
      renderer?.update(<Harness device={device} />);
    });
  // A pushed config from the control socket can replace the helper at the same device.
  const pushConfig = async (value: object) => {
    const control = Socket.instances.find((socket) => socket.url.endsWith("/exec-ws"))!;
    await act(async () => {
      control.onopen?.();
      control.onmessage?.({ data: JSON.stringify({ ready: true }) } as never);
    });
    const subscription = (control.sent as unknown[])
      .map((data) => JSON.parse(String(data)) as { sub?: number; path?: string })
      .find((message) => message.path?.includes("/api/events"))!;
    await act(async () =>
      control.onmessage?.({
        data: JSON.stringify({ sub: subscription.sub, data: `data: ${JSON.stringify(value)}\n\n` }),
      } as never),
    );
  };
  return { client: () => client, helper, switchDevice, pushConfig };
}

const HINGE = { ...INNER, supportsHingeAngle: true, hingeAngle: 90, hingePose: "book" } as const;

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

test("a display switch at the same size reaches the client", async () => {
  const { client, helper } = await mount(HINGE);
  expect(client().hinge?.activeScreenId).toBe(3);
  await act(async () => helper().screen({ ...HINGE, screenId: 1 }));
  expect(client().hinge?.activeScreenId).toBe(1);
  await act(async () => helper().screen({ ...HINGE, screenId: undefined }));
  expect(client().hinge?.activeScreenId).toBeUndefined();
});

test("an observation-only change reaches the client, with Table Mode availability", async () => {
  const observed = { hingeAngle: 90, physicalOrientation: "portrait", tableMode: false } as const;
  const { client, helper } = await mount({ ...HINGE, observedDeviceState: observed });
  expect(client().hinge).toMatchObject({ angle: 90, pose: "book", tableModeAvailable: true });
  await act(async () =>
    helper().screen({
      ...HINGE,
      observedDeviceState: { ...observed, hingeAngle: 180 },
      supportsPhysicalOrientation: false,
    }),
  );
  expect(client().hinge).toMatchObject({
    angle: 180,
    pose: "open",
    tableModeAvailable: true,
    supportsPhysicalOrientation: false,
  });
  await act(async () =>
    helper().screen({ ...HINGE, observedDeviceState: { ...observed, hingeAngle: 0 } }),
  );
  expect(client().hinge?.tableModeAvailable).toBe(false);
});

test("an invalid hinge command fails without a request", async () => {
  const { client, helper } = await mount();
  await act(async () => client().hinge!.setControl({ control: "angle", value: 200 }));
  await act(async () =>
    client().hinge!.setControl({ control: "pose", value: "sideways" } as never),
  );
  expect(helper().hingeRequests()).toEqual([]);
  expect(client().hinge).toMatchObject({ pending: false, error: HINGE_INVALID_COMMAND_MESSAGE });
});

test("two hinge commands stay pending until both reply, and only the newest failure shows", async () => {
  const { client, helper } = await mount();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  const [first, second] = helper().hingeRequests();
  expect(second!.requestId).toBeGreaterThan(first!.requestId);

  await act(async () => helper().frame(0x90, { requestId: second!.requestId, ok: true }));
  expect(client().hinge?.pending).toBe(true);
  // The older command fails after the newer one succeeded; its error is not shown.
  await act(async () =>
    helper().frame(0x90, { requestId: first!.requestId, ok: false, error: "older failure" }),
  );
  expect(client().hinge).toMatchObject({ pending: false, error: null });
});

test("a device change clears a pending command and its error", async () => {
  const { client, helper, switchDevice } = await mount();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  expect(client().hinge?.pending).toBe(true);
  await switchDevice("DUO-2");
  await act(async () => helper().screen({ ...INNER, supportsHingeAngle: true }));
  expect(client().hinge).toMatchObject({ pending: false, error: null });
});

test("a hinge command needs the admitted input socket", async () => {
  const { client, helper } = await mount(
    { ...INNER, supportsHingeAngle: true },
    {
      inputAdmission: true,
    },
  );
  helper().readyState = 1;
  // Before the helper admits the socket, the command fails at once and is not queued.
  await act(async () => client().hinge!.setControl({ control: "angle", value: 90 }));
  expect(helper().hingeRequests()).toEqual([]);
  expect(client().hinge?.error).toBe(HINGE_NOT_CONNECTED_MESSAGE);

  await act(async () => helper().onmessage?.({ data: new Uint8Array([0x83]).buffer }));
  await act(async () => client().hinge!.setControl({ control: "angle", value: 120 }));
  expect(helper().hingeRequests()).toEqual([
    { requestId: expect.any(Number), command: { control: "angle", value: 120 } },
  ]);
  expect(client().hinge).toMatchObject({ pending: true, error: null });
});

test("a replaced helper fails the command that has no reply", async () => {
  const { client, helper, pushConfig } = await mount();
  const first = helper();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await pushConfig({
    device: "DUO",
    pid: 2,
    execToken: "exec-token",
    inputAdmission: false,
    url: "http://localhost:3200/sim/helper/DUO",
    streamUrl: "http://localhost:3200/sim/helper/DUO/stream.mjpeg",
    wsUrl: "ws://localhost:3200/sim/helper/DUO/ws",
  });
  expect(helper()).not.toBe(first);
  await act(async () => helper().screen({ ...INNER, supportsHingeAngle: true }));
  expect(client().hinge).toMatchObject({ pending: false, error: HINGE_DISCONNECTED_MESSAGE });
  expect(helper().hingeRequests()).toEqual([]);
});

test("an observation that changes only Table Mode reaches the client", async () => {
  const observed = { hingeAngle: 80, physicalOrientation: "facedown", tableMode: false } as const;
  const { client, helper } = await mount({ ...HINGE, observedDeviceState: observed });
  expect(client().hinge).toMatchObject({ tableMode: false, pose: null });
  await act(async () =>
    helper().screen({ ...HINGE, observedDeviceState: { ...observed, tableMode: true } }),
  );
  expect(client().hinge).toMatchObject({ tableMode: true, pose: "tent" });
});

test("a disconnect after the newest command succeeded does not report an older one", async () => {
  const { client, helper } = await mount();
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  const [, newest] = helper().hingeRequests();
  await act(async () => helper().frame(0x90, { requestId: newest!.requestId, ok: true }));
  await act(async () => helper().onclose?.({ code: 1006, reason: "" }));
  expect(client().hinge).toMatchObject({ pending: false, error: null });
});
