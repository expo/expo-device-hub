import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DeviceClient, type DeviceFold } from "@expo/hub-client";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

import { DeviceOptionsSection } from "../dashboard/DeviceOptionsSection";
import { LogSidebar } from "../dashboard/LogSidebar";
import { DuoModelView } from "../foldable/DuoModelView";
import { DEVICE_MODELS } from "../foldable/device-models";
import { DeviceModelScreen } from "../foldable/DeviceModelScreen";
import { DUO_FOLD_CONTROLS } from "./duo-fixtures";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();

const BASE_CLIENT: DeviceClient = {
  platform: "ios",
  status: "streaming",
  error: null,
  framePresented: true,
  inputError: null,
  screenRecording: null,
  recordingLock: null,
  recordingControlsLocked: false,
  screen: { width: 1398, height: 2034, orientation: "portrait", display: "cover" },
  fold: null,
  displays: null,
  deviceModelUrl: null,
  displayCorners: null,
  fps: 60,
  devices: [],
  logs: [],
  logsEnabled: false,
  attachLogs: () => {},
  detachLogs: () => {},
  clearLogs: () => {},
  events: [],
  eventsEnabled: false,
  attachEvents: () => {},
  detachEvents: () => {},
  clearEvents: () => {},
  activity: null,
  activityStatus: "idle",
  deviceSettings: null,
  deviceSettingsStatus: "idle",
  deviceSettingsPending: new Set(),
  setDeviceSetting: () => {},
  displayWidthDp: null,
  camera: null,
  cameraPending: new Set(),
  cameraError: null,
  setCameraImage: () => {},
  clearCameraImage: () => {},
  location: null,
  locationPending: false,
  locationError: null,
  setLocation: () => {},
  clearLocation: () => {},
  permissions: null,
  permissionsPending: new Set<string>(),
  permissionsError: null,
  setPermission: () => {},
  resetPermissions: () => {},
  refreshPermissions: () => {},
  pasteText: async () => {},
  copyText: async () => "",
  clipboardActionId: 0,
  clipboardAction: null,
  clipboardPending: null,
  clipboardError: null,
  clipboardWarning: null,
  accessibility: null,
  accessibilityPending: false,
  accessibilityError: null,
  refreshAccessibility: () => {},
  streamCapabilities: null,
  streamSettings: null,
  streamSettingsPending: false,
  updateStreamSettings: () => {},
  streamSource: null,
  streamSourcePending: false,
  streamSourceError: null,
  setStreamSource: () => {},
  setGrpcImageMode: () => {},
  setGrpcEncoder: () => {},
  setGrpcInputSource: () => {},
  streamStats: null,
  setStreamStatsEnabled: () => {},
  webRtcCodec: "h264",
  setWebRtcCodec: () => {},
  capabilities: {
    deviceSettings: false,
    activity: false,
    events: false,
    camera: false,
    accessibility: false,
    location: false,
    permissions: false,
    clipboard: false,
    orientation: false,
    fold: false,
    streamSettings: false,
  },
  foregroundApp: null,
  videoKind: "img",
  attachVideo: () => {},
  sendTouch: () => {},
  sendKey: () => false,
  pressButton: () => {},
  reload: () => {},
  rotate: () => {},
  orientation: null,
  orientationPending: false,
  orientationError: null,
  orientationUnavailable: null,
  setOrientation: () => {},
  screenshot: async () => null,
  appearance: "light",
  setAppearance: () => {},
  hardwareKeyboardConnected: null,
  setHardwareKeyboardConnected: () => {},
  toggleSoftwareKeyboard: () => {},
};

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
    ...BASE_CLIENT,
    fold: controls ? FOLD : withoutGroups,
    displays: [
      { id: "cover", active: true, attachVideo: () => {} },
      { id: "inner", active: false, attachVideo: () => {} },
    ],
    capabilities: { ...BASE_CLIENT.capabilities, fold: controls },
  };
}

describe("fold controls follow capabilities.fold, not the fold state alone", () => {
  test("Device options shows Fold settings only once the device offers fold commands", () => {
    const before = renderToStaticMarkup(<DeviceOptionsSection client={duo(false)} />);
    expect(before).not.toContain('aria-label="Fold settings"');
    const after = renderToStaticMarkup(<DeviceOptionsSection client={duo(DUO_FOLD_CONTROLS)} />);
    expect(after).toContain('aria-label="Fold settings"');
  });

  test("the inspector opens Device options for fold commands alone", () => {
    // No device settings, frame option, or device actions: only fold commands open the section.
    expect(renderToStaticMarkup(<LogSidebar client={duo(false)} />)).not.toContain(
      ">Device options<",
    );
    const markup = renderToStaticMarkup(<LogSidebar client={duo(DUO_FOLD_CONTROLS)} />);
    expect(markup).toContain(">Device options<");
    expect(markup).toContain('aria-label="Fold settings"');
  });
});

describe("the 2D/3D choice", () => {
  const preview = {
    mode: "3d" as const,
    onModeChange: () => {},
    cacheScreenOnFold: false,
    onCacheScreenOnFoldChange: () => {},
    sizeMode: "fill" as const,
    onSizeModeChange: () => {},
  };

  test("Device options offers it for a device with a model but without fold controls", () => {
    const markup = renderToStaticMarkup(
      <DeviceOptionsSection client={BASE_CLIENT} foldPreview={preview} />,
    );
    expect(markup).toContain('aria-label="3D preview"');
    expect(markup).toContain('aria-label="Preview mode"');
    expect(markup).toContain('aria-label="Preview size"');
    // Only a device with fold controls caches the display it folds away from.
    expect(markup).not.toContain("Cache screen on fold");
    expect(markup).not.toContain('aria-label="Fold settings"');
  });

  test("a device without a model has no 2D/3D choice", () => {
    const markup = renderToStaticMarkup(<DeviceOptionsSection client={BASE_CLIENT} />);
    expect(markup).not.toContain('aria-label="Preview mode"');
  });

  test("a foldable keeps the choice in Fold settings, with the cache option", () => {
    const markup = renderToStaticMarkup(
      <DeviceOptionsSection client={duo(DUO_FOLD_CONTROLS)} foldPreview={preview} />,
    );
    expect(markup).toContain('aria-label="Fold settings"');
    expect(markup).not.toContain('aria-label="3D preview"');
    expect(markup).toContain("Cache screen on fold");
  });
});

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
