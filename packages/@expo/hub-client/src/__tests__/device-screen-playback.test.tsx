import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeviceScreen } from "../DeviceScreen";
import type { DeviceScreenInputProps } from "../types";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let dom: Window;
let root: Root;
let container: HTMLDivElement;
let video: HTMLVideoElement;
let denied: boolean;
let calls: number;
let inputs: unknown[];
let client: DeviceScreenInputProps["client"];

beforeEach(async () => {
  dom = new Window();
  denied = true;
  calls = 0;
  inputs = [];
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", dom);
  stubGlobal("document", dom.document);
  container = dom.document.createElement("div") as unknown as HTMLDivElement;
  dom.document.body.append(container as never);
  root = createRoot(container);
  const attachVideo = (element: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | null) => {
    if (!element) return;
    video = element as HTMLVideoElement;
    Object.defineProperty(video, "srcObject", { value: {}, configurable: true });
    Object.defineProperty(video, "play", {
      value: () => {
        calls++;
        if (denied) return Promise.reject(Object.assign(new Error(), { name: "NotAllowedError" }));
        Object.defineProperty(video, "paused", { value: false, configurable: true });
        video.dispatchEvent(new dom.Event("playing") as never);
        return Promise.resolve();
      },
      configurable: true,
    });
  };
  client = {
    ...NOOP_DEVICE_CLIENT,
    videoKind: "video",
    status: "streaming",
    attachVideo,
    sendTouch: (input) => inputs.push(input),
    sendKey: (input) => {
      inputs.push(input);
      return true;
    },
  };
  await act(async () => root.render(<DeviceScreen client={client} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  restoreGlobals();
});

test("blocked autoplay exposes a trusted-click recovery above the device input", async () => {
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("Start live view");
  const source = video.srcObject;
  const callsBefore = calls;
  denied = false;
  await act(async () => {
    button.dispatchEvent(new dom.PointerEvent("pointerdown", { bubbles: true }) as never);
    button.dispatchEvent(new dom.PointerEvent("pointerup", { bubbles: true }) as never);
    button.click();
    expect(calls).toBe(callsBefore + 1);
  });
  expect(container.querySelector("button")).toBeNull();
  expect(inputs).toEqual([]);
  expect(video.srcObject).toBe(source);
});

test("a failed click retains recovery and the native pause event restores it", async () => {
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("button")!.textContent).toBe("Start live view");
  denied = false;
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector("button")).toBeNull();
  Object.defineProperty(video, "paused", { value: true, configurable: true });
  await act(async () => video.dispatchEvent(new dom.Event("pause") as never));
  expect(container.querySelector("button")!.textContent).toBe("Start live view");
  expect(inputs).toEqual([]);
});

test("a retained blocked video never hides a connection error", async () => {
  const source = video.srcObject;
  await act(async () =>
    root.render(
      <DeviceScreen
        client={{
          ...client,
          status: "error",
          error: "Input connection failed",
        }}
      />,
    ),
  );
  expect(video.srcObject).toBe(source);
  expect(container.textContent).toContain("Input connection failed");
  expect(container.querySelector("button")).toBeNull();
});
