import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { type DeviceClient, type DeviceFold } from "../index";
import { DEVICE_MODELS } from "../models/device-models";
import { DeviceModelScreen } from "../models/DeviceModelScreen";
import { DuoModelView } from "../models/DuoModelView";
import { DUO_FOLD_CONTROLS } from "./duo-fixtures";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

const FOLD: DeviceFold = {
  angle: 0,
  pose: "closed",
  pending: false,
  error: null,
  tableMode: { enabled: false, available: false },
  physical: { faceDown: false },
  setControl: () => {},
};

/** An iPhone Duo before and after the helper reports a hinge it can move. */
function duo(controls: DeviceClient["capabilities"]["fold"]): DeviceClient {
  // As the iOS adapter reports it: the optional groups come with the capability.
  const { tableMode: _tableMode, physical: _physical, ...withoutGroups } = FOLD;
  return {
    platform: "ios",
    status: "streaming",
    framePresented: true,
    screen: { width: 1398, height: 2034, orientation: "portrait", display: "cover" },
    fold: controls ? FOLD : withoutGroups,
    displays: [
      { id: "cover", active: true, attachVideo: () => {} },
      { id: "inner", active: false, attachVideo: () => {} },
    ],
    orientation: null,
    capabilities: { fold: controls, clipboard: false },
    videoKind: "img",
    attachVideo: () => {},
    sendTouch: () => {},
    sendKey: () => false,
  } as unknown as DeviceClient;
}

describe("the 3D model's hinge handles", () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  });
  afterEach(async () => {
    if (renderer) await act(async () => renderer?.unmount());
    renderer = undefined;
    restoreGlobals();
  });

  async function handleCallback(client: DeviceClient) {
    // Without host elements the scene does not start, so no WebGL is needed.
    await act(async () => {
      const element = (
        <DeviceModelScreen
          client={client}
          model={DEVICE_MODELS["ios:iphone-duo"]}
          modelUrl="https://hub.test/assets/iphone-duo.glb"
        />
      );
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
    return renderer!.root.findByType(DuoModelView).props.onHingeAngleChange;
  }

  test("move the hinge only when the device accepts angles", async () => {
    expect(await handleCallback(duo(DUO_FOLD_CONTROLS))).toBeFunction();
    expect(await handleCallback(duo({ ...DUO_FOLD_CONTROLS, angle: false }))).toBeUndefined();
    expect(await handleCallback(duo(false))).toBeUndefined();
  });
});
