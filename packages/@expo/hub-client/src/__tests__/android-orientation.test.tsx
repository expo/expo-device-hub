import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

async function mount(apiInfo: Record<string, unknown>) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  const locks: string[] = [];
  const pending: Array<() => void> = [];
  let holdLocks = false;
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/orientation" && init?.method === "POST") {
      locks.push(JSON.parse(init.body as string).orientation);
      if (holdLocks) await new Promise<void>((resolve) => pending.push(resolve));
      return Response.json({});
    }
    if (path === "/api") return Response.json({ size: { width: 1080, height: 2400 }, ...apiInfo });
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test/",
      device: "emulator-5554",
      enabled: true,
      streamMode: "h264",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return {
    client: () => client,
    locks,
    hold: () => (holdLocks = true),
    release: async () => {
      holdLocks = false;
      await act(async () => {
        while (pending.length) pending.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
  };
}

test("Android reports the server's display orientation and sets every pose by name", async () => {
  const { client, locks } = await mount({ orientation: "landscape_right" });
  expect(client().capabilities.orientation).toEqual({
    orientations: ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"],
  });
  expect(client().screen).toEqual({
    width: 1080,
    height: 2400,
    orientation: "landscape_right",
    framesUpright: true,
  });
  await act(async () => client().setOrientation("portrait_upside_down"));
  expect(locks).toEqual(["portrait_upside_down"]);
});

test("Android keeps portrait and landscape on servers that do not report the orientation", async () => {
  const { client, locks } = await mount({});
  expect(client().capabilities.orientation).toEqual({
    orientations: ["portrait", "landscape_left"],
  });
  expect(client().screen?.orientation).toBeUndefined();
  await act(async () => {
    client().setOrientation("landscape_left");
    client().setOrientation("landscape_right");
  });
  await act(async () => client().setOrientation("portrait"));
  expect(locks).toEqual(["landscape", "portrait"]);
});

test("Android sends one orientation at a time and keeps only the latest queued choice", async () => {
  const { client, locks, hold, release } = await mount({ orientation: "portrait" });
  hold();
  await act(async () => {
    client().setOrientation("landscape_left");
    client().setOrientation("portrait_upside_down");
    client().setOrientation("landscape_right");
  });
  expect(locks).toEqual(["landscape_left"]);
  await release();
  expect(locks).toEqual(["landscape_left", "landscape_right"]);
});
