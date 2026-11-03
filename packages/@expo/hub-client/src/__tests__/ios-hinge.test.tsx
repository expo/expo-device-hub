import { afterEach, expect, test } from "bun:test";
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { duoPresetView, duoRotateView } from "../duo/duo-view";
import { type DeviceClient, type DeviceConnectionOptions } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

/** The helper's binary input socket: `[tag][JSON]` both ways. Exec-ws sends text. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  texts: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: ArrayBuffer | string) {
    if (typeof data === "string") this.texts.push(data);
    else this.sent.push(new Uint8Array(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(tag: number, payload: unknown) {
    const json = new TextEncoder().encode(JSON.stringify(payload));
    const bytes = new Uint8Array(1 + json.length);
    bytes[0] = tag;
    bytes.set(json, 1);
    this.onmessage?.({ data: bytes.buffer });
  }
  frames() {
    return this.sent.map((bytes) => ({
      tag: bytes[0],
      payload: JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as Record<string, unknown>,
    }));
  }
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  FakeSocket.instances = [];
  apiExtra = {};
  restoreGlobals();
});

// Xcode 27.1's DeviceKit profiles for the Duo: the cover is the primary, the inner display a variant.
const DUO_CHROME = {
  identifier: "phone15",
  screen: { x: 34, y: 23, width: 466, height: 678 },
  screenRadius: 33.5,
  screenCornerRadii: { topLeft: 8, topRight: 59, bottomRight: 59, bottomLeft: 8 },
  screenId: 1,
  displayVariants: {
    3: {
      identifier: "phone14",
      screen: { x: 27, y: 27, width: 626, height: 890 },
      screenRadius: 51.5,
      screenCornerRadii: { topLeft: 51.5, topRight: 51.5, bottomRight: 51.5, bottomLeft: 51.5 },
      screenId: 3,
    },
  },
};

const COVER = {
  width: 1398,
  height: 2034,
  orientation: "portrait",
  screenId: 1,
  supportsHingeAngle: true,
  hingeAngle: 0,
  hingePose: "closed",
  tableMode: false,
  tableModeAvailable: false,
};
const INNER_OPEN = {
  ...COVER,
  width: 2007,
  height: 2853,
  screenId: 3,
  hingeAngle: 180,
  hingePose: "open",
  tableModeAvailable: true,
};

/** Extra `/api` fields, such as an exec-ws token and a helper pid. */
let apiExtra: Record<string, unknown> = {};

/** Holds device-2's `/api` answer so a test can observe the switch before it resolves. */
const gate: { hold: boolean; release: (() => void) | null } = { hold: false, release: null };

function previewApi(device: string, foldable: boolean) {
  return {
    url: `https://hub.test/helper/${device}`,
    wsUrl: `wss://hub.test/helper/${device}/ws`,
    device,
    basePath: "/",
    gridApiEndpoint: "/grid/api",
    chrome: foldable
      ? DUO_CHROME
      : { identifier: "phone17pro", screen: { width: 402, height: 874 }, screenRadius: 62 },
    ...apiExtra,
  };
}

function installBrowser({ duo }: { duo: boolean }) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: {
      href: "http://localhost:8081/index",
      origin: "http://localhost:8081",
      protocol: "http:",
      host: "localhost:8081",
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", FakeSocket);
  stubGlobal("fetch", async (url: string) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/api") {
      // device-1 is the Duo under test (or a plain iPhone); device-2 is always a plain iPhone.
      const device = searchParams.get("device") ?? "device-1";
      const foldable = duo && device === "device-1";
      if (device === "device-2" && gate.hold) {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
      return Response.json(previewApi(device, foldable));
    }
    if (pathname === "/grid/api") {
      return Response.json({
        devices: [
          { device: "device-1", name: duo ? "iPhone Duo" : "iPhone 17 Pro", helper: {} },
          { device: "device-2", name: "iPhone 17 Pro", helper: {} },
        ],
      });
    }
    return Response.json({}, { status: 404 });
  });
}

async function connect(options: Partial<DeviceConnectionOptions> = {}) {
  let client!: DeviceClient;
  function Harness(props: Partial<DeviceConnectionOptions>) {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "device-1",
      enabled: true,
      streamMode: "mjpeg",
      ...props,
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness {...options} />);
  });
  await act(async () => {});
  const socket = FakeSocket.instances.find((instance) => instance.url.includes("/helper/ws"));
  if (!socket) throw new Error("The hook did not open the helper input socket");
  await act(async () => socket.open());
  return {
    socket,
    client: () => client,
    update: (props: Partial<DeviceConnectionOptions>) =>
      act(async () => renderer!.update(<Harness {...options} {...props} />)),
  };
}

test("a device without a hinge exposes no hinge state and rotates counterclockwise", async () => {
  installBrowser({ duo: false });
  const { socket, client } = await connect();
  await act(async () =>
    socket.push(0x82, { width: 1206, height: 2622, orientation: "portrait", screenId: 1 }),
  );
  expect(client().hinge).toBeNull();
  expect(client().screen?.screenId).toBe(1);
  // Only the Duo trades the generic iPhone shape for its own glass corners.
  expect(client().displayCorners).toBeNull();
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({ tag: 0x07, payload: { orientation: "landscape_left" } });
});

test("the flat view gets the active display's glass corners, turned with the device", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // Before the first config the cover profile applies.
  expect(client().displayCorners).toEqual({
    topLeft: 8 / 466,
    topRight: 59 / 466,
    bottomRight: 59 / 466,
    bottomLeft: 8 / 466,
  });
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().displayCorners).toEqual({
    topLeft: 51.5 / 626,
    topRight: 51.5 / 626,
    bottomRight: 51.5 / 626,
    bottomLeft: 51.5 / 626,
  });
  await act(async () => socket.push(0x82, { ...COVER, orientation: "landscape_right" }));
  expect(client().displayCorners).toEqual({
    topLeft: 59 / 678,
    topRight: 59 / 678,
    bottomRight: 8 / 678,
    bottomLeft: 8 / 678,
  });
  // Landscape dimensions without an orientation field still turn the corners.
  await act(async () =>
    socket.push(0x82, { ...COVER, width: 2034, height: 1398, orientation: undefined }),
  );
  expect(client().displayCorners).toEqual({
    topLeft: 8 / 678,
    topRight: 8 / 678,
    bottomRight: 59 / 678,
    bottomLeft: 59 / 678,
  });
});

test("the Duo reports its hinge from the pushed screen config and keeps the flat stream by default", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // DeviceKit's cover chrome identifies the Duo before native capability metadata.
  expect(client().hinge).not.toBeNull();
  expect(client().hinge?.angle).toBeUndefined();
  expect(client().hinge?.supported).toBeUndefined();
  await act(async () => socket.push(0x82, COVER));
  const hinge = client().hinge!;
  expect(hinge.supported).toBe(true);
  expect(hinge.angle).toBe(0);
  expect(hinge.pose).toBe("closed");
  expect(hinge.tableMode).toBe(false);
  expect(hinge.activeScreenId).toBe(1);
  expect(hinge.pending).toBe(false);
  expect(hinge.modelActive).toBe(false);
  expect(hinge.panels).toBeNull();
  expect(hinge.modelUrl).toBe("https://hub.test/grid/api/devicekit-model");
  expect(client().screen?.supportsHingeAngle).toBe(true);
});

test("pose commands go out acknowledged on the input socket and preview until the config confirms them", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x10,
    payload: { requestId: 1, command: { control: "pose", value: "open" } },
  });
  expect(client().hinge?.pending).toBe(true);
  expect(client().hinge?.angle).toBe(180);
  expect(client().hinge?.pose).toBe("open");
  expect(client().hinge?.activeScreenId).toBe(3);

  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  expect(client().hinge?.pending).toBe(false);
  // The preview holds until the helper's config catches up, so nothing animates backwards.
  expect(client().hinge?.angle).toBe(180);
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().hinge?.angle).toBe(180);
  expect(client().hinge?.pose).toBe("open");
  expect(client().hinge?.tableModeAvailable).toBe(true);
  expect(client().screen?.screenId).toBe(3);
});

test("a fold made with the Simulator's own controls shows, though the command fields stay", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  const observedOpen = {
    ...INNER_OPEN,
    physicalOrientation: "portrait",
    observedDeviceState: { hingeAngle: 180, physicalOrientation: "portrait", tableMode: false },
  };
  await act(async () => socket.push(0x82, observedOpen));
  expect(client().hinge?.pose).toBe("open");
  // Only the observation changes: the helper keeps its last command in the top-level fields.
  await act(async () =>
    socket.push(0x82, {
      ...observedOpen,
      observedDeviceState: {
        hingeAngle: 90,
        physicalOrientation: "landscape-left",
        tableMode: false,
      },
    }),
  );
  expect(client().hinge?.angle).toBe(90);
  expect(client().hinge?.pose).toBe("laptop");
  expect(client().hinge?.physicalPose).toBe("laptop");
  // A field that the native reader omits is unknown, not the saved command's value.
  await act(async () =>
    socket.push(0x82, { ...observedOpen, observedDeviceState: { hingeAngle: 120 } }),
  );
  expect(client().hinge?.angle).toBe(120);
  expect(client().hinge?.pose).toBeUndefined();
  expect(client().hinge?.tableMode).toBeUndefined();
  expect(client().hinge?.tableModeAvailable).toBeUndefined();
});

for (const preset of ["tent", "laptop"] as const) {
  test(`another client's ${preset} preset after Closed frames the 3D model as ${preset}`, async () => {
    installBrowser({ duo: true });
    const { socket, client } = await connect();
    await act(async () => socket.push(0x82, COVER));
    const closedView = client().hinge!.view;
    const presetView = duoPresetView(preset);
    expect(closedView).not.toEqual(presetView);
    const angle = preset === "tent" ? 80 : 90;
    await act(async () =>
      socket.push(0x82, {
        ...INNER_OPEN,
        hingeAngle: angle,
        hingePose: preset,
        tableMode: preset === "tent",
        physicalOrientation: preset === "tent" ? "facedown" : "landscape-left",
      }),
    );
    expect(client().hinge?.physicalPose).toBe(preset);
    expect(client().hinge?.view).toEqual(presetView);
  });
}

test("a readback that still lags a local preset does not undo its framing", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  const observedClosed = {
    ...COVER,
    physicalOrientation: "portrait",
    observedDeviceState: { hingeAngle: 0, physicalOrientation: "portrait", tableMode: false },
  };
  await act(async () => socket.push(0x82, observedClosed));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  const laptopView = client().hinge!.view;
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  // The command's config confirms Laptop while the native readback still says Closed.
  await act(async () =>
    socket.push(0x82, {
      ...observedClosed,
      ...INNER_OPEN,
      hingeAngle: 90,
      hingePose: "laptop",
      physicalOrientation: "landscape-left",
    }),
  );
  expect(client().hinge?.physicalPose).toBe("laptop");
  expect(client().hinge?.view).toEqual(laptopView);
});

test("a Rotate holds the view until it lands; then a preset from the Simulator frames the model", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // The helper keeps the last command, Open, in the top-level fields throughout.
  const open = {
    ...INNER_OPEN,
    physicalOrientation: "portrait",
    observedDeviceState: { hingeAngle: 180, physicalOrientation: "portrait", tableMode: false },
  };
  await act(async () => socket.push(0x82, open));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  // Before the rotation lands, an unchanged observation keeps the turned view.
  await act(async () => socket.push(0x82, { ...open }));
  expect(client().hinge?.view).toEqual(rotatedView);
  // The observation reports the turn, which no preset matches.
  await act(async () =>
    socket.push(0x82, {
      ...open,
      observedDeviceState: {
        hingeAngle: 180,
        physicalOrientation: "landscape-left",
        tableMode: false,
      },
    }),
  );
  expect(client().hinge?.view).toEqual(rotatedView);
  // The Simulator's own controls then select Laptop.
  await act(async () =>
    socket.push(0x82, {
      ...open,
      observedDeviceState: {
        hingeAngle: 90,
        physicalOrientation: "landscape-left",
        tableMode: false,
      },
    }),
  );
  expect(client().hinge?.physicalPose).toBe("laptop");
  expect(client().hinge?.view).toEqual(duoPresetView("laptop"));
});

test("an angle edit after Table Mode goes out after it, so the last action wins", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().hinge!.setControl({ control: "angle", value: 100 }));
  await act(async () => client().hinge!.setControl({ control: "angle", value: 110 }));
  await act(async () => client().hinge!.setControl({ control: "table", value: true }));
  await act(async () => client().hinge!.setControl({ control: "angle", value: 120 }));
  // An angle edit releases Table Mode, so the preview shows it off.
  expect(client().hinge?.tableMode).toBe(false);
  for (const requestId of [1, 2, 3]) {
    await act(async () => socket.push(0x90, { requestId, ok: true }));
  }
  const commands = socket
    .frames()
    .filter((frame) => frame.tag === 0x10)
    .map((frame) => frame.payload.command);
  expect(commands).toEqual([
    { control: "angle", value: 100 },
    { control: "table", value: true },
    { control: "angle", value: 120 },
  ]);
});

test("switching to another simulator forgets the previous screen config at once", async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect({ duoPreview: "3d" });
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(client().hinge?.modelActive).toBe(true);

  gate.hold = true;
  await update({ device: "device-2" });
  await act(async () => {});
  // Before the new device's config resolves, nothing of the old Duo remains:
  // no hinge, no parked stream, no stale screen under the new name.
  expect(client().status).toBe("connecting");
  expect(client().screen).toBeNull();
  expect(client().hinge).toBeNull();
  gate.hold = false;
  await act(async () => gate.release?.());
  await act(async () => {});
  // The old Duo config must not classify the plain iPhone or park its stream
  // while its own helper has not pushed a config yet.
  expect(client().screen).toBeNull();
  expect(client().hinge).toBeNull();
  const next = FakeSocket.instances.find((instance) => instance.url.includes("device-2"));
  expect(next).toBeDefined();
  await act(async () => next!.open());
  await act(async () =>
    next!.push(0x82, { width: 1206, height: 2622, orientation: "portrait", screenId: 1 }),
  );
  expect(client().screen?.width).toBe(1206);
  expect(client().hinge).toBeNull();
});

test("a rejected preset restores the 3D view it replaced, unless a rotation superseded it", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  const openView = client().hinge!.view;
  expect(openView.fixedLeftFold).toBeUndefined();

  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  expect(client().hinge?.view.fixedLeftFold).toBeDefined();
  await act(async () =>
    socket.push(0x90, {
      requestId: 1,
      ok: false,
      error: "Simulator could not change the device pose.",
    }),
  );
  expect(client().hinge?.error).toBe("Simulator could not change the device pose.");
  expect(client().hinge?.view).toEqual(openView);

  // A rotation during the request owns the view; the rejection keeps it.
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  expect(rotatedView).not.toEqual(openView);
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" }));
  expect(client().hinge?.view).toEqual(rotatedView);

  // An acknowledged preset keeps its own view: a later failed edit does not undo it.
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await act(async () => socket.push(0x90, { requestId: 3, ok: true }));
  const acknowledged = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: "angle", value: 120 }));
  await act(async () => socket.push(0x90, { requestId: 4, ok: false, error: "Rejected" }));
  expect(client().hinge?.view).toEqual(acknowledged);
  await act(async () => socket.push(0x82, INNER_OPEN));

  // A preset queued behind a failing edit is discarded with the queue, so its
  // view goes too.
  const beforeEdit = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: "angle", value: 100 }));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  expect(client().hinge?.view.fixedLeftFold).toBeDefined();
  expect(socket.frames().filter((frame) => frame.tag === 0x10)).toHaveLength(5);
  await act(async () => socket.push(0x90, { requestId: 5, ok: false, error: "Rejected" }));
  expect(client().hinge?.pending).toBe(false);
  expect(socket.frames().filter((frame) => frame.tag === 0x10)).toHaveLength(5);
  expect(client().hinge?.view).toEqual(beforeEdit);
});

/** Connects with configs pushed over exec-ws, as serve-sim pushes them. */
async function connectOverExecWs({ strict = false } = {}) {
  apiExtra = { execToken: "exec-1", pid: 1 };
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "device-1",
      enabled: true,
      streamMode: "mjpeg",
    });
    return null;
  }
  await act(async () => {
    renderer = create(
      strict ? (
        <StrictMode>
          <Harness />
        </StrictMode>
      ) : (
        <Harness />
      ),
    );
  });
  await act(async () => {});
  const helperSockets = () =>
    FakeSocket.instances.filter((instance) => instance.url.includes("/helper/ws"));
  const control = FakeSocket.instances.find((instance) => instance.url.endsWith("/exec-ws"));
  if (!control) throw new Error("The hook did not open exec-ws");
  await act(async () => {
    helperSockets().at(-1)!.open();
    control.open();
    control.onmessage?.({ data: JSON.stringify({ ready: true }) });
  });
  const subscription = control.texts
    .map((text) => JSON.parse(text) as { sub?: number; path?: string })
    .find(({ sub, path }) => typeof sub === "number" && path?.includes("/api/events"));
  if (!subscription) throw new Error("The hook did not subscribe to config updates");
  return {
    client: () => client,
    helperSockets,
    socket: () => helperSockets().at(-1)!,
    /** A config pushed over exec-ws for the same device. */
    pushConfig: (changes: Record<string, unknown>) =>
      act(async () =>
        control.onmessage?.({
          data: JSON.stringify({
            sub: subscription.sub,
            data: `data: ${JSON.stringify({ ...previewApi("device-1", true), ...changes })}\n\n`,
          }),
        }),
      ),
  };
}

for (const strict of [false, true]) {
  test(`a replaced helper at the same URL ends a pending preview${strict ? " in strict mode" : ""}`, async () => {
    installBrowser({ duo: true });
    const { client, socket, helperSockets, pushConfig } = await connectOverExecWs({ strict });
    await act(async () => socket().push(0x82, COVER));
    await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
    expect(client().hinge?.pending).toBe(true);
    // A refresh for the same helper session keeps the command pending.
    await pushConfig({ streamSettings: { transport: "http", codec: "mjpeg", mjpegFps: 30 } });
    expect(helperSockets()).toHaveLength(1);
    expect(client().hinge?.pending).toBe(true);
    // A new helper process at the same URL replaces the input socket and its queue.
    await pushConfig({ pid: 2 });
    expect(helperSockets()).toHaveLength(2);
    expect(client().hinge?.pending).toBe(false);
    // The preview of the dropped command ends, so the replacement's Closed shows.
    await act(async () => socket().open());
    await act(async () => socket().push(0x82, COVER));
    expect(client().hinge?.pose).toBe("closed");
    expect(client().hinge?.angle).toBe(0);
  });
}

for (const failure of ["rejection", "timeout", "disconnect"] as const) {
  test(`a queued preset ${failure} restores the last accepted preset's view`, async () => {
    installBrowser({ duo: true });
    const deadlines: (() => void)[] = [];
    const nativeTimeout = setTimeout;
    if (failure === "timeout") {
      stubGlobal("setTimeout", (callback: () => void, ms: number) => {
        if (ms === 5_000) {
          deadlines.push(callback);
          return 0;
        }
        return nativeTimeout(callback, ms);
      });
    }
    const { socket, client } = await connect();
    await act(async () => socket.push(0x82, COVER));
    await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
    const acceptedView = client().hinge!.view;
    await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
    const laptopView = client().hinge!.view;
    expect(laptopView).not.toEqual(acceptedView);
    await act(async () => socket.push(0x82, INNER_OPEN));
    await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
    expect(socket.frames().at(-1)?.payload).toEqual({
      requestId: 2,
      command: { control: "pose", value: "laptop" },
    });
    // Acknowledging Open must not interrupt the optimistic Laptop preview.
    expect(client().hinge?.view).toEqual(laptopView);
    await act(async () => {
      if (failure === "rejection")
        socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" });
      else if (failure === "timeout") deadlines.at(-1)!();
      else socket.onclose?.({ code: 1006, reason: "" });
    });
    expect(client().hinge?.pending).toBe(false);
    expect(client().hinge?.error).toBeTruthy();
    expect(client().hinge?.pose).toBe("open");
    expect(client().hinge?.view).toEqual(acceptedView);
  });
}

test("a rotation supersedes recovery even when an earlier queued preset succeeds", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" }));
  expect(client().hinge?.view).toEqual(rotatedView);
});

test("a preset rejected after a rotation restores the turned view", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  // Open is accepted, but the helper still reports Closed when the user rotates.
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  expect(client().hinge?.view).not.toEqual(rotatedView);
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" }));
  expect(client().hinge?.view).toEqual(rotatedView);
});

test("a preset from before a rotation, accepted later, keeps the turned recovery view", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, COVER));
  await act(async () => client().hinge!.setControl({ control: "pose", value: "open" }));
  await act(async () => client().rotate());
  const rotatedView = client().hinge!.view;
  // Laptop queues behind Open; accepting Open must not drop the turn from recovery.
  await act(async () => client().hinge!.setControl({ control: "pose", value: "laptop" }));
  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  expect(socket.frames().at(-1)?.payload).toEqual({
    requestId: 2,
    command: { control: "pose", value: "laptop" },
  });
  await act(async () => socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" }));
  expect(client().hinge?.view).toEqual(rotatedView);
});

test("a rejected hinge command surfaces its error and drops the preview", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().hinge!.setControl({ control: "angle", value: 90 }));
  expect(client().hinge?.angle).toBe(90);
  expect(client().hinge?.pose).toBeNull();
  await act(async () =>
    socket.push(0x90, {
      requestId: 1,
      ok: false,
      error: "Simulator could not change the device pose.",
    }),
  );
  expect(client().hinge?.pending).toBe(false);
  expect(client().hinge?.error).toBe("Simulator could not change the device pose.");
  expect(client().hinge?.angle).toBe(180);
  // The next command clears the error.
  await act(async () => client().hinge!.setControl({ control: "table", value: true }));
  expect(client().hinge?.error).toBeNull();
  expect(client().hinge?.tableMode).toBe(true);
});

for (const duo of [true, false]) {
  test(`fast Rotate presses advance from the last request on ${duo ? "the Duo" : "other devices"}, like serve-sim`, async () => {
    installBrowser({ duo });
    const { socket, client } = await connect();
    await act(async () =>
      socket.push(
        0x82,
        duo ? INNER_OPEN : { width: 1206, height: 2622, orientation: "portrait", screenId: 1 },
      ),
    );
    // Both presses land before the helper confirms the first one.
    await act(async () => client().rotate());
    await act(async () => client().rotate());
    const orientations = socket
      .frames()
      .filter((frame) => frame.tag === 0x07)
      .map((frame) => frame.payload.orientation);
    expect(orientations).toEqual(
      duo
        ? ["landscape_right", "portrait_upside_down"]
        : ["landscape_left", "portrait_upside_down"],
    );
  });
}

test("the Duo rotates clockwise like Xcode and serve-sim, and a rotation forgets the native preset", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x07,
    payload: { orientation: "landscape_right" },
  });
  expect(client().hinge?.physicalPose).toBeNull();
});

test("choosing an orientation on the Duo turns its 3D view by the same quarter turns", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  const before = client().hinge!.view;
  await act(async () => client().setOrientation("landscape_left"));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x07,
    payload: { orientation: "landscape_left" },
  });
  // Landscape left is a quarter turn counterclockwise from portrait.
  expect(client().hinge?.view).toEqual(duoRotateView(before, -1));
  expect(client().hinge?.physicalPose).toBeNull();
});

test("two orientation choices in one render turn the 3D view as far as the device", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  const before = client().hinge!.view;
  await act(async () => {
    client().setOrientation("landscape_right");
    client().setOrientation("portrait_upside_down");
  });
  expect(
    socket
      .frames()
      .filter((frame) => frame.tag === 0x07)
      .map((frame) => frame.payload.orientation),
  ).toEqual(["landscape_right", "portrait_upside_down"]);
  // Each choice is one quarter turn clockwise from the one before it.
  expect(client().hinge?.view).toEqual(duoRotateView(duoRotateView(before, 1), 1));
});

test("the 3D preview feeds both panels through the helper mount and parks the flat stream", async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect({ duoPreview: "3d" });
  await act(async () => socket.push(0x82, COVER));
  const hinge = client().hinge!;
  expect(hinge.modelActive).toBe(true);
  expect(hinge.panels).toMatchObject({ url: "https://hub.test/helper/device-1", mode: "mjpeg" });
  expect(client().status).toBe("connecting");
  await act(async () => hinge.panels!.onStreamingChange(true));
  expect(client().status).toBe("streaming");
  await act(async () => hinge.panels!.onStreamError("WebRTC streaming failed for this display."));
  expect(client().status).toBe("error");
  expect(client().error).toBe("WebRTC streaming failed for this display.");

  await update({ duoPreview: "2d" });
  expect(client().hinge?.modelActive).toBe(false);
  expect(client().hinge?.panels).toBeNull();
  expect(client().hinge?.angle).toBe(0);
});

test("switching to 3D stops the flat MJPEG request even after the <img> unmounted", async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect({ duoPreview: "3d" });
  await act(async () => socket.push(0x82, COVER));
  const img = {
    src: "",
    naturalWidth: 0,
    naturalHeight: 0,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
  };
  await act(async () => client().attachVideo(img as unknown as HTMLImageElement));
  await update({ duoPreview: "2d" });
  expect(img.src).toContain("stream.mjpeg");
  // The 3D model replaces the flat screen: React detaches the ref first.
  await act(async () => client().attachVideo(null));
  await update({ duoPreview: "3d" });
  expect(img.src).toBe("");
});

test("the 3D preview authenticates its model and passes the token to both panels", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect({ duoPreview: "3d", token: "duo-token" });
  await act(async () => socket.push(0x82, COVER));
  expect(client().hinge?.modelUrl).toBe(
    "https://hub.test/grid/api/devicekit-model?token=duo-token",
  );
  expect(client().hinge?.panels?.token).toBe("duo-token");
});

test("raw model input bypasses the display-orientation remap", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, { ...INNER_OPEN, orientation: "landscape_left" }));
  await act(async () =>
    client().hinge!.sendModelTouch({ type: "begin", x: 0.25, y: 0.75, edge: 3 }),
  );
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x03,
    payload: { type: "begin", x: 0.25, y: 0.75, edge: 3 },
  });
  await act(async () => client().hinge!.sendModelScroll({ dx: 0.1, dy: -0.2, x: 0.5, y: 0.5 }));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x0b,
    payload: { dx: 0.1, dy: -0.2, x: 0.5, y: 0.5 },
  });
});
