import { afterEach, expect, mock, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ReactElement, ReactNode } from "react";
import { Quaternion } from "three";
import type { StreamConfig, SimulatorOrientation } from "../../client/types";
import type { HingeControlCommand, HingePose } from "../../hinge-control";
import type { DuoView } from "../../client/simulator/duo-view";
import type { createInputSocket } from "../../socket/client-input";

// Mount the actual entry's <App /> without a DOM root. Its React state/effects,
// config reconciliation and acknowledged control queue all run unchanged.
// Replace rendering and browser I/O boundaries, not the framing logic.
const noop = () => {};
function Children({ children }: { children?: ReactNode }) {
  return children;
}
function Silent() {
  return null;
}
function DuoModelView({ children }: { children?: ReactNode }) {
  return children;
}
function ToolsPanel() {
  return null;
}
const toolbar = Object.assign(Children, {
  Title: Silent,
  Actions: Children,
  Button: Silent,
  HomeButton: Silent,
  ScreenshotButton: Silent,
  RotateButton: Silent,
});
const components: Record<string, Record<string, unknown>> = {
  "duo-model-view": { DuoModelView },
  "tools-panel": { ToolsPanel },
  "ax-state-provider": { AxStateProvider: Children },
  "app-toasts": {
    ServeSimToaster: Silent,
    dismissInputSocketError: noop,
    showInputSocketError: noop,
  },
  "keyboard-capture": { KeyboardCapture: Silent, KeyboardToggleButton: Silent },
};
for (const [file, name] of Object.entries({
  "ax-dom-overlay": "AxDomOverlay",
  "ax-toolbar-button": "AxToolbarButton",
  "device-sidebar-toggle": "DeviceSidebarToggle",
  "device-placeholder": "DevicePlaceholder",
  "duo-panel-streams": "DuoPanelStreams",
  "presentation-controls": "PresentationControls",
  "grid-panel": "GridPanel",
  "icon-button": "IconButton",
  "logs-drawer": "LogsDrawer",
  "resize-handle": "ResizeHandle",
  "simulator-resize-corner-handle": "SimulatorResizeCornerHandle",
  "share-session-button": "ShareSessionButton",
  "simulator-resize-size-badge": "SimulatorResizeSizeBadge",
  "stream-status-pill": "StreamStatusPill",
  "hinge-controls": "HingeControls",
  "webkit-devtools-panel": "WebKitDevtoolsPanel",
}))
  components[file] = { [name]: Silent };
for (const [file, exports] of Object.entries(components)) {
  mock.module(`../../client/components/${file}`, () => exports);
}
const simulator = await import("../../client/simulator");
mock.module("../../client/simulator", () => ({
  ...simulator,
  SimulatorView: Silent,
  SimulatorToolbar: toolbar,
}));

const grid = {
  devices: [{ device: "DUO", name: "iPhone Duo", runtime: "iOS-26", helper: {} }],
  total: 1,
};
const hooks: Record<string, Record<string, unknown>> = {
  "use-clipboard-toast": {
    useClipboardToast: () => ({
      cancelPaste: noop,
      pasteText: noop,
      copyFromSim: noop,
      pasteFromDevice: noop,
    }),
    showClipboardKeyCleanupWarning: noop,
  },
  "use-grid-devices": { useGridDevices: () => grid },
  "use-ladder-restart": {
    useLadderRestart: () => ({ cancel: noop, noteFailure: noop, schedule: noop }),
  },
  "use-webkit-devtools": { useWebKitDevtools: () => ({ targets: [], refresh: noop }) },
  "use-avcc-stream": { useAvccStream: () => ({ supported: false }) },
  "use-webrtc-stream": { useWebRtcStream: () => ({ retry: noop, markFrameDecoded: noop }) },
  "use-mjpeg-stream": { useMjpegStream: () => ({ frame: null, subscribeFrame: () => noop }) },
  "use-resizable-width": {
    useResizableWidth: (_key: string, width: number) => ({ width, onPointerDown: noop }),
    useResizableHeight: (_key: string, height: number) => ({ height, onPointerDown: noop }),
  },
  "use-stream-settings": {
    useStreamSettings: () => ({
      settings: { transport: "http", httpCodec: "mjpeg", webRtcCodec: "h264", iceServers: [] },
      updatePlayback: noop,
      updateEncoder: noop,
    }),
  },
  "use-media-drop": { useMediaDrop: () => ({}) },
  "use-upload-toasts": { useUploadToasts: () => ({ add: noop, setProgress: noop, update: noop }) },
  "use-screenshot-toast": { useScreenshotToast: () => ({ dismiss: noop }) },
  "use-simulator-resize": {
    useSimulatorResize: ({ defaultWidth }: { defaultWidth: number }) => ({ width: defaultWidth }),
  },
  "use-flip-layout": { useFlipLayout: noop },
  "use-coarse-pointer": { useCoarsePointer: () => false },
  "use-block-page-zoom": { useBlockPageZoom: noop },
};
// Effects depend on some hook return identities, as real hooks do.
for (const [file, exports] of Object.entries(hooks)) {
  const stable = Object.fromEntries(
    Object.entries(exports).map(([name, hook]) => {
      if (
        name === "useResizableWidth" ||
        name === "useResizableHeight" ||
        name === "useSimulatorResize"
      )
        return [name, hook];
      const value = (hook as () => unknown)();
      return [name, () => value];
    }),
  );
  mock.module(`../../client/hooks/${file}`, () => stable);
}
mock.module("../../socket/client-control", () => ({
  openHostEventStream: () => ({ close: noop }),
  runHostAction: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
}));

type SocketHandlers = Parameters<typeof createInputSocket>[1];
let socket: SocketHandlers;
let connected = true;
const requests: Array<{ requestId: number; command: HingeControlCommand }> = [];
mock.module("../../socket/client-input", () => ({
  createInputSocket: (_url: string, handlers: SocketHandlers) => {
    socket = handlers;
    return {
      start: () => handlers.onAdmitted(),
      dispose: noop,
      send: noop,
      trySend: (_tag: number, request: (typeof requests)[number]) => {
        if (!connected) return false;
        requests.push(request);
        return true;
      },
    };
  },
}));
let entry: ReactElement;
mock.module("react-dom/client", () => ({
  createRoot: () => ({
    render: (element: ReactElement) => {
      entry = element;
    },
  }),
}));
const storage = { getItem: () => null, setItem: noop };
const location = new URL("http://preview/");
Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), {
    location,
    innerWidth: 1280,
    innerHeight: 900,
    devicePixelRatio: 1,
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
    __SIM_PREVIEW__: {
      device: "DUO",
      pid: 1,
      url: "http://preview/",
      streamUrl: "http://preview/stream.mjpeg",
      wsUrl: "ws://preview/input",
      basePath: "/",
    },
  }),
  document: Object.assign(new EventTarget(), { getElementById: () => ({}) }),
  localStorage: storage,
  HTMLElement: class {},
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { duoPresetView, duoRotateView } = await import("../../client/simulator/duo-view");
await import("../../client/client");

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  requests.length = 0;
  connected = true;
});
async function mount() {
  await act(async () => {
    renderer = create(entry);
  });
}
function model() {
  return renderer!.root.findByType(DuoModelView).props;
}
function controls() {
  return renderer!.root.findByType(ToolsPanel).props.hingeControls;
}
function expectView(pose: HingePose) {
  const view = model().view as DuoView;
  const expected = duoPresetView(pose);
  const difference = new Quaternion(...view.rotation).angleTo(new Quaternion(...expected.rotation));
  expect((difference * 180) / Math.PI).toBeCloseTo(0, 6);
  expect(view.facingYaw).toBe(expected.facingYaw);
  expect(view.fixedLeftFold).toBe(expected.fixedLeftFold);
}
async function frame(tag: number, value: unknown) {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const bytes = new Uint8Array(json.length + 1);
  bytes[0] = tag;
  bytes.set(json, 1);
  await act(async () => {
    socket.onMessage(bytes.buffer);
  });
}
function native(
  pose: "book" | "laptop",
  orientation: SimulatorOrientation = "portrait",
): StreamConfig {
  return {
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation,
    supportsHingeAngle: true,
    observedDeviceState: {
      hingeAngle: 90,
      physicalOrientation: pose === "laptop" ? "landscape-left" : "portrait",
      tableMode: false,
    },
  };
}
async function observe(config: StreamConfig) {
  await frame(0x82, config);
}
async function request(command: HingeControlCommand) {
  await act(async () => {
    controls().onChange(command);
  });
}
async function fail(message = "Native pose failed") {
  await frame(0x90, { requestId: requests.at(-1)!.requestId, ok: false, error: message });
}

function opened(
  physicalOrientation: "portrait" | "pud" | "landscape-left" | "landscape-right",
  orientation: SimulatorOrientation,
): StreamConfig {
  return {
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation,
    supportsHingeAngle: true,
    observedDeviceState: { hingeAngle: 180, physicalOrientation, tableMode: false },
  };
}

test("external rotation turns the opened Duo view before display geometry catches up", async () => {
  await mount();
  await observe(opened("portrait", "landscape_left"));
  const before = structuredClone(model().view as DuoView);
  await observe(opened("pud", "landscape_left"));
  const expected = duoRotateView(before, 2);
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
  await observe(opened("pud", "landscape_right"));
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
  await observe(opened("portrait", "landscape_right"));
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...before.rotation)),
  ).toBeCloseTo(0, 6);
});

test("UI rotation readback is not applied twice and later external rotation still turns the view", async () => {
  await mount();
  await observe(opened("portrait", "landscape_left"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await observe(opened("portrait", "landscape_left"));
  expect(model().view).toEqual(rotated);
  await observe(opened("landscape-left", "portrait"));
  expect(model().view).toEqual(rotated);
  await observe(opened("pud", "landscape_right"));
  const expected = duoRotateView(rotated, 1);
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
});

for (const orientation of ["portrait", "landscape_right"] as const) {
  test(`external Laptop → Book uses physical framing with ${orientation} app geometry`, async () => {
    await mount();
    await observe(native("laptop", "landscape_left"));
    expectView("laptop");
    await observe(native("book", orientation));
    expect(model().pose).toBe("book");
    expectView("book");
    // Delayed geometry must not hide a bad view saved during native pose discovery.
    await observe(native("book", "landscape_left"));
    expectView("book");
  });
}

test("a failed Book → Tent request restores the observed Book view", async () => {
  await mount();
  await observe(native("book"));
  expectView("book");
  await request({ control: "pose", value: "tent" });
  expectView("tent");
  expect(controls().pending).toBe(true);
  await fail();
  expect(controls().error).toBe("Native pose failed");
  expect(controls().pending).toBe(false);
  expect(model().pose).toBe("book");
  expectView("book");
  await observe(native("book", "landscape_right"));
  expectView("book");
});

test("failure of an active angle discards a queued Tent view and request", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "angle", value: 100 });
  await request({ control: "pose", value: "tent" });
  expect(requests).toHaveLength(1);
  expectView("tent");
  await fail("Angle failed before queued Tent");
  expect(requests).toHaveLength(1);
  expect(controls().pending).toBe(false);
  expectView("book");
});

test("a failed angle edit preserves a valid local rotation chosen before the batch", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  expect(
    (new Quaternion(...rotated.rotation).angleTo(
      new Quaternion(...duoPresetView("laptop").rotation),
    ) *
      180) /
      Math.PI,
  ).toBeCloseTo(90, 6);
  await request({ control: "angle", value: 100 });
  await fail("Angle failed without moving the device");
  expect(model().pose).toBe("laptop");
  expect(model().view).toEqual(rotated);
  await observe(native("laptop", "portrait"));
  expect(model().view).toEqual(rotated);
});

test("a newer local rotation survives failure that discards a queued preset", async () => {
  await mount();
  await observe(native("book"));
  const prior = structuredClone(model().view as DuoView);
  await request({ control: "angle", value: 100 });
  await request({ control: "pose", value: "tent" });
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("landscape_left", "right");
  });
  await fail("Angle failed before queued Tent");
  expect(requests).toHaveLength(1);
  expect(controls().pending).toBe(false);
  expect(model().pose).toBe("book");
  expect(model().view).toEqual(duoRotateView(prior, 1));
});

test("readback of a valid earlier rotation does not make a failed angle discard its view", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await request({ control: "angle", value: 100 });
  await observe(native("book", "portrait"));
  await fail("Angle failed after the earlier rotation completed");
  expect(model().pose).toBe("book");
  expect(model().view).toEqual(rotated);
});

test("unknown readback and a late native pose keep an explicit camera choice", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await request({ control: "angle", value: 100 });
  await observe({ ...native("laptop", "portrait"), observedDeviceState: {} });
  await fail("Readback temporarily unavailable");
  expect(model().pose).toBeUndefined();
  expect(model().view).toEqual(rotated);
  await observe(native("book", "landscape_right"));
  // Rotate clears the named physical anchor: this can be its late readback.
  expect(model().pose).toBe("book");
  expect(model().view).toEqual(rotated);
});

test("a named camera anchor yields to a different native pose after unknown failure readback", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "angle", value: 100 });
  await observe({ ...native("book"), observedDeviceState: {} });
  await fail("Readback temporarily unavailable");
  expect(model().pose).toBeUndefined();
  expectView("book");
  await observe(native("laptop", "landscape_right"));
  expect(model().pose).toBe("laptop");
  expectView("laptop");
});

test("a failed local edit releases face-down framing to a custom native pose", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "angle", value: 100 });
  await observe({
    ...native("book"),
    screenId: 1,
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "facedown", tableMode: true },
  });
  // No named preset describes 110° face down. The native cover framing must
  // regain control even though the failed angle edit held the previous view.
  await fail();
  expect(model().pose).toBeNull();
  expect(model().faceDown).toBe(true);
  expectView("tent");
});

test("a native Laptop preset supersedes the view saved before external face down", async () => {
  await mount();
  await observe(native("book"));
  expectView("book");
  await observe({
    ...native("book"),
    screenId: 1,
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "facedown", tableMode: true },
  });
  expect(model().pose).toBeNull();
  expectView("tent");
  await observe(native("laptop", "landscape_right"));
  expect(model().pose).toBe("laptop");
  expectView("laptop");
  await observe(native("laptop", "landscape_left"));
  expectView("laptop");
});

test("failure after external face down yields to a changed native Laptop orientation", async () => {
  await mount();
  await observe(native("book"));
  await observe({
    ...native("book"),
    screenId: 1,
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "facedown", tableMode: true },
  });
  expectView("tent");
  await request({ control: "angle", value: 100 });
  await observe(native("laptop", "landscape_right"));
  await fail("Angle failed after an external native change");
  expect(model().pose).toBe("laptop");
  expectView("laptop");
});

test("leaving external face down for a custom pose restores the earlier view", async () => {
  await mount();
  await observe(native("book"));
  await observe({
    ...native("book"),
    screenId: 1,
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "facedown", tableMode: true },
  });
  expectView("tent");
  await observe({
    ...native("book"),
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "portrait", tableMode: false },
  });
  expect(model().pose).toBeNull();
  expectView("book");
});

test("disconnect during Tent abandons its framing before reconnect", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "pose", value: "tent" });
  expectView("tent");
  await act(async () => {
    connected = false;
    socket.onDisconnect();
  });
  expect(controls().pending).toBe(false);
  await act(async () => {
    connected = true;
    socket.onAdmitted();
  });
  await observe(native("book", "landscape_right"));
  expect(requests).toHaveLength(1);
  expectView("book");
});

test("reconnect preserves a settled local view when no command was interrupted", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "angle", value: 110 });
  await frame(0x90, { requestId: requests[0]!.requestId, ok: true });
  const custom = {
    ...native("book", "landscape_right"),
    observedDeviceState: {
      hingeAngle: 110,
      physicalOrientation: "portrait" as const,
      tableMode: false,
    },
  };
  await observe(custom);
  expectView("book");
  await act(async () => {
    connected = false;
    socket.onDisconnect();
  });
  await act(async () => {
    connected = true;
    socket.onAdmitted();
  });
  await observe(custom);
  expectView("book");
});

test("reconnect preserves an explicit rotation through stale and then current native readback", async () => {
  await mount();
  await observe(native("book"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("landscape_left", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await act(async () => {
    connected = false;
    socket.onDisconnect();
  });
  await act(async () => {
    connected = true;
    socket.onAdmitted();
  });
  await observe(native("book"));
  expect(model().view).toEqual(rotated);
  await observe(native("laptop", "landscape_left"));
  expect(model().pose).toBe("laptop");
  expect(model().view).toEqual(rotated);
});

test("successful local Tent keeps its view while acknowledgement precedes native readback", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "pose", value: "tent" });
  await frame(0x90, { requestId: requests[0]!.requestId, ok: true });
  expect(controls().pending).toBe(false);
  expectView("tent");
  // An unchanged old observation cannot undo a just-acknowledged preset.
  await observe(native("book", "landscape_right"));
  expectView("tent");
  await observe({
    ...native("book"),
    screenId: 1,
    observedDeviceState: { hingeAngle: 80, physicalOrientation: "facedown", tableMode: true },
  });
  expect(model().pose).toBe("tent");
  expectView("tent");
});

test("a successful preset followed by a failed queued angle retains its newer rotation", async () => {
  await mount();
  await observe(native("book"));
  await request({ control: "pose", value: "laptop" });
  await request({ control: "angle", value: 100 });
  await observe(native("laptop", "landscape_left"));
  await frame(0x90, { requestId: requests[0]!.requestId, ok: true });
  expect(requests).toHaveLength(2);
  expect(controls().pending).toBe(true);
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = duoRotateView(duoPresetView("laptop"), 1);
  expect(model().view).toEqual(rotated);
  await fail("Queued angle failed after Laptop succeeded");
  expect(model().pose).toBe("laptop");
  expect(model().view).toEqual(rotated);
});

test("a successful preset supersedes an earlier rotation before a queued angle fails", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  await observe(native("book", "portrait"));
  await request({ control: "pose", value: "book" });
  await request({ control: "angle", value: 100 });
  await frame(0x90, { requestId: requests[0]!.requestId, ok: true });
  expect(requests).toHaveLength(2);
  await fail("Queued angle failed after Book succeeded");
  expect(model().pose).toBe("book");
  expectView("book");
});

for (const rotateAfterPreset of [false, true]) {
  test(`${rotateAfterPreset ? "a newer" : "an earlier"} rotation is ${rotateAfterPreset ? "retained" : "superseded"} when a queued preset succeeds`, async () => {
    await mount();
    await observe(native("laptop", "landscape_left"));
    const rotate = () =>
      act(async () => {
        renderer!.root
          .findByProps({ "aria-label": "Simulator status" })
          .props.onRotate("portrait", "right");
      });
    await request({ control: "angle", value: 100 });
    if (!rotateAfterPreset) await rotate();
    await request({ control: "pose", value: "book" });
    if (rotateAfterPreset) await rotate();
    await request({ control: "angle", value: 110 });
    await frame(0x90, { requestId: requests[0]!.requestId, ok: true });
    expect(requests).toHaveLength(2);
    await observe(native("book"));
    await frame(0x90, { requestId: requests[1]!.requestId, ok: true });
    expect(requests).toHaveLength(3);
    await fail("Later angle failed after queued Book succeeded");
    if (rotateAfterPreset) expect(model().view).toEqual(duoRotateView(duoPresetView("book"), 1));
    else expectView("book");
  });
}

test("unknown native state preserves external face-down framing and its saved view", async () => {
  await mount();
  await observe(native("book"));
  const faceDown = {
    ...native("book"),
    screenId: 1,
    observedDeviceState: {
      hingeAngle: 110,
      physicalOrientation: "facedown" as const,
      tableMode: true,
    },
  };
  await observe(faceDown);
  expectView("tent");
  const before = structuredClone(model().view as DuoView);
  await observe({ ...faceDown, observedDeviceState: {} });
  expect(model().view).toEqual(before);
  await observe(faceDown);
  expect(model().view).toEqual(before);
  await observe({
    ...native("book"),
    observedDeviceState: { hingeAngle: 110, physicalOrientation: "portrait", tableMode: false },
  });
  expectView("book");
});

test("unknown and late face-down readback preserve an explicit rotation", async () => {
  await mount();
  await observe(native("book"));
  const faceDown = {
    ...native("book"),
    screenId: 1,
    observedDeviceState: {
      hingeAngle: 110,
      physicalOrientation: "facedown" as const,
      tableMode: true,
    },
  };
  await observe(faceDown);
  expectView("tent");
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("landscape_left", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await observe({ ...faceDown, observedDeviceState: {} });
  expect(model().view).toEqual(rotated);
  await observe(faceDown);
  expect(model().view).toEqual(rotated);
});

test("external rotation returning to Book restores the physical Book camera", async () => {
  await mount();
  await observe(native("book", "portrait"));
  const before = structuredClone(model().view as DuoView);
  await observe({
    ...native("book", "portrait"),
    observedDeviceState: { hingeAngle: 90, physicalOrientation: "pud", tableMode: false },
  });
  await observe(native("book", "portrait"));
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...before.rotation)),
  ).toBeCloseTo(0, 6);
});
test("external Laptop after an external quarter turn restores the tabletop camera", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  const before = structuredClone(model().view as DuoView);
  await observe({
    ...native("laptop", "landscape_left"),
    observedDeviceState: { hingeAngle: 90, physicalOrientation: "pud", tableMode: false },
  });
  await observe(native("laptop", "landscape_left"));
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...before.rotation)),
  ).toBeCloseTo(0, 6);
});
test("unconfirmed UI rotation yields to native after grace without another config", async () => {
  await mount();
  await observe(opened("portrait", "landscape_left"));
  const before = structuredClone(model().view as DuoView);
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  await act(async () => {
    await Bun.sleep(1600);
  });
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...before.rotation)),
  ).toBeCloseTo(0, 6);
});

test("a pending hinge and expired grace do not apply a delayed UI rotation twice", async () => {
  await mount();
  const config = {
    ...opened("portrait", "landscape_left"),
    observedDeviceState: {
      hingeAngle: 100,
      physicalOrientation: "portrait" as const,
      tableMode: false,
    },
  };
  await observe(config);
  await request({ control: "angle", value: 110 });
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await act(async () => {
    await Bun.sleep(1600);
  });
  expect(model().view).toEqual(rotated);
  await frame(0x90, { requestId: requests.at(-1)!.requestId, ok: true });
  await observe({
    ...config,
    observedDeviceState: {
      hingeAngle: 110,
      physicalOrientation: "landscape-left",
      tableMode: false,
    },
  });
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...rotated.rotation)),
  ).toBeCloseTo(0, 6);
});

test("external Laptop to Open uses the canonical front-on camera", async () => {
  await mount();
  await observe(native("laptop", "landscape_left"));
  await observe({
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation: "portrait",
    supportsHingeAngle: true,
    observedDeviceState: { hingeAngle: 180, physicalOrientation: "portrait", tableMode: false },
  });
  expectView("open");
});

const observedPresets = [
  { pose: "closed", angle: 0, physical: "portrait", table: false },
  { pose: "open", angle: 180, physical: "portrait", table: false },
  { pose: "book", angle: 90, physical: "portrait", table: false },
  { pose: "laptop", angle: 90, physical: "landscape-left", table: false },
  { pose: "tent", angle: 80, physical: "facedown", table: true },
] as const;
function externalPreset(preset: (typeof observedPresets)[number]): StreamConfig {
  return {
    width: 2007,
    height: 2853,
    screenId: preset.angle === 0 || preset.table ? 1 : 3,
    orientation: "landscape_right",
    supportsHingeAngle: true,
    observedDeviceState: {
      hingeAngle: preset.angle,
      physicalOrientation: preset.physical,
      tableMode: preset.table,
    },
  };
}
for (const from of observedPresets)
  for (const to of observedPresets) {
    if (from === to) continue;
    test(`external ${from.pose} → ${to.pose} frames the physical preset with stale app geometry`, async () => {
      await mount();
      await observe(externalPreset(from));
      await observe(externalPreset(to));
      expectView(to.pose);
    });
  }

test("an early UI turn is not doubled by old then current native samples", async () => {
  await mount();
  await observe({
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation: "landscape_left",
    supportsHingeAngle: true,
    observedDeviceState: {},
  });
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await observe(opened("portrait", "landscape_left"));
  expectView("open");
  await observe(opened("landscape-left", "portrait"));
  expect(model().view).toEqual(rotated);
  await act(async () => {
    await Bun.sleep(1600);
  });
  expect(model().view).toEqual(rotated);
  await observe(opened("pud", "landscape_right"));
  const expected = duoRotateView(rotated, 1);
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
});

test("an early confirmed UI turn followed by another native turn updates the camera before grace expires", async () => {
  await mount();
  await observe({
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation: "landscape_left",
    supportsHingeAngle: true,
    observedDeviceState: {},
  });
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  const rotated = structuredClone(model().view as DuoView);
  await observe(opened("landscape-left", "portrait"));
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...rotated.rotation)),
  ).toBeCloseTo(0, 6);
  await observe(opened("pud", "portrait"));
  const expected = duoRotateView(rotated, 1);
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
});

test("first physical readback preserves a locally edited Laptop anchor and follows the next turn", async () => {
  await mount();
  const config = {
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation: "landscape_left" as const,
    supportsHingeAngle: true,
    observedDeviceState: {},
  };
  await observe(config);
  await request({ control: "pose", value: "laptop" });
  await frame(0x90, { requestId: requests.at(-1)!.requestId, ok: true });
  await request({ control: "angle", value: 100 });
  await frame(0x90, { requestId: requests.at(-1)!.requestId, ok: true });
  await act(async () => {
    renderer!.root
      .findByProps({ "aria-label": "Simulator status" })
      .props.onRotate("portrait", "right");
  });
  await observe({
    ...config,
    observedDeviceState: {
      hingeAngle: 100,
      physicalOrientation: "landscape-left",
      tableMode: false,
    },
  });
  expectView("laptop");
  await observe({
    ...config,
    observedDeviceState: { hingeAngle: 100, physicalOrientation: "pud", tableMode: false },
  });
  const expected = duoRotateView(duoPresetView("laptop"), 1);
  expect(model().view.fixedLeftFold).toBe(expected.fixedLeftFold);
  expect(
    new Quaternion(...model().view.rotation).angleTo(new Quaternion(...expected.rotation)),
  ).toBeCloseTo(0, 6);
});

test("an angle-only native update reconciles an expired optimistic rotation before its timer runs", async () => {
  await mount();
  const custom = {
    width: 2007,
    height: 2853,
    screenId: 3,
    orientation: "portrait" as const,
    supportsHingeAngle: true,
    observedDeviceState: {
      hingeAngle: 100,
      physicalOrientation: "portrait" as const,
      tableMode: false,
    },
  };
  await observe(custom);
  const before = structuredClone(model().view as DuoView);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await act(async () => {
      renderer!.root
        .findByProps({ "aria-label": "Simulator status" })
        .props.onRotate("landscape_left", "right");
    });
    const optimistic = model().view as DuoView;
    expect(
      (new Quaternion(...optimistic.rotation).angleTo(new Quaternion(...before.rotation)) * 180) /
        Math.PI,
    ).toBeCloseTo(90, 6);
    // A busy browser may receive this config after the deadline while the
    // scheduled timer callback is still queued. The native pose is custom
    // both times: only the hinge angle changes, not orientation or app geometry.
    now += 1501;
    await observe({
      ...custom,
      observedDeviceState: { ...custom.observedDeviceState, hingeAngle: 110 },
    });
    expect(
      (new Quaternion(...model().view.rotation).angleTo(new Quaternion(...before.rotation)) * 180) /
        Math.PI,
    ).toBeCloseTo(0, 6);
  } finally {
    Date.now = realNow;
  }
});
