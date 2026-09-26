import { afterEach, expect, mock, test } from "bun:test";
import * as React from "react";

type Effect = { deps: readonly unknown[]; cleanup?: () => void };
const slots: unknown[] = [];
let slot = 0;
let pendingEffects: (() => void)[] = [];
let setters = 0;
let stops = 0;
const hostActions: string[] = [];
const hostActionParams: Record<string, string | undefined>[] = [];
const failingActions: string[] = [];
let status: unknown = null;
let poll: (() => void) | undefined;
let pagehide: (() => void) | undefined;
const defaultOpenCamera = async () => ({ label: "Test camera", start() {}, stop() { stops++; } });
let openCamera = defaultOpenCamera;
const cleanups: (() => void)[] = [];
const same = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
  !!left && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

mock.module("react", () => ({
  ...React,
  useState<T>(initial: T | (() => T)) {
    const index = slot++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
    return [slots[index], (next: T | ((current: T) => T)) => {
      setters++;
      slots[index] = typeof next === "function" ? (next as (current: T) => T)(slots[index] as T) : next;
    }];
  },
  useRef<T>(initial: T) {
    const index = slot++;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  },
  useCallback<T>(callback: T, deps: readonly unknown[]) {
    const index = slot++;
    const previous = slots[index] as { callback: T; deps: readonly unknown[] } | undefined;
    if (!same(previous?.deps, deps)) slots[index] = { callback, deps };
    return (slots[index] as { callback: T }).callback;
  },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const index = slot++;
    const previous = slots[index] as Effect | undefined;
    if (same(previous?.deps, deps)) return;
    pendingEffects.push(() => {
      previous?.cleanup?.();
      const cleanup = effect() || undefined;
      slots[index] = { deps, cleanup };
      if (cleanup) cleanups.push(cleanup);
    });
  },
}));
mock.module("../../client/utils/exec", () => ({
  runHostAction: async (action: string, params: Record<string, string | undefined> = {}) => {
    hostActions.push(action);
    hostActionParams.push(params);
    if (failingActions[0] === action) {
      failingActions.shift();
      return { exitCode: 1, stdout: "", stderr: "the webcam is busy" };
    }
    const stdout = action === "camera.listWebcams" ? "cam-1\tStudio Display Camera\n" : "";
    return { exitCode: 0, stdout, stderr: "" };
  },
  stopCameraFrames() {},
}));
type HeldCamera = {
  udid: string;
  session: { label: string; start(): void; stop(): void };
  abort: AbortController;
};
let heldCamera: HeldCamera | null = null;
let failedCameraMessage: string | null = null;
type FailureListener = (udid: string, abort: AbortController, message: string) => void;
const failureListeners = new Set<FailureListener>();
mock.module("../../client/utils/browser-camera", () => ({
  BROWSER_CAMERA_FRAME_BLOCKED: "frame blocked",
  BROWSER_CAMERA_UNSUPPORTED: "unsupported",
  browserCameraSupported: () => true,
  browserCameraErrorMessage: (error: unknown) => String(error),
  takeBrowserCameraFailure: (_udid: string) => {
    const message = failedCameraMessage;
    failedCameraMessage = null;
    return message;
  },
  startBrowserCamera: () => openCamera(),
  heldBrowserCamera: (udid: string) => (heldCamera && heldCamera.udid === udid ? heldCamera : null),
  holdBrowserCamera: (value: HeldCamera) => { heldCamera = value; },
  releaseBrowserCamera: (udid: string) => {
    if (heldCamera && heldCamera.udid === udid) heldCamera = null;
  },
  stopBrowserCameraExcept: (udid: string) => {
    if (heldCamera && heldCamera.udid !== udid) {
      heldCamera.session.stop();
      heldCamera = null;
    }
  },
  reportBrowserCameraFailure: (udid: string, abort: AbortController, message: string) => {
    if (heldCamera && heldCamera.abort === abort) {
      heldCamera = null;
      if (failureListeners.size === 0) failedCameraMessage = message;
    }
    for (const listener of Array.from(failureListeners)) listener(udid, abort, message);
  },
  onBrowserCameraFailure: (listener: FailureListener) => {
    failureListeners.add(listener);
    return () => { failureListeners.delete(listener); };
  },
}));
let frameBlocked = false;
const frameRequests: string[] = [];
mock.module("../../client/utils/frame-permission", () => ({
  framePolicyBlocks: () => frameBlocked,
  requestFramePermission: (permission: string) => { frameRequests.push(permission); },
}));
const globals = globalThis as Record<string, unknown>;
globals.window = {
  __SIM_PREVIEW__: { cameraStatusEndpoint: "/status" },
  addEventListener(name: string, callback: () => void) { if (name === "pagehide") pagehide = callback; },
  removeEventListener() {},
};
globals.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
globals.fetch = async () => status === null ? new Response("unavailable", { status: 503 }) : Response.json(status);
globals.setInterval = (callback: () => void) => { poll = callback; return 1; };
globals.clearInterval = () => { poll = undefined; };
const { CameraTool } = await import("../../client/components/camera-tool");
const { reportBrowserCameraFailure } = await import("../../client/utils/browser-camera");
let tree: unknown;
function render() {
  slot = 0;
  pendingEffects = [];
  tree = CameraTool({ udid: "DEVICE-A" });
  for (const effect of pendingEffects) effect();
}
function findProps(node: unknown, key: string, value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, key, value);
      if (found) return found;
    }
  }
  if (node && typeof node === "object" && "props" in node) {
    const props = node.props as Record<string, unknown>;
    if (props[key] === value) return props;
    return findProps(props.children, key, value);
  }
}
function click(key: string, value: string) {
  const props = findProps(tree, key, value);
  expect(props).toBeDefined();
  (props!.onClick as () => void)();
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  slots.length = 0;
  setters = 0;
  stops = 0;
  status = null;
  hostActions.length = 0;
  hostActionParams.length = 0;
  failingActions.length = 0;
  heldCamera = null;
  failedCameraMessage = null;
  failureListeners.clear();
  openCamera = defaultOpenCamera;
  frameBlocked = false;
  frameRequests.length = 0;
});

test("a failed initial poll does not consume restoration", async () => {
  render();
  await flush();
  expect(setters).toBe(0);
  status = { alive: true, source: "image", arg: "/tmp/restored.png", mirror: "off" };
  poll?.();
  await flush();
  render();
  expect(findProps(tree, "fileName", "restored.png")).toBeDefined();
});

test("failed status polls preserve live browser tracks, explicit dead status stops them", async () => {
  status = { alive: true, connected: false, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(findProps(tree, "webcamName", "Test camera")).toBeDefined();
  expect(stops).toBe(0);
  status = null;
  poll?.();
  await flush();
  expect(stops).toBe(0);
  status = { alive: false };
  poll?.();
  await flush();
  expect(stops).toBe(1);
});

test("pagehide cancels pending acquisition without leaving the panel busy", async () => {
  let complete!: (session: { label: string; start(): void; stop(): void }) => void;
  openCamera = () => new Promise((resolve) => { complete = resolve; });
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  render();
  click("aria-label", "Enable");
  render();
  expect(findProps(tree, "aria-label", "Cancel")).toBeDefined();
  pagehide?.();
  render();
  expect(findProps(tree, "aria-label", "Enable")).toBeDefined();
  expect(findProps(tree, "aria-label", "Choose camera source")?.disabled).toBe(false);
  complete({ label: "Late camera", start() {}, stop() { stops++; } });
  await flush();
  expect(stops).toBe(1);
});

test("Cancel during permission acquisition does not disable another viewer's camera", async () => {
  let complete!: (session: { label: string; start(): void; stop(): void }) => void;
  openCamera = () => new Promise((resolve) => { complete = resolve; });
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  render();
  click("aria-label", "Enable");
  render();
  click("aria-label", "Cancel");
  render();
  expect(findProps(tree, "aria-label", "Enable")).toBeDefined();
  complete({ label: "Late camera", start() {}, stop() { stops++; } });
  await flush();
  expect(stops).toBe(1);
  expect(hostActions).not.toContain("camera.stopWebcam");
  expect(hostActions).not.toContain("camera.inject");
});

test("closing the tools panel keeps the feed and the next mount adopts it", async () => {
  status = { alive: true, connected: true, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(findProps(tree, "webcamName", "Test camera")).toBeDefined();

  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(stops).toBe(0);

  slots.length = 0;
  render();
  await flush();
  render();
  expect(findProps(tree, "webcamName", "Test camera")).toBeDefined();
  expect(stops).toBe(0);

  pagehide?.();
  expect(stops).toBe(1);
});

test("a browser feed failure while the panel is closed appears when it reopens", async () => {
  status = { alive: true, connected: true, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(heldCamera).not.toBeNull();

  for (const cleanup of cleanups.splice(0)) cleanup();
  reportBrowserCameraFailure("DEVICE-A", heldCamera!.abort, "The camera stopped.");
  slots.length = 0;
  render();
  await flush();
  render();
  expect(findProps(tree, "message", "The camera stopped.")).toBeDefined();

  for (const cleanup of cleanups.splice(0)) cleanup();
  slots.length = 0;
  render();
  await flush();
  render();
  expect(findProps(tree, "message", "The camera stopped.")).toBeUndefined();
});

test("a closed-panel failure is dropped when another session changed the source", async () => {
  status = { alive: true, connected: true, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();

  for (const cleanup of cleanups.splice(0)) cleanup();
  reportBrowserCameraFailure("DEVICE-A", heldCamera!.abort, "The camera stopped.");
  status = { alive: true, connected: true, source: "webcam", arg: "cam-1", mirror: "off" };
  slots.length = 0;
  render();
  await flush();
  render();
  expect(findProps(tree, "mode", "webcam")).toBeDefined();
  expect(findProps(tree, "message", "The camera stopped.")).toBeUndefined();
});

test("picking a webcam starts it even when the camera is disabled", async () => {
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  await flush();
  render();
  click("children", "Studio Display Camera");
  await flush();
  render();
  await flush();
  expect(hostActions.filter((action) => action === "camera.inject")).toEqual(["camera.inject"]);
  expect(hostActionParams.at(-1)?.target).toBe("cam-1");
});

test("picking a webcam on a running feed switches instead of enabling again", async () => {
  status = { alive: true, connected: true, source: "placeholder", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  await flush();
  render();
  click("children", "Studio Display Camera");
  await flush();
  render();
  await flush();
  expect(hostActions).toContain("camera.switch");
  expect(hostActions).not.toContain("camera.inject");
});

test("a camera started elsewhere is shown, not switched to this panel's source", async () => {
  status = { alive: false };
  render();
  await flush();
  render();
  status = { alive: true, connected: true, source: "image", arg: "/tmp/face.png", mirror: "off" };
  poll?.();
  await flush();
  render();
  await flush();
  render();
  expect(hostActions).not.toContain("camera.switch");
  expect(findProps(tree, "fileName", "face.png")).toBeDefined();
});

for (const order of ["status first", "list first"]) {
  test(`a default webcam restored while the list loads stays the default (${order})`, async () => {
    status = { alive: false };
    render();
    await flush();
    render();
    status = { alive: true, connected: true, source: "webcam", mirror: "off" };
    if (order === "status first") {
      poll?.();
      await flush();
      click("aria-label", "Choose camera source");
    } else {
      click("aria-label", "Choose camera source");
      await flush();
      poll?.();
    }
    await flush();
    render();
    await flush();
    render();
    expect(hostActions).toContain("camera.listWebcams");
    expect(hostActions).not.toContain("camera.switch");
  });
}

async function failSwitchAwayFromBrowser(afterFailure: unknown) {
  status = { alive: true, connected: true, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(heldCamera).not.toBeNull();

  failingActions.push("camera.switch");
  status = afterFailure;
  click("aria-label", "Choose camera source");
  await flush();
  render();
  click("children", "Studio Display Camera");
  for (let i = 0; i < 4; i++) { await flush(); render(); }
  return hostActionParams.filter((_, i) => hostActions[i] === "camera.switch").map((p) => p.source);
}

test("a failed switch away from the browser camera reconnects it", async () => {
  const switches = await failSwitchAwayFromBrowser({ alive: true, connected: false, source: "none", mirror: "off" });
  expect(switches).toEqual(["stream", "webcam", "stream"]);
  expect(heldCamera).not.toBeNull();
  expect(findProps(tree, "webcamName", "Test camera")).toBeDefined();
});

test("a failed switch leaves a source restored by the helper alone", async () => {
  const switches = await failSwitchAwayFromBrowser({ alive: true, connected: true, source: "placeholder", mirror: "off" });
  expect(switches).toEqual(["stream", "webcam"]);
  expect(heldCamera).toBeNull();
});

test("a failed switch whose readback fails still shows the helper's source on the next poll", async () => {
  status = { alive: true, connected: true, source: "image", arg: "/tmp/face.png", mirror: "off" };
  render();
  await flush();
  render();
  expect(findProps(tree, "fileName", "face.png")).toBeDefined();

  failingActions.push("camera.switch");
  click("aria-label", "Choose camera source");
  await flush();
  render();
  status = null;
  click("children", "Studio Display Camera");
  for (let i = 0; i < 4; i++) { await flush(); render(); }
  expect(findProps(tree, "fileName", "face.png")).toBeUndefined();

  status = { alive: true, connected: true, source: "image", arg: "/tmp/face.png", mirror: "off" };
  poll?.();
  await flush();
  render();
  expect(findProps(tree, "fileName", "face.png")).toBeDefined();
});

test("a source set by another session updates an active image panel", async () => {
  status = { alive: true, connected: true, source: "image", arg: "/tmp/face.png", mirror: "off" };
  render();
  await flush();
  render();
  expect(findProps(tree, "fileName", "face.png")).toBeDefined();

  status = { alive: true, connected: true, source: "webcam", arg: "cam-2", mirror: "off" };
  poll?.();
  await flush();
  render();
  expect(findProps(tree, "mode", "webcam")).toBeDefined();
  expect(findProps(tree, "webcamName", "cam-2")).toBeDefined();
  expect(hostActions).not.toContain("camera.switch");
});

test("a source set by another session replaces this tab's browser camera in the panel", async () => {
  status = { alive: true, connected: true, source: "stream", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  render();
  click("children", "Browser camera");
  await flush();
  render();
  expect(heldCamera).not.toBeNull();

  status = { alive: true, connected: true, source: "image", arg: "/tmp/face.png", mirror: "off" };
  poll?.();
  await flush();
  render();
  expect(heldCamera).toBeNull();
  expect(findProps(tree, "fileName", "face.png")).toBeDefined();
});

test("listing webcams does not move the helper's default camera", async () => {
  status = { alive: true, connected: true, source: "webcam", mirror: "off" };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  await flush();
  render();
  await flush();
  render();
  expect(hostActions).toContain("camera.listWebcams");
  expect(hostActions).not.toContain("camera.switch");
});

test("picking Browser camera in a frame that blocks it asks the embedding page and opens nothing", async () => {
  frameBlocked = true;
  let opened = 0;
  openCamera = async () => { opened++; return defaultOpenCamera(); };
  status = { alive: false };
  render();
  await flush();
  render();
  click("aria-label", "Choose camera source");
  await flush();
  render();
  (findProps(tree, "data-camera-browser-source", true)!.onClick as () => void)();
  await flush();
  render();
  await flush();
  expect(frameRequests).toEqual(["camera"]);
  expect(opened).toBe(0);
  expect(hostActions.filter((action) => action.startsWith("camera.") && action !== "camera.listWebcams")).toEqual([]);
  expect(findProps(tree, "message", "frame blocked")).toBeDefined();
});

test("the first status reply keeps an error the user caused while it was pending", async () => {
  frameBlocked = true;
  status = { alive: true, connected: true, source: "webcam", arg: "cam-1", mirror: "off" };
  const answered = globals.fetch as () => Promise<Response>;
  let answer = () => {};
  globals.fetch = () => new Promise<Response>((resolve) => { answer = () => resolve(answered()); });
  try {
    render();
    click("aria-label", "Choose camera source");
    await flush();
    render();
    (findProps(tree, "data-camera-browser-source", true)!.onClick as () => void)();
    await flush();
    render();
    expect(findProps(tree, "message", "frame blocked")).toBeDefined();

    answer();
    await flush();
    render();
    expect(findProps(tree, "mode", "webcam")).toBeDefined();
    expect(findProps(tree, "message", "frame blocked")).toBeDefined();
  } finally {
    globals.fetch = answered;
  }
});
