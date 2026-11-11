import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
const realSetInterval = setInterval;
const FOREGROUND_POLL_MS = 5000;

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

/** What serve-emu reports: `/api/foreground` has no label; `/api/apps/icon` has it. */
const APPS: Record<string, { activity: string; label: string }> = {
  "com.google.android.apps.nexuslauncher": {
    activity: "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
    label: "Pixel Launcher",
  },
  "com.android.chrome": { activity: "com.google.android.apps.chrome.Main", label: "Chrome" },
};

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
  // The foreground poll runs only when the test asks.
  const foregroundPolls = new Set<() => void>();
  stubGlobal("setInterval", (callback: () => void, ms?: number) => {
    if (ms === FOREGROUND_POLL_MS) foregroundPolls.add(callback);
    return realSetInterval(() => {}, 1_000_000);
  });
  let foreground = "com.google.android.apps.nexuslauncher";
  const detailRequests: string[] = [];
  stubGlobal("fetch", async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/foreground") {
      return Response.json({
        ok: true,
        app: {
          packageName: foreground,
          activity: APPS[foreground]!.activity,
          pid: 1310,
          label: null,
          versionName: "16",
          versionCode: "907",
          minSdk: 36,
          debuggable: false,
        },
      });
    }
    if (parsed.pathname === "/api/apps/icon") {
      const packageName = parsed.searchParams.get("packageName")!;
      detailRequests.push(packageName);
      return Response.json({
        ok: true,
        packageName,
        icon: { mimeType: "image/png", data: "aWNvbg==" },
        label: APPS[packageName]!.label,
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
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await settle();
  await settle();
  return {
    client: () => client,
    detailRequests,
    poll: async (next?: string) => {
      if (next) foreground = next;
      await act(async () => {
        for (const poll of foregroundPolls) poll();
      });
      await settle();
      await settle();
    },
  };
}

test("Android shows the APK label, and the next foreground poll keeps it", async () => {
  const harness = await mount();
  const resolved = harness.client().foregroundApp;
  expect(resolved).toMatchObject({
    id: "com.google.android.apps.nexuslauncher",
    label: "Pixel Launcher",
    iconDataUrl: "data:image/png;base64,aWNvbg==",
  });

  await harness.poll();

  // Same app, no new fields: the poll keeps the resolved object instead of re-rendering.
  expect(harness.client().foregroundApp).toBe(resolved);
  expect(harness.detailRequests).toEqual(["com.google.android.apps.nexuslauncher"]);
});

test("Android drops the old label when another app comes to the foreground", async () => {
  const harness = await mount();

  await harness.poll("com.android.chrome");

  expect(harness.client().foregroundApp).toMatchObject({
    id: "com.android.chrome",
    label: "Chrome",
  });
  expect(harness.detailRequests).toEqual([
    "com.google.android.apps.nexuslauncher",
    "com.android.chrome",
  ]);
});
