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

async function mount(screenRecording?: { status: string }) {
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
    if (init?.method && init.method !== "GET") writes.push(`${init.method} ${path}`);
    if (path === "/api") {
      return Response.json({
        size: { width: 1080, height: 2400 },
        orientation: "portrait",
        ...(screenRecording ? { screenRecording } : {}),
      });
    }
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
  const useControls = async () => {
    await act(async () => {
      client.rotate();
      client.setOrientation("landscape_left");
      client.setStreamSource("scrcpy");
      client.setGrpcImageMode("png");
      client.setGrpcEncoder("hardware");
      client.setGrpcInputSource("scrcpy");
      client.updateStreamSettings({ h264Fps: 30 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { client: () => client, writes, useControls };
}

test.each(["waiting", "recording", "finalizing"])(
  "Android refuses rotation and stream changes while a recording is %s",
  async (status) => {
    const { client, writes, useControls } = await mount({ status });
    expect(client().recordingControlsLocked).toBe(true);
    await useControls();
    expect(writes).toEqual([]);
  },
);

test("Android turns and changes the stream once the recording is complete", async () => {
  const { client, writes, useControls } = await mount({ status: "complete" });
  expect(client().recordingControlsLocked).toBe(false);
  await useControls();
  expect(writes).toContain("POST /api/orientation");
  expect(writes.length).toBeGreaterThan(1);
});
