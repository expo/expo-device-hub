import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
const realSetInterval = setInterval;
const FOREGROUND_POLL_MS = 5000;
const APP_DETAILS_RETRY_MS = [4_000, 16_000, 64_000];
const realSetTimeout = setTimeout;

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
const APPS: Record<
  string,
  { activity: string; label: string | null; build: string; noIcon?: boolean }
> = {
  "com.google.android.apps.nexuslauncher": {
    activity: "com.google.android.apps.nexuslauncher.NexusLauncherActivity",
    label: "Pixel Launcher",
    build: "907",
  },
  "com.android.chrome": {
    activity: "com.google.android.apps.chrome.Main",
    label: "Chrome",
    build: "1",
  },
};

async function mount({ failedDetailReads = 0 } = {}) {
  const apps = structuredClone(APPS);
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  // Details retries run only when the test asks.
  const retries: Array<() => void> = [];
  stubGlobal("setTimeout", ((callback: () => void, ms?: number) => {
    if (ms !== undefined && APP_DETAILS_RETRY_MS.includes(ms)) {
      retries.push(callback);
      return realSetTimeout(() => {}, 1_000_000);
    }
    return realSetTimeout(callback, ms);
  }) as typeof setTimeout);
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
  let detailsGate: Promise<void> | null = null;
  stubGlobal("fetch", async (url: string) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/api/foreground") {
      return Response.json({
        ok: true,
        app: {
          packageName: foreground,
          activity: apps[foreground]!.activity,
          pid: 1310,
          label: null,
          versionName: "16",
          versionCode: apps[foreground]!.build,
          minSdk: 36,
          debuggable: false,
        },
      });
    }
    if (parsed.pathname === "/api/apps/icon") {
      const packageName = parsed.searchParams.get("packageName")!;
      detailRequests.push(packageName);
      if (detailsGate) await detailsGate;
      if (failedDetailReads > 0) {
        failedDetailReads -= 1;
        return Response.json(
          { ok: false, error: "aapt2 dump resources timed out" },
          { status: 400 },
        );
      }
      return Response.json({
        ok: true,
        packageName,
        icon: apps[packageName]!.noIcon ? null : { mimeType: "image/png", data: "aWNvbg==" },
        label: apps[packageName]!.label,
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
  const settle = () => act(async () => new Promise((resolve) => realSetTimeout(resolve, 0)));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await settle();
  await settle();
  return {
    client: () => client,
    detailRequests,
    retries,
    apps,
    holdDetails: () => {
      let release!: () => void;
      detailsGate = new Promise<void>((resolve) => (release = resolve));
      return async () => {
        detailsGate = null;
        release();
        await settle();
        await settle();
      };
    },
    retry: async () => {
      await act(async () => retries.shift()!());
      await settle();
      await settle();
    },
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

test("Android reads the details again when a reinstall changes the build", async () => {
  const harness = await mount();
  harness.apps["com.google.android.apps.nexuslauncher"]!.build = "908";
  harness.apps["com.google.android.apps.nexuslauncher"]!.label = "Pixel Launcher Beta";
  const release = harness.holdDetails();

  await harness.poll();

  // The old name stays while the new build's details load, instead of going blank.
  expect(harness.client().foregroundApp).toMatchObject({ build: "908", label: "Pixel Launcher" });

  await release();

  expect(harness.client().foregroundApp).toMatchObject({
    build: "908",
    label: "Pixel Launcher Beta",
  });
  expect(harness.detailRequests).toHaveLength(2);
});

test("Android clears the old build's icon and label when the new build has none", async () => {
  const harness = await mount();
  const launcher = harness.apps["com.google.android.apps.nexuslauncher"]!;
  launcher.build = "908";
  launcher.label = null;
  launcher.noIcon = true;

  await harness.poll();

  expect(harness.client().foregroundApp?.build).toBe("908");
  expect(harness.client().foregroundApp?.label).toBeUndefined();
  expect(harness.client().foregroundApp?.iconDataUrl).toBeUndefined();
});

test("Android retries a failed details read", async () => {
  const harness = await mount({ failedDetailReads: 1 });
  expect(harness.client().foregroundApp?.label).toBeUndefined();
  expect(harness.retries).toHaveLength(1);

  await harness.retry();

  expect(harness.client().foregroundApp?.label).toBe("Pixel Launcher");
  expect(harness.detailRequests).toHaveLength(2);
  expect(harness.retries).toHaveLength(0);
});

test("Android gives up on details after the last retry", async () => {
  const harness = await mount({ failedDetailReads: 99 });
  for (let i = 0; i < APP_DETAILS_RETRY_MS.length; i += 1) await harness.retry();

  expect(harness.detailRequests).toHaveLength(APP_DETAILS_RETRY_MS.length + 1);
  expect(harness.retries).toHaveLength(0);
  expect(harness.client().foregroundApp?.label).toBeUndefined();
});
