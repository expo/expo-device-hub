import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient } from "../types";
import { useIosDeviceClient } from "../useIosDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

// A serve-sim behind a public mount, the way an EAS Simulator Preview session serves it.
const BASE = "https://sim.test/preview/session";
const CONFIG = {
  url: `${BASE}/helper/UDID-1`,
  device: "UDID-1",
  basePath: "/preview/session",
  proxyHelpers: true,
  execToken: "tok-1",
  appStateEndpoint: "/preview/session/appstate?device=UDID-1",
};

type AppStateSource = { onmessage: ((event: { data: string }) => void) | null };

async function mount() {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    location: { protocol: "https:", host: "sim.test", origin: "https://sim.test" },
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("fetch", async (input: string) =>
    new URL(input).pathname === "/preview/session/api"
      ? Response.json(CONFIG)
      : Response.json({}, { status: 404 }),
  );
  // exec-ws never opens, as on a page that cannot reach it: the bundle read never answers.
  stubGlobal(
    "WebSocket",
    class {
      readyState = 0;
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
    },
  );
  const sources: AppStateSource[] = [];
  stubGlobal(
    "EventSource",
    class {
      onmessage = null;
      onerror = null;
      constructor() {
        sources.push(this);
      }
      addEventListener() {}
      close() {}
    },
  );
  let client!: DeviceClient;
  function Harness() {
    client = useIosDeviceClient({ baseUrl: BASE, device: "UDID-1", streamMode: "mjpeg" });
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return {
    client: () => client,
    sources,
    send: (event: object) =>
      act(async () => sources.at(-1)!.onmessage!({ data: JSON.stringify(event) })),
  };
}

test("iOS shows the name that the /appstate event carries", async () => {
  const harness = await mount();
  expect(harness.sources).toHaveLength(1);

  await harness.send({
    bundleId: "com.apple.mobilesafari",
    pid: 6582,
    isReactNative: false,
    label: "Safari",
  });

  expect(harness.client().foregroundApp).toMatchObject({
    id: "com.apple.mobilesafari",
    pid: 6582,
    label: "Safari",
  });
});

test("iOS takes the new app's name when another app comes to the foreground", async () => {
  const harness = await mount();
  await harness.send({ bundleId: "com.apple.mobilesafari", pid: 1, label: "Safari" });

  await harness.send({ bundleId: "com.apple.Preferences", pid: 2, label: "Settings" });

  expect(harness.client().foregroundApp).toMatchObject({
    id: "com.apple.Preferences",
    label: "Settings",
  });
});
