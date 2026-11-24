import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToString } from "react-dom/server";

import { DeviceClientStoreContext } from "../DeviceClientProvider";
import { DeviceScreen } from "../DeviceScreen";
import { createDeviceClientStore } from "../device-client-store";
import { DEVICE_MODELS, deviceModelStreamable } from "../models/device-models";
import { DeviceModelScreen } from "../models/DeviceModelScreen";
import {
  type DeviceModelScreenClient,
  selectDeviceModelScreenClient,
  useDeviceModelScreenClient,
} from "../models/model-screen-client";
import type { DeviceClient, DeviceDisplay, DeviceFold } from "../types";
import { selectDeviceScreenClient } from "../useDeviceScreenClient";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

const FOLD: DeviceFold = {
  angle: 0,
  pose: "closed",
  pending: false,
  error: null,
  setControl: () => {},
};
const DISPLAYS: readonly DeviceDisplay[] = [
  { id: "cover", active: true, attachVideo: () => {} },
  { id: "inner", active: false, attachVideo: () => {} },
];

// @ref LLP 0019#screen-client — the 3D screen's client is the flat screen's inputs, the displays, and the orientation
test("the 3D screen's client is the flat screen's client with the displays and the orientation", () => {
  const flat = Object.keys(selectDeviceScreenClient(NOOP_DEVICE_CLIENT));
  const model = Object.keys(selectDeviceModelScreenClient(NOOP_DEVICE_CLIENT));
  expect(model.sort()).toEqual([...flat, "displays", "orientation"].sort());
});

test("the 3D screen's client follows the displays, the fold, and the orientation, and no metrics, FPS, or logs", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = createDeviceClientStore();
  let renders = 0;
  let seen: DeviceModelScreenClient | undefined;
  function Screen() {
    seen = useDeviceModelScreenClient();
    renders++;
    return null;
  }
  await act(async () => {
    renderer = create(
      <DeviceClientStoreContext.Provider value={store}>
        <Screen />
      </DeviceClientStoreContext.Provider>,
    );
  });
  const publish = (patch: Partial<DeviceClient>) =>
    act(async () => store.publish({ ...store.getSnapshot(), ...patch }));

  // What the 3D screen does not read never renders it again.
  const idle = renders;
  await publish({ fps: 30 });
  await publish({ logs: [] });
  await publish({
    activity: { hostCores: null, samples: [], stale: false, errored: false },
  });
  await publish({ streamStats: null, devices: [] });
  expect(renders).toBe(idle);

  // What it reads does.
  await publish({ displays: DISPLAYS });
  expect(renders).toBe(idle + 1);
  expect(seen?.displays).toBe(DISPLAYS);
  await publish({ fold: FOLD });
  expect(renders).toBe(idle + 2);
  await publish({ orientation: "landscape_left" });
  expect(renders).toBe(idle + 3);
  expect(seen?.orientation).toBe("landscape_left");
  await publish({ framePresented: true });
  expect(renders).toBe(idle + 4);
  // The same values again are no change.
  await publish({ displays: DISPLAYS, fold: FOLD, orientation: "landscape_left" });
  expect(renders).toBe(idle + 4);
});

/** A full client that records which of its properties are read. */
function recordingClient(overrides: Partial<DeviceClient>) {
  const reads = new Set<string>();
  const client = new Proxy(
    { ...NOOP_DEVICE_CLIENT, status: "streaming", framePresented: true, ...overrides },
    {
      get(target, property, receiver) {
        if (typeof property === "string") reads.add(property);
        return Reflect.get(target, property, receiver);
      },
      ownKeys(target) {
        reads.add("(every property)");
        return Reflect.ownKeys(target);
      },
    },
  ) as DeviceClient;
  return { client, reads };
}

test("the 3D screen reads only the properties of its client, for a foldable and for a phone", async () => {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  const allowed = new Set(Object.keys(selectDeviceModelScreenClient(NOOP_DEVICE_CLIENT)));
  const duo = recordingClient({
    screen: { width: 1398, height: 2034, orientation: "portrait", display: "cover" },
    fold: FOLD,
    displays: DISPLAYS,
    videoKind: "img",
  });
  const phone = recordingClient({
    screen: { width: 1206, height: 2622, orientation: "portrait" },
    orientation: "portrait",
  });
  for (const [recorded, model] of [
    [duo, DEVICE_MODELS["ios:iphone-duo"]],
    [phone, DEVICE_MODELS["ios:iphone-18-pro"]],
  ] as const) {
    // With effects, so that what the hooks read after the first render counts too.
    await act(async () => {
      renderer = create(
        <DeviceModelScreen
          client={recorded.client}
          model={model}
          modelUrl="https://hub.test/model.glb"
        />,
      );
    });
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect([...recorded.reads].filter((property) => !allowed.has(property))).toEqual([]);
    // The two properties that the flat screen's client does not have.
    expect(recorded.reads.has("displays")).toBe(true);
    expect(recorded.reads.has("orientation")).toBe(true);
  }
});

test("one limited client serves the 3D screen, its flat fallback, and the check before them", () => {
  const client: DeviceModelScreenClient = selectDeviceModelScreenClient({
    ...NOOP_DEVICE_CLIENT,
    fold: FOLD,
    displays: DISPLAYS,
  });
  const model = DEVICE_MODELS["ios:iphone-duo"];
  expect(deviceModelStreamable(model, client)).toBe(true);
  // Server rendering runs no effects, so the scene never starts and needs no WebGL.
  expect(
    renderToString(
      <DeviceModelScreen client={client} model={model} modelUrl="https://hub.test/duo.glb" />,
    ),
  ).toContain("Interactive iPhone Duo");
  expect(renderToString(<DeviceScreen client={client} />)).toContain("Interactive device screen");
  // A full client still fits.
  const full: DeviceClient = NOOP_DEVICE_CLIENT;
  expect(
    renderToString(
      <DeviceModelScreen
        client={full}
        model={DEVICE_MODELS["ios:iphone-18-pro"]}
        modelUrl="https://hub.test/phone.glb"
      />,
    ),
  ).toContain("Interactive iPhone 18 Pro");
});
