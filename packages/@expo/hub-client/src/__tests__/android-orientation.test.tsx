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

async function mount() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  const locks: { url: string; orientation: string }[] = [];
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (new URL(url).pathname === "/api/orientation" && init?.method === "POST") {
      locks.push({ url, orientation: JSON.parse(init.body as string).orientation });
      return Response.json({});
    }
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test/",
      device: "emulator 5554",
      enabled: true,
      streamMode: "h264",
    });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  return { client: () => client, locks };
}

test("Android sets only the orientations serve-emu can lock", async () => {
  const { client, locks } = await mount();
  expect(client().orientations).toEqual(["portrait", "landscape_left"]);
  client().setOrientation("landscape_left");
  client().setOrientation("landscape_right");
  client().setOrientation("portrait_upside_down");
  client().setOrientation("portrait");
  const url = "https://hub.test/api/orientation?device=emulator%205554";
  expect(locks).toEqual([
    { url, orientation: "landscape" },
    { url, orientation: "portrait" },
  ]);
});
