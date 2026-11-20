import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let unavailable = false;
const input = mock(() => {});
mock.module("../../client/simulator/duo-scene", () => ({
  createDuoScene: (
    _host: unknown,
    _source: unknown,
    _state: unknown,
    callbacks: { ready(): void; error(): void },
  ) => {
    if (unavailable) callbacks.error();
    else callbacks.ready();
    return { dispose() {} };
  },
}));
const stream = {} as MediaStream;
mock.module("../../client/hooks/use-webrtc-stream", () => ({
  useWebRtcStream: () => ({ stream }),
}));
mock.module("../../client/hooks/use-mjpeg-stream", () => ({ useMjpegStream: () => ({}) }));
const { DuoModelView } = await import("../../client/components/duo-model-view");
const { DuoPanelStreams } = await import("../../client/components/duo-panel-streams");
const { SimulatorView } = await import("../../client/simulator/simulator-view");

let dom: Window;
let root: Root;
let container: HTMLDivElement;
let allowed: Set<HTMLVideoElement>;
let calls: HTMLVideoElement[];
beforeEach(() => {
  unavailable = false;
  dom = new Window();
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  container = dom.document.createElement("div") as unknown as HTMLDivElement;
  dom.document.body.append(container as never);
  root = createRoot(container);
  allowed = new Set();
  calls = [];
  input.mockClear();
  Object.defineProperty(dom.HTMLVideoElement.prototype, "srcObject", {
    configurable: true,
    writable: true,
    value: null,
  });
  Object.defineProperty(dom.HTMLVideoElement.prototype, "play", {
    configurable: true,
    value(this: HTMLVideoElement) {
      calls.push(this);
      if (!allowed.has(this)) {
        return Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
      }
      Object.defineProperty(this, "paused", { value: false, configurable: true });
      this.dispatchEvent(new dom.Event("playing") as never);
      return Promise.resolve();
    },
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(container.querySelector("button")).toBeNull();
  await dom.happyDOM.close();
});

async function render(screenId: 1 | 3, panels = true) {
  await act(async () =>
    root.render(
      <DuoModelView onTouch={input} onScroll={input}>
        {(target) =>
          panels ? (
            <DuoPanelStreams
              streamUrl="http://localhost/stream.avcc"
              mode="webrtc"
              activeScreenId={screenId}
              playbackOverlayTarget={target}
              codec="h264"
              onStreamingChange={input}
              onAvccError={input}
              onWebRtcFailure={input}
              onWebRtcPeerChange={input}
            />
          ) : (
            <SimulatorView
              url="http://localhost"
              streamMode="webrtc"
              webRtcStream={stream}
              playbackOverlayTarget={target}
              onStreamTouch={input}
              hideControls
            />
          )
        }
      </DuoModelView>,
    ),
  );
}

function recovery() {
  const buttons = [...container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Start live view",
  );
  expect(buttons).toHaveLength(1);
  const button = buttons[0]!;
  expect(button.closest('[aria-hidden="true"]')).toBeNull();
  expect(button.closest("[data-duo-panel]")).toBeNull();
  return button;
}

test("only the active panel exposes recovery, outside the hidden source, with no device input", async () => {
  await render(1);
  const videos = [...container.querySelectorAll("video")];
  expect(videos).toHaveLength(2);
  const button = recovery();
  allowed.add(videos[0]!);
  calls.length = 0;
  input.mockClear();
  await act(async () => {
    button.click();
    expect(calls).toEqual([videos[0]!]);
  });
  expect(input).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Start live view");
  await render(3);
  const secondButton = recovery();
  expect([...container.querySelectorAll("video")]).toEqual(videos);
  allowed.add(videos[1]!);
  calls.length = 0;
  await act(async () => {
    secondButton.click();
    expect(calls).toEqual([videos[1]!]);
  });
  expect(container.textContent).not.toContain("Start live view");
});

for (const sceneUnavailable of [false, true])
  test(`single-stream recovery with unavailable scene: ${sceneUnavailable}`, async () => {
    unavailable = sceneUnavailable;
    await render(1, false);
    expect(
      container.querySelector(`[data-duo-model="${sceneUnavailable ? "unavailable" : "ready"}"]`),
    ).not.toBeNull();
    const button = recovery();
    const video = container.querySelector("video")!;
    allowed.add(video);
    await act(async () => button.click());
    expect(container.textContent).not.toContain("Start live view");
  });
