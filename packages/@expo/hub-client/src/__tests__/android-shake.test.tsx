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

async function mount(api: { shake?: boolean }) {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  const writes: string[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api") {
      return Response.json({ size: { width: 1080, height: 2400 }, pose: "portrait", ...api });
    }
    if (path === "/api/shake") return Response.json({ ok: true });
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
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await settle();
  return { client: () => client, writes, settle };
}

test("an emulator that serve-emu can shake offers shake, and one shake sends one request", async () => {
  const harness = await mount({ shake: true });
  expect(harness.client().capabilities.shake).toBe(true);

  await act(async () => harness.client().shake());
  await harness.settle();

  expect(harness.writes).toEqual(["POST /api/shake"]);
});

test("a device or server without shake support does not offer it or send a request", async () => {
  for (const api of [{}, { shake: false }]) {
    const harness = await mount(api);
    expect(harness.client().capabilities.shake).toBe(false);

    await act(async () => harness.client().shake());
    await harness.settle();

    expect(harness.writes).toEqual([]);
    await act(async () => renderer?.unmount());
    renderer = undefined;
    restoreGlobals();
  }
});
