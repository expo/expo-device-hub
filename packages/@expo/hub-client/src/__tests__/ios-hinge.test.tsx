import { afterEach, expect, test } from "bun:test";
import { StrictMode, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type FoldControlCommand } from "../fold";
import {
  type DeviceClient,
  type DeviceConnectionOptions,
  type DeviceFold,
  type FoldCommandEvent,
} from "../types";
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
  requests.length = 0;
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

const JPEG = [0xff, 0xd8, 0xff, 0xd9];
const MJPEG_PART = new Uint8Array([
  ...new TextEncoder().encode(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${JPEG.length}\r\n\r\n`,
  ),
  ...JPEG,
]);
/** Panel stream requests, with the session token they carried. */
const requests: Array<{ url: string; authorization: string | null }> = [];

/** An `<img>` that the test finishes loading, as a browser would decode a frame. */
function fakeImage() {
  return {
    src: "",
    naturalWidth: 0,
    naturalHeight: 0,
    onload: null as (() => void) | null,
    onerror: null as (() => void) | null,
    addEventListener() {},
    removeEventListener() {},
    removeAttribute(name: string) {
      if (name === "src") this.src = "";
    },
  };
}

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
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
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
    if (pathname.includes("/panel/")) {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(MJPEG_PART);
          },
        }),
      );
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
  const events: FoldCommandEvent[] = [];
  return {
    socket,
    client: () => client,
    /** Hinge events from the moment the Duo is recognized. */
    events,
    observe: () => client.fold!.observe!((event) => events.push(event)),
    update: (props: Partial<DeviceConnectionOptions>) =>
      act(async () => renderer!.update(<Harness {...options} {...props} />)),
  };
}

test("a device without a hinge exposes no fold, no displays, no model, and rotates counterclockwise", async () => {
  installBrowser({ duo: false });
  const { socket, client } = await connect();
  await act(async () =>
    socket.push(0x82, { width: 1206, height: 2622, orientation: "portrait", screenId: 1 }),
  );
  expect(client().fold).toBeNull();
  expect(client().capabilities.fold).toBe(false);
  expect(client().displays).toBeNull();
  expect(client().deviceModelUrl).toBeNull();
  // An ordinary iPhone's screen ID names no fold display.
  expect(client().screen).toEqual({ width: 1206, height: 2622, orientation: "portrait" });
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

test("the Duo reports its fold state, displays, and model, and keeps the flat stream by default", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // DeviceKit's cover chrome identifies the Duo before native capability metadata.
  expect(client().fold).not.toBeNull();
  expect(client().fold?.angle).toBeUndefined();
  // The controls wait for the helper to report its hinge, as serve-sim's do.
  expect(client().capabilities.fold).toBe(false);
  await act(async () => socket.push(0x82, COVER));
  const fold = client().fold!;
  // Fold controls and state only: no renderer state in the contract.
  expect(Object.keys(fold).sort()).toEqual([
    "angle",
    "error",
    "observe",
    "pending",
    "physical",
    "pose",
    "setControl",
    "tableMode",
  ]);
  expect(fold.angle).toBe(0);
  expect(fold.pose).toBe("closed");
  expect(fold.tableMode).toEqual({ enabled: false, available: false });
  expect(fold.physical).toEqual({ pose: "closed", faceDown: false });
  expect(fold.pending).toBe(false);
  expect(client().capabilities.fold).toEqual({
    angle: { min: 0, max: 180 },
    poses: {
      closed: { angle: 0 },
      open: { angle: 180 },
      laptop: { angle: 90 },
      book: { angle: 90 },
      tent: { angle: 80 },
    },
    tableMode: true,
    faceDown: false,
  });
  expect(client().displays?.map(({ id, active }) => ({ id, active }))).toEqual([
    { id: "cover", active: true },
    { id: "inner", active: false },
  ]);
  expect(client().deviceModelUrl).toBe("https://hub.test/grid/api/devicekit-model");
  // serve-sim's hinge fields and display IDs stay inside the adapter.
  expect(client().screen).toEqual({
    width: 1398,
    height: 2034,
    orientation: "portrait",
    display: "cover",
  });
  // Nothing attached a display, so the flat stream runs.
  const img = fakeImage();
  await act(async () => client().attachVideo(img as unknown as HTMLImageElement));
  expect(img.src).toContain("https://hub.test/helper/device-1/stream.mjpeg");
  expect(requests).toEqual([]);
});

test("a pose command is reported from request to confirmation, and its display activates at once", async () => {
  installBrowser({ duo: true });
  const { socket, client, events, observe } = await connect();
  await act(async () => socket.push(0x82, COVER));
  observe();
  await act(async () => client().fold!.setControl({ control: "pose", value: "open" }));
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x10,
    payload: { requestId: 1, command: { control: "pose", value: "open" } },
  });
  expect(client().fold?.pending).toBe(true);
  expect(client().fold?.angle).toBe(180);
  expect(client().fold?.pose).toBe("open");
  expect(client().displays?.find(({ active }) => active)?.id).toBe("inner");
  const command = { control: "pose", value: "open" } as const;
  expect(events).toEqual<FoldCommandEvent[]>([
    { type: "requested", command },
    { type: "sent", command, display: "inner" },
  ]);
  // Listeners can follow one command object through its replies.
  const commandOf = (event: FoldCommandEvent | undefined) =>
    event && "command" in event ? event.command : undefined;
  expect(commandOf(events[1])).toBe(commandOf(events[0]));

  await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
  expect(client().fold?.pending).toBe(false);
  // The preview holds until the helper's config catches up, so nothing animates backwards.
  expect(client().fold?.angle).toBe(180);
  expect(events.at(-1)).toEqual<FoldCommandEvent>({ type: "acknowledged", command, ok: true });
  expect(commandOf(events.at(-1))).toBe(commandOf(events[0]));
  await act(async () => socket.push(0x82, INNER_OPEN));
  expect(events.at(-1)).toEqual<FoldCommandEvent>({ type: "confirmed" });
  expect(client().fold?.angle).toBe(180);
  expect(client().fold?.pose).toBe("open");
  expect(client().fold?.tableMode?.available).toBe(true);
  expect(client().screen?.display).toBe("inner");
});

test("a submitted command names the display it elects; Table Mode and the hysteresis band do not", async () => {
  installBrowser({ duo: true });
  const { socket, client, events, observe } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  observe();
  for (const [index, command] of [
    { control: "angle", value: 40 },
    { control: "tableMode", value: true },
    { control: "angle", value: 54.5 },
    { control: "angle", value: 120 },
  ].entries()) {
    await act(async () => client().fold!.setControl(command as FoldControlCommand));
    await act(async () => socket.push(0x90, { requestId: index + 1, ok: true }));
  }
  expect(
    events.flatMap((event) => (event.type === "sent" ? [event.display ?? "none"] : [])),
  ).toEqual(["cover", "none", "none", "inner"]);
});

test("switching to another simulator forgets the previous screen config and displays at once", async () => {
  installBrowser({ duo: true });
  const { socket, client, update } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  const panels = [fakeImage(), fakeImage()];
  await act(async () => {
    client().displays![0]!.attachVideo(panels[0] as unknown as HTMLImageElement);
    client().displays![1]!.attachVideo(panels[1] as unknown as HTMLImageElement);
  });
  expect(requests).toHaveLength(2);

  gate.hold = true;
  await update({ device: "device-2" });
  await act(async () => {});
  // Before the new device's config resolves, nothing of the old Duo remains:
  // no hinge, no displays, no stale screen under the new name.
  expect(client().status).toBe("connecting");
  expect(client().screen).toBeNull();
  expect(client().fold).toBeNull();
  expect(client().displays).toBeNull();
  gate.hold = false;
  await act(async () => gate.release?.());
  await act(async () => {});
  // The old Duo config must not classify the plain iPhone or park its stream
  // while its own helper has not pushed a config yet.
  expect(client().screen).toBeNull();
  expect(client().fold).toBeNull();
  const next = FakeSocket.instances.find((instance) => instance.url.includes("device-2"));
  expect(next).toBeDefined();
  await act(async () => next!.open());
  await act(async () =>
    next!.push(0x82, { width: 1206, height: 2622, orientation: "portrait", screenId: 1 }),
  );
  expect(client().screen?.width).toBe(1206);
  expect(client().fold).toBeNull();
  expect(client().displays).toBeNull();
  const flat = fakeImage();
  await act(async () => client().attachVideo(flat as unknown as HTMLImageElement));
  expect(flat.src).toContain("https://hub.test/helper/device-2/stream.mjpeg");
});

test("a command still pending when the connection changes ends with a reset event", async () => {
  installBrowser({ duo: true });
  const { socket, client, events, observe, update } = await connect();
  await act(async () => socket.push(0x82, COVER));
  observe();
  await act(async () => client().fold!.setControl({ control: "pose", value: "open" }));
  expect(client().fold?.pending).toBe(true);
  // A reply for the old connection's command never comes.
  await update({ device: "device-2" });
  await act(async () => {});
  const open = { control: "pose", value: "open" } as const;
  expect(events).toEqual<FoldCommandEvent[]>([
    { type: "requested", command: open },
    { type: "sent", command: open, display: "inner" },
    { type: "reset" },
  ]);
});

/**
 * A consumer that observes the hinge from its first render, as a child does:
 * its effect subscribes before the client's own effects run. Configs arrive
 * over exec-ws, as serve-sim pushes them.
 */
async function connectObserved({ strict = false } = {}) {
  apiExtra = { execToken: "exec-1", pid: 1 };
  let client!: DeviceClient;
  const events: FoldCommandEvent[] = [];
  function Observer({ observe }: { observe?: DeviceFold["observe"] }) {
    useEffect(() => observe?.((event) => events.push(event)), [observe]);
    return null;
  }
  function Harness() {
    client = useIosDeviceClient({
      baseUrl: "https://hub.test",
      device: "device-1",
      enabled: true,
      streamMode: "mjpeg",
    });
    return <Observer observe={client.fold?.observe} />;
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
    events,
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
  test(`a replaced helper at the same URL ends a pending command with a reset event${strict ? " in strict mode" : ""}`, async () => {
    installBrowser({ duo: true });
    const { client, events, socket, helperSockets, pushConfig } = await connectObserved({
      strict,
    });
    await act(async () => socket().push(0x82, COVER));
    // Connecting emitted nothing.
    expect(events).toEqual([]);
    const open = { control: "pose", value: "open" } as const;
    await act(async () => client().fold!.setControl(open));
    expect(client().fold?.pending).toBe(true);
    // A refresh for the same helper session keeps the command pending.
    await pushConfig({ streamSettings: { transport: "http", codec: "mjpeg", mjpegFps: 30 } });
    expect(helperSockets()).toHaveLength(1);
    expect(client().fold?.pending).toBe(true);
    expect(events).toEqual<FoldCommandEvent[]>([
      { type: "requested", command: open },
      { type: "sent", command: open, display: "inner" },
    ]);
    // A new helper process at the same URL replaces the input socket and its queue.
    await pushConfig({ pid: 2 });
    expect(helperSockets()).toHaveLength(2);
    expect(events.at(-1)).toEqual<FoldCommandEvent>({ type: "reset" });
    expect(events.filter(({ type }) => type === "reset")).toHaveLength(1);
    expect(client().fold?.pending).toBe(false);
    // The preview of the dropped command ends, so it cannot stay forever.
    await act(async () => socket().open());
    await act(async () => socket().push(0x82, COVER));
    expect(client().fold?.pose).toBe("closed");
    expect(client().fold?.angle).toBe(0);
  });
}

test("a replaced helper at the same URL restarts both panel streams; a refresh does not", async () => {
  installBrowser({ duo: true });
  const { client, socket, pushConfig } = await connectObserved();
  await act(async () => socket().push(0x82, COVER));
  await act(async () => {
    client().displays![0]!.attachVideo(fakeImage() as unknown as HTMLImageElement);
    client().displays![1]!.attachVideo(fakeImage() as unknown as HTMLImageElement);
  });
  await act(async () => {});
  const panelRequests = () => requests.map(({ url }) => new URL(url).pathname);
  expect(panelRequests()).toEqual([
    "/helper/device-1/panel/1/stream.mjpeg",
    "/helper/device-1/panel/3/stream.mjpeg",
  ]);
  // The same helper session keeps its readers.
  await pushConfig({ streamSettings: { transport: "http", codec: "mjpeg", mjpegFps: 30 } });
  await act(async () => {});
  expect(panelRequests()).toHaveLength(2);
  // A new helper process at the same URL needs new readers for both panels.
  await pushConfig({ pid: 2 });
  await act(async () => {});
  expect(panelRequests()).toEqual([
    "/helper/device-1/panel/1/stream.mjpeg",
    "/helper/device-1/panel/3/stream.mjpeg",
    "/helper/device-1/panel/1/stream.mjpeg",
    "/helper/device-1/panel/3/stream.mjpeg",
  ]);
});

for (const failure of ["rejection", "timeout", "disconnect"] as const) {
  test(`a queued preset ${failure} reports a failure after the accepted preset`, async () => {
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
    const { socket, client, events, observe } = await connect();
    await act(async () => socket.push(0x82, COVER));
    observe();
    await act(async () => client().fold!.setControl({ control: "pose", value: "open" }));
    await act(async () => client().fold!.setControl({ control: "pose", value: "laptop" }));
    await act(async () => socket.push(0x82, INNER_OPEN));
    await act(async () => socket.push(0x90, { requestId: 1, ok: true }));
    expect(socket.frames().at(-1)?.payload).toEqual({
      requestId: 2,
      command: { control: "pose", value: "laptop" },
    });
    await act(async () => {
      if (failure === "rejection")
        socket.push(0x90, { requestId: 2, ok: false, error: "Rejected" });
      else if (failure === "timeout") deadlines.at(-1)!();
      else socket.onclose?.({ code: 1006, reason: "" });
    });
    expect(client().fold?.pending).toBe(false);
    expect(client().fold?.error).toBeTruthy();
    expect(client().fold?.pose).toBe("open");
    const open = { control: "pose", value: "open" } as const;
    const laptop = { control: "pose", value: "laptop" } as const;
    expect(events).toEqual<FoldCommandEvent[]>([
      { type: "requested", command: open },
      { type: "sent", command: open, display: "inner" },
      { type: "requested", command: laptop },
      { type: "acknowledged", command: open, ok: true },
      { type: "sent", command: laptop, display: "inner" },
      ...(failure === "rejection"
        ? [{ type: "acknowledged", command: laptop, ok: false } as const]
        : []),
      { type: "failed", error: client().fold!.error! },
    ]);
  });
}

test("a rejected hinge command surfaces its error and drops the preview", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  await act(async () => client().fold!.setControl({ control: "angle", value: 90 }));
  expect(client().fold?.angle).toBe(90);
  expect(client().fold?.pose).toBeNull();
  await act(async () =>
    socket.push(0x90, {
      requestId: 1,
      ok: false,
      error: "Simulator could not change the device pose.",
    }),
  );
  expect(client().fold?.pending).toBe(false);
  expect(client().fold?.error).toBe("Simulator could not change the device pose.");
  expect(client().fold?.angle).toBe(180);
  // The next command clears the error, and goes out as serve-sim's wire command.
  await act(async () => client().fold!.setControl({ control: "tableMode", value: true }));
  expect(client().fold?.error).toBeNull();
  expect(client().fold?.tableMode?.enabled).toBe(true);
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x10,
    payload: { requestId: 2, command: { control: "table", value: true } },
  });
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
  const { socket, client, events, observe } = await connect();
  await act(async () => socket.push(0x82, INNER_OPEN));
  observe();
  await act(async () => client().rotate());
  expect(socket.frames().at(-1)).toEqual({
    tag: 0x07,
    payload: { orientation: "landscape_right" },
  });
  expect(client().fold?.physical?.pose).toBeNull();
  expect(events).toEqual<FoldCommandEvent[]>([{ type: "rotated" }]);
});

test("attached displays stream through the helper mount, park the flat stream, and resume it when detached", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  // The flat screen mounts with the connection, as DeviceScreen does.
  const flat = fakeImage();
  await act(async () => client().attachVideo(flat as unknown as HTMLImageElement));
  await act(async () => socket.push(0x82, COVER));
  expect(flat.src).toContain("stream.mjpeg");

  // A consumer replaces the flat screen: React detaches the flat ref first.
  const panels = [fakeImage(), fakeImage()];
  await act(async () => {
    client().attachVideo(null);
    client().displays![0]!.attachVideo(panels[0] as unknown as HTMLImageElement);
    client().displays![1]!.attachVideo(panels[1] as unknown as HTMLImageElement);
  });
  await act(async () => {});
  expect(flat.src).toBe("");
  expect(requests.map(({ url }) => url)).toEqual([
    "https://hub.test/helper/device-1/panel/1/stream.mjpeg?raw=1",
    "https://hub.test/helper/device-1/panel/3/stream.mjpeg?raw=1",
  ]);
  expect(client().status).toBe("connecting");
  // Each panel paints its frames as blob URLs, so a sampling consumer sees every frame.
  expect(panels[0]!.src).toStartWith("blob:");
  // The inner panel's frame does not stand for the active cover.
  await act(async () => panels[1]!.onload?.());
  expect(client().status).toBe("connecting");
  await act(async () => panels[0]!.onload?.());
  expect(client().status).toBe("streaming");

  await act(async () => {
    client().displays![0]!.attachVideo(null);
    client().displays![1]!.attachVideo(null);
  });
  expect(client().status).toBe("connecting");
  const resumed = fakeImage();
  await act(async () => client().attachVideo(resumed as unknown as HTMLImageElement));
  expect(resumed.src).toContain("https://hub.test/helper/device-1/stream.mjpeg");
});

test("the device model and both panel streams carry the session token", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect({ token: "duo-token" });
  await act(async () => socket.push(0x82, COVER));
  expect(client().deviceModelUrl).toBe("https://hub.test/grid/api/devicekit-model?token=duo-token");
  await act(async () => {
    client().displays![0]!.attachVideo(fakeImage() as unknown as HTMLImageElement);
    client().displays![1]!.attachVideo(fakeImage() as unknown as HTMLImageElement);
  });
  await act(async () => {});
  expect(requests.map(({ authorization }) => authorization)).toEqual([
    "Bearer duo-token",
    "Bearer duo-token",
  ]);
});

test("input addressed to a display maps like the flat stream and drops a gesture on another display", async () => {
  installBrowser({ duo: true });
  const { socket, client } = await connect();
  await act(async () => socket.push(0x82, { ...INNER_OPEN, orientation: "landscape_left" }));
  const sent = () => socket.frames().filter((frame) => frame.tag !== 0x0e);
  const before = sent().length;
  // The cover is not the display native readback reports, so its whole gesture is dropped.
  await act(async () => {
    client().sendTouch({ phase: "begin", display: "cover", x: 0.2, y: 0.2 });
    client().sendTouch({ phase: "move", display: "cover", x: 0.3, y: 0.3 });
    client().sendTouch({ phase: "end", display: "cover", x: 0.3, y: 0.3 });
    client().sendScroll!({ display: "cover", dx: 0.1, dy: 0.1, x: 0.5, y: 0.5 });
  });
  expect(sent()).toHaveLength(before);
  // The inner display gets the flat stream's display-to-raw mapping and home-indicator edge.
  await act(async () => client().sendTouch({ phase: "begin", display: "inner", x: 0.25, y: 0.95 }));
  expect(sent().at(-1)).toEqual({
    tag: 0x03,
    payload: { type: "begin", x: 0.95, y: 0.75, edge: 4 },
  });
  await act(async () => client().sendTouch({ phase: "end", display: "inner", x: 0.25, y: 0.95 }));
  await act(async () =>
    client().sendScroll!({ display: "inner", dx: 0.1, dy: -0.2, x: 0.5, y: 0.5 }),
  );
  expect(sent().at(-1)).toEqual({
    tag: 0x0b,
    payload: { dx: -0.2, dy: -0.1, x: 0.5, y: 0.5 },
  });
  await act(async () =>
    client().sendMultiTouch!({
      phase: "begin",
      display: "inner",
      a: { x: 0.25, y: 0.5 },
      b: { x: 0.75, y: 0.5 },
    }),
  );
  expect(sent().at(-1)).toEqual({
    tag: 0x05,
    payload: { type: "begin", x1: 0.5, y1: 0.75, x2: 0.5, y2: 0.25 },
  });
});
