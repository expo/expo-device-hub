import { beforeEach, expect, mock, test } from "bun:test";

let sendResult = "sent";
let sent = 0;
let disconnected: (() => void) | undefined;
let cameraStopped: (() => void) | undefined;
mock.module("../../client/utils/exec", () => ({
  sendCameraFrame() { sent++; return sendResult; },
  stopCameraFrames() {},
  onCameraStopped(_udid: string, listener: () => void) {
    cameraStopped = listener;
    return () => { cameraStopped = undefined; };
  },
  onExecDisconnect(listener: () => void) {
    disconnected = listener;
    return () => { disconnected = undefined; };
  },
}));
const {
  BROWSER_CAMERA_FRAME_BLOCKED,
  heldBrowserCamera,
  holdBrowserCamera,
  onBrowserCameraFailure,
  releaseBrowserCamera,
  reportBrowserCameraFailure,
  startBrowserCamera,
  stopBrowserCameraExcept,
  takeBrowserCameraFailure,
} = await import("../../client/utils/browser-camera");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Track extends EventTarget {
  label = "Test camera";
  stops = 0;
  stop() { this.stops++; }
}
let track: Track;
let errors: string[];
let media: () => Promise<unknown>;
let play: () => Promise<void>;
let controller: AbortController;
let encoded: (() => void) | undefined;
let holdEncoding = false;
const globals = globalThis as Record<string, unknown>;
let pageHideListeners: Set<() => void>;

beforeEach(() => {
  track = new Track();
  errors = [];
  sent = 0;
  sendResult = "sent";
  disconnected = undefined;
  cameraStopped = undefined;
  encoded = undefined;
  holdEncoding = false;
  controller = new AbortController();
  media = async () => ({ getTracks: () => [track], getVideoTracks: () => [track] });
  play = async () => {};
  globals.navigator = { mediaDevices: { getUserMedia: () => media() } };
  pageHideListeners = new Set();
  globals.window = {
    addEventListener(name: string, listener: () => void) { if (name === "pagehide") pageHideListeners.add(listener); },
    removeEventListener(name: string, listener: () => void) { if (name === "pagehide") pageHideListeners.delete(listener); },
  };
  globals.document = {
    createElement(tag: string) {
      if (tag === "video") return { readyState: 2, videoWidth: 1920, videoHeight: 1080, play: () => play() };
      return {
        getContext: () => ({ drawImage() {} }),
        toBlob(callback: (blob: Blob) => void) {
          const complete = () => callback(new Blob([new Uint8Array([1, 2, 3])]));
          if (holdEncoding) encoded = complete;
          else complete();
        },
      };
    },
  };
});
const begin = () => startBrowserCamera({ udid: "DEVICE-A", signal: controller.signal, onError: (message) => errors.push(message) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

test("releases tracks when permission resolves after cancellation", async () => {
  const pending = deferred<unknown>();
  media = () => pending.promise;
  const opening = begin();
  controller.abort();
  pending.resolve({ getTracks: () => [track], getVideoTracks: () => [track] });
  await expect(opening).rejects.toThrow();
  expect(track.stops).toBe(1);
  expect(sent).toBe(0);
});

test("abort while video playback is pending stops tracks immediately", async () => {
  const pending = deferred<void>();
  play = () => pending.promise;
  const opening = begin();
  await flush();
  controller.abort();
  expect(track.stops).toBe(1);
  pending.resolve();
  await expect(opening).rejects.toThrow();
  expect(track.stops).toBe(1);
});

test("sends nothing until started and stops tracks exactly once", async () => {
  const session = await begin();
  await flush();
  expect(sent).toBe(0);
  session.start();
  await flush();
  expect(sent).toBe(1);
  session.stop();
  session.stop();
  controller.abort();
  expect(track.stops).toBe(1);
});

test("stopping during encoding discards the late frame", async () => {
  holdEncoding = true;
  const session = await begin();
  session.start();
  session.stop();
  encoded?.();
  await flush();
  expect(sent).toBe(0);
  expect(track.stops).toBe(1);
});

test("backpressure drops remain nonfatal", async () => {
  sendResult = "dropped";
  const session = await begin();
  session.start();
  await flush();
  expect(track.stops).toBe(0);
  expect(errors).toEqual([]);
  session.stop();
});

test("transport loss releases the camera immediately", async () => {
  const session = await begin();
  session.start();
  disconnected?.();
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("connection closed");
  session.stop();
  expect(track.stops).toBe(1);
});

test("an ended track stops the session and reports a reconnect action", async () => {
  const session = await begin();
  session.start();
  track.dispatchEvent(new Event("ended"));
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("reconnect");
  session.stop();
});

test("ownership loss releases tracks and explains how to reconnect", async () => {
  const session = await begin();
  session.start();
  cameraStopped?.();
  expect(track.stops).toBe(1);
  expect(errors[0]).toContain("another session");
  expect(cameraStopped).toBeUndefined();
  session.stop();
  expect(track.stops).toBe(1);
});

function fakeSession(counter: { stops: number }) {
  return { label: "Held camera", start() {}, stop() { counter.stops++; } };
}
const hold = (udid: string, counter: { stops: number }) => {
  const session = fakeSession(counter);
  holdBrowserCamera({ udid, session, abort: new AbortController() });
  return session;
};

test("holding a replacement stops the feed it supersedes", () => {
  const first = { stops: 0 };
  hold("DEVICE-A", first);
  const second = { stops: 0 };
  hold("DEVICE-A", second);
  expect(first.stops).toBe(1);
  expect(second.stops).toBe(0);
  expect(heldBrowserCamera("DEVICE-A")?.session.label).toBe("Held camera");
  releaseBrowserCamera("DEVICE-A");
  expect(second.stops).toBe(0);
});

test("a feed for a device the page left is stopped, the shown one is kept", () => {
  const counter = { stops: 0 };
  hold("DEVICE-A", counter);
  stopBrowserCameraExcept("DEVICE-A");
  expect(counter.stops).toBe(0);
  expect(heldBrowserCamera("DEVICE-A")).not.toBeNull();
  stopBrowserCameraExcept("DEVICE-B");
  expect(counter.stops).toBe(1);
  expect(heldBrowserCamera("DEVICE-A")).toBeNull();
});

test("a failure drops the held feed so no later mount adopts a stopped session", () => {
  const counter = { stops: 0 };
  const abort = new AbortController();
  holdBrowserCamera({ udid: "DEVICE-A", session: fakeSession(counter), abort });
  const seen: string[] = [];
  const off = onBrowserCameraFailure((udid, failed, message) => {
    if (failed === abort) seen.push(`${udid}:${message}`);
  });
  reportBrowserCameraFailure("DEVICE-A", abort, "The camera stopped.");
  off();
  expect(seen).toEqual(["DEVICE-A:The camera stopped."]);
  expect(heldBrowserCamera("DEVICE-A")).toBeNull();
});

test("a failed held feed keeps its reason for the next panel once", () => {
  const abort = new AbortController();
  holdBrowserCamera({ udid: "DEVICE-A", session: fakeSession({ stops: 0 }), abort });
  reportBrowserCameraFailure("DEVICE-A", abort, "The camera stopped.");
  expect(takeBrowserCameraFailure("DEVICE-B")).toBeNull();
  expect(takeBrowserCameraFailure("DEVICE-A")).toBe("The camera stopped.");
  expect(takeBrowserCameraFailure("DEVICE-A")).toBeNull();
});

test("a failure shown by an open panel is not kept", () => {
  const abort = new AbortController();
  holdBrowserCamera({ udid: "DEVICE-A", session: fakeSession({ stops: 0 }), abort });
  const off = onBrowserCameraFailure(() => {});
  reportBrowserCameraFailure("DEVICE-A", abort, "The camera stopped.");
  off();
  expect(takeBrowserCameraFailure("DEVICE-A")).toBeNull();
});

test("page hide stops a feed that outlived its tool", () => {
  const counter = { stops: 0 };
  hold("DEVICE-A", counter);
  for (const listener of pageHideListeners) listener();
  expect(counter.stops).toBe(1);
  expect(heldBrowserCamera("DEVICE-A")).toBeNull();
  expect(pageHideListeners.size).toBe(0);
});

test("a frame that blocks the camera asks the embedding page and does not open the camera", async () => {
  const posted: unknown[] = [];
  let opened = 0;
  media = async () => { opened++; return { getTracks: () => [track], getVideoTracks: () => [track] }; };
  Object.assign(globals.window as object, {
    parent: { postMessage: (message: unknown) => posted.push(message) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  Object.assign(globals.document as object, { permissionsPolicy: { allowsFeature: () => false } });
  await expect(startBrowserCamera({ udid: "A", signal: controller.signal, onError: (message) => errors.push(message) }))
    .rejects.toThrow(BROWSER_CAMERA_FRAME_BLOCKED);
  expect(posted).toEqual([{ type: "serve-sim:permission-request", permission: "camera" }]);
  expect(opened).toBe(0);
});

test("a frame that allows the camera opens it without asking the embedding page", async () => {
  const posted: unknown[] = [];
  let opened = 0;
  media = async () => { opened++; return { getTracks: () => [track], getVideoTracks: () => [track] }; };
  Object.assign(globals.window as object, { parent: { postMessage: (message: unknown) => posted.push(message) } });
  Object.assign(globals.document as object, { permissionsPolicy: { allowsFeature: (feature: string) => feature === "camera" } });
  const session = await startBrowserCamera({ udid: "A", signal: controller.signal, onError: (message) => errors.push(message) });
  session.stop();
  expect(posted).toEqual([]);
  expect(opened).toBe(1);
});
