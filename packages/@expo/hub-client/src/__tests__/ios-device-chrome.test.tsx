import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceKitChromeDescriptor } from "../device-kit-chrome";
import type { DeviceClient, DeviceConnectionOptions } from "../types";
import { useIosDeviceClient, WS_TAG_SCREEN_CONFIG } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const chrome: DeviceKitChromeDescriptor = {
  identifier: "iPhone",
  frame: { width: 430, height: 900 },
  body: { x: 2, y: 0, width: 426, height: 900 },
  screen: { x: 10, y: 10, width: 410, height: 880 },
  insets: { top: 10, left: 10, bottom: 10, right: 10 },
  outerCornerRadius: 30,
  innerCornerRadius: 25,
  screenRadius: 25,
  compositeImage: "Composite",
  slice: null,
  corner: null,
  buttons: [],
};

function setup() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { href: "https://viewer.test/", origin: "https://viewer.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const sockets: Array<{ onmessage?: (event: { data: ArrayBuffer }) => void }> = [];
  stubGlobal(
    "WebSocket",
    class {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: ArrayBuffer }) => void;
      constructor() {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      send() {}
      close() {}
    },
  );
  const requests: Array<{ token: string | null; resolve: (value: Response) => void }> = [];
  stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/sim/api") {
      return new Promise<Response>((resolve) =>
        requests.push({
          token: new Headers(init?.headers).get("Authorization"),
          resolve,
        }),
      );
    }
    return Promise.resolve(Response.json({ devices: [] }));
  });
  let client!: DeviceClient;
  function Harness({ options }: { options: DeviceConnectionOptions }) {
    client = useIosDeviceClient(options);
    return null;
  }
  const options: DeviceConnectionOptions = {
    baseUrl: "https://preview.test/sim",
    device: "A",
    token: "first",
    streamMode: "mjpeg",
  };
  const render = async (next = options) => {
    await act(async () => {
      if (renderer) renderer.update(<Harness options={next} />);
      else renderer = create(<Harness options={next} />);
    });
  };
  const resolve = async (index: number, value: object) => {
    await act(async () => requests[index]!.resolve(Response.json(value)));
  };
  const config = (device: string) => ({
    device,
    url: `https://preview.test/sim/helper/${device}`,
    chrome,
  });
  return { render, resolve, requests, options, config, sockets, client: () => client };
}

test("frame metadata belongs only to the current authenticated device connection", async () => {
  const h = setup();
  await h.render();
  expect(h.client().chrome).toBeNull();
  expect(h.requests[0]!.token).toBe("Bearer first");
  await h.resolve(0, h.config("A"));
  expect(h.client().chrome).toEqual(chrome);

  await h.render({ ...h.options, device: "B" });
  expect(h.client().chrome).toBeNull();
  await h.render({ ...h.options, device: "B", token: "replacement" });
  expect(h.client().chrome).toBeNull();
  await h.resolve(1, h.config("B"));
  expect(h.client().chrome).toBeNull();
  expect(h.requests[2]!.token).toBe("Bearer replacement");
  await h.resolve(2, { ...h.config("B"), chrome: { ...chrome, identifier: "new-device" } });
  expect(h.client().chrome?.identifier).toBe("new-device");

  await h.render({ ...h.options, enabled: false });
  expect(h.client().chrome).toBeNull();
});

test("older servers without frame metadata still connect and display changes retain their ID", async () => {
  const h = setup();
  await h.render();
  const { chrome: _chrome, ...config } = h.config("A");
  await h.resolve(0, config);
  expect(h.client().chrome).toBeNull();
  const screen = async (screenId: number) => {
    const payload = new TextEncoder().encode(JSON.stringify({ width: 400, height: 800, screenId }));
    const data = new Uint8Array(payload.length + 1);
    data[0] = WS_TAG_SCREEN_CONFIG;
    data.set(payload, 1);
    await act(async () => h.sockets[0]!.onmessage?.({ data: data.buffer }));
  };
  await screen(0);
  expect(h.client().screen?.screenId).toBe(0);
  await screen(1);
  expect(h.client().screen?.screenId).toBe(1);
  const previous = h.client().screen;
  await screen(1);
  expect(h.client().screen).toBe(previous);
});
