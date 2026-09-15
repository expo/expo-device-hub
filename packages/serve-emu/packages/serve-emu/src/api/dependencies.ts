import type { Gesture } from "../shared/control-contracts.ts";
import type {
  AccessibilitySelector,
  AccessibilitySnapshot,
  AccessibilityTapResponse,
  ApiInfoResponse,
  ApiRequest,
  AppActionResponse,
  AppliedGeoFix,
  AvdStartResponse,
  AvdStopResponse,
  FontWeightStatus,
  CameraFacing,
  CameraStatus,
  DeviceGridResponse,
  DeviceListResponse,
  DeviceSelectionResponse,
  DisplayDensityStatus,
  FileImportResponse,
  FontScaleStatus,
  ForegroundApp,
  GeoFix,
  HighTextContrastStatus,
  LocationResponse,
  NightMode,
  NightModeStatus,
  NetworkStatus,
  OrientationMode,
  OrientationStatus,
  ReduceMotionStatus,
  RoutePlaybackRequest,
  RoutePlaybackSnapshot,
  SessionSnapshot,
  SoftwareKeyboardStatus,
  StreamModeRequest,
  StreamModeResponse,
  StreamEncoderSettingsResponse,
} from "../shared/api-contracts.ts";
import type { StreamEncoderSettingsPatch } from "../stream-settings.ts";

export type { NightMode, OrientationMode } from "../shared/api-contracts.ts";
export type RouteControlAction = ApiRequest<
  "/api/route/control",
  "POST"
>["action"];

/**
 * High-level operations used by the HTTP API. Keeping this interface free of
 * Bun server state lets every registered route run against deterministic fakes.
 */
export type ApiDependencies = {
  getInfo: () => ApiInfoResponse;
  getStreamMode: () => StreamModeResponse;
  setStreamMode: (request: StreamModeRequest) => Promise<StreamModeResponse>;
  getStreamEncoderSettings: () => StreamEncoderSettingsResponse;
  setStreamEncoderSettings: (
    patch: StreamEncoderSettingsPatch,
  ) => Promise<StreamEncoderSettingsResponse>;
  listDevices: () => Promise<DeviceListResponse>;
  getDeviceGrid: () => Promise<DeviceGridResponse>;
  selectDevice: (serial: string) => Promise<DeviceSelectionResponse>;
  startAvd: (avd: string, select: boolean) => Promise<AvdStartResponse>;
  stopAvd: (input: { serial?: string; avd?: string }) => Promise<AvdStopResponse>;

  getOrientation: () => Promise<OrientationStatus>;
  setOrientation: (orientation: OrientationMode) => Promise<OrientationStatus>;
  getNightMode: () => Promise<NightModeStatus>;
  setNightMode: (mode: NightMode) => Promise<NightModeStatus>;
  getFontScale: () => Promise<FontScaleStatus>;
  setFontScale: (scale: number) => Promise<FontScaleStatus>;
  getNetwork: () => Promise<NetworkStatus>;
  setNetwork: (enabled: boolean) => Promise<NetworkStatus>;
  getReduceMotion: () => Promise<ReduceMotionStatus>;
  setReduceMotion: (enabled: boolean) => Promise<ReduceMotionStatus>;
  getHighTextContrast: () => Promise<HighTextContrastStatus>;
  setHighTextContrast: (enabled: boolean) => Promise<HighTextContrastStatus>;
  getFontWeight: () => Promise<FontWeightStatus>;
  setFontWeight: (enabled: boolean) => Promise<FontWeightStatus>;
  getSoftwareKeyboard: () => Promise<SoftwareKeyboardStatus>;
  setSoftwareKeyboard: (enabled: boolean) => Promise<SoftwareKeyboardStatus>;
  getDisplayDensity: () => Promise<DisplayDensityStatus>;
  setDisplayDensity: (scale: number) => Promise<DisplayDensityStatus>;

  openLogcat: (url: URL) => Response;
  takeScreenshot: () => Promise<Uint8Array>;
  getForegroundApp: () => Promise<ForegroundApp>;
  getAccessibility: () => Promise<AccessibilitySnapshot>;
  tapAccessibility: (
    selector: AccessibilitySelector,
    record: boolean,
  ) => Promise<AccessibilityTapResponse>;

  dispatchGesture: (
    gesture: Gesture,
    source: string,
    record: boolean,
  ) => Promise<void>;

  getSession: () => SessionSnapshot;
  clearSession: () => SessionSnapshot;
  replaySession: (multiplier: number) => SessionSnapshot;
  stopSessionReplay: () => SessionSnapshot;

  installApk: (file: File) => Promise<AppActionResponse>;
  importFile: (file: File) => Promise<FileImportResponse>;
  launchApp: (packageName: string, activity?: string) => Promise<AppActionResponse>;
  clearApp: (packageName: string) => Promise<AppActionResponse>;
  forceStopApp: (packageName: string) => Promise<AppActionResponse>;
  grantPermission: (packageName: string, permission: string) => Promise<AppActionResponse>;

  getLocation: () => LocationResponse;
  setLocation: (fix: GeoFix) => Promise<AppliedGeoFix>;
  getRoute: () => RoutePlaybackSnapshot;
  startRoute: (route: RoutePlaybackRequest) => Promise<RoutePlaybackSnapshot>;
  stopRoute: () => RoutePlaybackSnapshot;
  controlRoute: (action: RouteControlAction) => RoutePlaybackSnapshot;

  getCamera: () => Promise<CameraStatus>;
  /** `null` when that facing has no feed file yet. */
  readCameraImage: (facing: CameraFacing) => Promise<Uint8Array | null>;
  /**
   * Mutate only. The routes read the status back through `getCamera`, so these
   * line up with the same-named functions in `camera.ts` rather than returning
   * a wider shape a host would have to assemble.
   */
  setCameraImage: (facing: CameraFacing, png: Uint8Array) => Promise<void>;
  clearCameraImage: (facing: CameraFacing) => Promise<void>;
};
