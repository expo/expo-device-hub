import { listenForInputCancellation } from "./input-cancellation";
import { createControlSocket } from "./control-socket";
/**
 * serve-sim (iOS) implementation of the {@link DeviceClient} interface.
 *
 * Mirrors the serve-sim web client's architecture: the entry point is the
 * serve-sim **middleware** (default `:3200`), not the bare streaming helper.
 *
 *   1. `GET <base>/api` → the live config: the helper `url`/`streamUrl`/`wsUrl`,
 *      the `device` udid, the per-session `execToken`, and the `logsEndpoint` /
 *      `gridApiEndpoint` route paths.
 *   2. Video: MJPEG `<img>` from the helper's `streamUrl`. Input + screen config:
 *      the helper's binary WebSocket (`0x03` touch, `0x04` button, `0x05`
 *      multi-touch, `0x06` key, `0x0b` scroll, `0x0e` hardware keyboard, and
 *      `0x10` iPhone Duo hinge commands out; `0x82` screen config and `0x90`
 *      hinge acknowledgements in). Coordinates are mapped to the device's raw
 *      frame per orientation (see `./orientation`). Input sent while the socket
 *      is reconnecting is queued briefly (see `./ws-send-queue`).
 *   3. Logs: streamed over the middleware's **exec-ws** WebSocket exactly like
 *      the serve-sim client — `{token}` → `{sub, path: logsEndpoint}` → `{sub,
 *      data}` (raw SSE) — rather than a direct route on the helper (the helper
 *      has none). One-shot host actions (`{id, action, params}`) and
 *      simulator-settings requests (`{id, ui}`) share that channel (`./exec-ws`).
 *   4. Devices: `GET <base>/grid/api`.
 *
 * `baseUrl` is always the mounted serve-sim middleware. Connection failures
 * keep retrying middleware discovery; they must not be reinterpreted as a bare
 * helper because doing so drops the middleware/helper path from stream URLs.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  type AcknowledgedControlReply,
  createAcknowledgedControlQueue,
} from "./acknowledged-control-queue";
import { AVCC_FRAME_TIMEOUT_MS, avccFallbackReducer, initialAvccFallback } from "./avcc-fallback";
import {
  type DeviceDisplayChrome,
  displayChromeForScreen,
  displayClipOrientation,
  displayCornerRadii,
} from "./display-corners";
import {
  DUO_DISPLAY_FOR_PANEL,
  DUO_PANEL_FOR_DISPLAY,
  type DuoPanelId,
  duoCommandScreen,
  duoIntendedScreen,
  duoPhysicalPoseChanged,
} from "./duo/duo-fold";
import {
  type DuoPanelElement,
  type DuoPanelFeeds,
  useDuoPanelStreams,
} from "./duo/useDuoPanelStreams";
import { FOLD_POSES, type FoldControlCommand, type FoldPose } from "./fold";
import {
  DUO_POSE_ANGLES,
  type HingeControlState,
  hingeControlState,
  hingeWireCommand,
} from "./hinge-control";
import { appendActivitySample, parseActivityHostCores, parseActivitySample } from "./activity";
import { useActivityStatus } from "./useActivityStatus";
import { type AccessibilityLoader, loadIosAccessibility } from "./accessibility";
import { isAvccSupported } from "./avcc";
import {
  HID_EDGE_BOTTOM,
  homeIndicatorEdge,
  rawDeltaForDisplayDelta,
  rawEdgeForDisplayEdge,
  rawPointForDisplayPoint,
  streamGeometry,
} from "./orientation";
import {
  type SimScreenConfig,
  screenConfigsEqual,
  screenSizesEqual,
  simScreenSize,
} from "./screen-config";
import { SCREEN_LOAD_TIMEOUT_MS, useScreenPresentation } from "./screen-presentation";
import { startIosHelper } from "./connections";
import {
  clearIosEventLogState,
  createIosEventLogState,
  mergeIosEventLogPayload,
} from "./ios-events";
import { hostUiRequest, runHostAction } from "./exec-ws";
import { fetchIosAppIcon, getIosAppDetails } from "./ios-app-details";
import { clearIosLocation, setIosLocation } from "./ios-location";
import { fetchScreenshot } from "./screenshot";
import { iosMessageForKeyboardInput } from "./keyboard";
import {
  type ConnectionStatus,
  type DeviceActivity,
  type DeviceAppearance,
  type DeviceClient,
  type DeviceCapabilities,
  type DeviceClipboardAction,
  type DeviceConnectionOptions,
  type DeviceDisplay,
  type DeviceDisplayId,
  type DeviceFold,
  type DeviceFoldCapabilities,
  type DeviceLog,
  type DisplayCornerRadii,
  type DeviceOrientation,
  type DeviceSettingKey,
  type DeviceSettings,
  type DeviceStreamCapabilities,
  type DeviceStreamEncoderSettings,
  type DeviceStreamSettingCapabilities,
  type DeviceWebRtcCodec,
  type ForegroundApp,
  type FoldCommandEvent,
  type HardwareButton,
  type HidKeyEvent,
  type KeyboardInput,
  type MultiTouchSample,
  type RunningDevice,
  type ScreenSize,
  type ScreenshotCapture,
  type ScrollSample,
  type TouchSample,
} from "./types";
import { NO_PENDING_CAMERA_WRITES } from "./device-camera";
import { ClipboardActionError } from "./device-clipboard";
import { mergeAuthoritativeDeviceSetting } from "./device-setting-writes";
import { IOS_INPUT_UNAVAILABLE_MESSAGE } from "./ios-input-error";
import { KeyedWriteTracker } from "./keyed-write-tracker";
import { createRotationCursor } from "./rotation-cursor";
import { copySimulatorText } from "./ios-clipboard";
import {
  createOrderedKeyboardInput,
  INPUT_DISCONNECTED_MESSAGE,
  type KeyMessage,
} from "./ordered-keyboard-input";
import { middlewareEndpointForBrowser, proxyPreviewConfigForBrowser } from "./proxy-preview-config";
import { sessionTokenFetch, sessionTokenProtocols, withSessionTokenQuery } from "./session-token";
import { type ParsedSseBlock, drainSseChunk } from "./sse";
import { normalizeDeviceStreamSettings } from "./stream-settings";
import { resolveDeviceStreamMode } from "./stream-mode";
import { useAccessibility } from "./useAccessibility";
import { useAppPermissions } from "./useAppPermissions";
import { useAvccStream } from "./useAvccStream";
import { type DeviceLocationBackend, useDeviceLocation } from "./useDeviceLocation";
import { useStreamSettingsResource } from "./useStreamSettingsResource";
import { useDeviceSettingsReadStatus } from "./useDeviceSettingsReadStatus";
import { useWebRtcStream, type WebRtcIceServer } from "./useWebRtcStream";
import { presentedVideoFrameDelta } from "./video-frame-metadata";
import { preserveVideoFrame } from "./video-frame-poster";
import {
  type WebRtcCodec,
  type WebRtcStreamFailure,
  webRtcFallbackDecision,
  createLadderBackoff,
} from "./webrtc-fallback";
import { createInputSocket } from "./input-socket";
import {
  discardUnfinishedQueuedGestures,
  enqueueWsMessage,
  sendOrQueueWsMessage,
  type QueuedWsMessage,
  type WsMessagePayload,
  type WsMessageSent,
} from "./ws-send-queue";
import { WS_MSG_CONFIG } from "./input-protocol";
import { WS_REASON_INPUT_UNAVAILABLE } from "./input-protocol";

const MAX_LOGS = 200;
const RECONNECT_MS = 1500;

/** A new multipart request for the same MJPEG stream. */
function freshStreamSrc(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
}

/**
 * Show `frame`'s picture behind `img` while `img` loads a new request: a
 * browser clears an `<img>` when its `src` changes. Best effort.
 */
function bridgeMjpegFrame(img: HTMLImageElement, frame: HTMLImageElement): void {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = frame.naturalWidth;
    canvas.height = frame.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(frame, 0, 0);
    const picture = canvas.toDataURL("image/jpeg");
    if (!picture || picture === "data:,") return;
    img.style.backgroundImage = `url("${picture}")`;
    img.style.backgroundSize = "cover";
    img.style.backgroundPosition = "center";
  } catch {
    // Without the bridge, the hand-over can show the empty surface briefly.
  }
}

function clearMjpegBridge(img: HTMLImageElement | null): void {
  if (!img?.style?.backgroundImage) return;
  img.style.backgroundImage = "";
  img.style.backgroundSize = "";
  img.style.backgroundPosition = "";
}
const DEVICE_SETTINGS_POLL_MS = 5000;
const DEVICE_SETTINGS_RETRY_MAX_MS = 30_000;
const ACTIVITY_STALE_MS = 8000;
const noop = () => {};

// serve-sim binary WS message tags (serve-sim-client `SimulatorView`).
const WS_MSG_TOUCH = 0x03;
const WS_MSG_BUTTON = 0x04;
const WS_MSG_MULTI_TOUCH = 0x05;
const WS_MSG_KEY = 0x06;
const WS_MSG_ORIENTATION = 0x07;
// Native scroll (wheel/trackpad) in raw device fractions, anchored under the pointer.
const WS_MSG_SCROLL = 0x0b;
const WS_MSG_SOFTWARE_KEYBOARD = 0x0c;
// Connect/disconnect the guest's hardware keyboard; serve-sim's own touch
// client sends this too so the on-screen keyboard shows.
const WS_MSG_HARDWARE_KEYBOARD = 0x0e;
export { WS_MSG_CONFIG as WS_TAG_SCREEN_CONFIG } from "./input-protocol";
// iPhone Duo hinge commands carry a requestId that the helper acknowledges with 0x90.
const WS_MSG_HINGE_CONTROL = 0x10;
const WS_TAG_HINGE_REPLY = 0x90;

// The iPhone Duo's fold controls, as Xcode's Device Hub offers them.
const DUO_FOLD_ANGLE = { min: 0, max: 180 } as const;
const DUO_FOLD_POSES = Object.fromEntries(
  FOLD_POSES.map((pose) => [pose, { angle: DUO_POSE_ANGLES[pose] }]),
) as Record<FoldPose, { angle: number }>;

// HID keyboard usage codes (USB HID Usage Page 0x07) for the R reload chord.
const HID_USAGE_R = 0x15; // 'r'

// The simulator-settings option behind `hardwareKeyboardConnected`.
const UI_OPTION_HARDWARE_KEYBOARD = "hardware-keyboard";

type ClipboardState = {
  /** Counts the actions that started. */
  actionId: number;
  action: DeviceClipboardAction | null;
  pending: DeviceClipboardAction | null;
  error: string | null;
  warning: string | null;
};
const IDLE_CLIPBOARD: ClipboardState = {
  actionId: 0,
  action: null,
  pending: null,
  error: null,
  warning: null,
};

const PLACEHOLDER_DEVICES: RunningDevice[] = [
  { id: "ios", name: "iPhone Simulator", platform: "ios", current: true },
];

const IOS_HTTP_STREAM_CAPABILITIES = {
  modeAvailability: { mjpeg: true, h264: true, webrtc: false },
  httpCodecs: ["auto", "h264", "mjpeg"],
  webRtcCodecs: [],
} as const satisfies DeviceStreamCapabilities;

const IOS_WEBRTC_STREAM_CAPABILITIES = {
  modeAvailability: { mjpeg: false, h264: false, webrtc: true },
  httpCodecs: [],
  webRtcCodecs: ["h264", "vp9", "vp8"],
} as const satisfies DeviceStreamCapabilities;

const IOS_STREAM_SETTING_CAPABILITIES = {
  mjpegFps: true,
  mjpegQuality: true,
  maxDimension: true,
  h264Bitrate: true,
  h264Fps: true,
} as const satisfies DeviceStreamSettingCapabilities;

/**
 * Stream modes for the transport serve-sim advertises in `/api`. serve-sim
 * locks a WebRTC server to WebRTC and refuses its HTTP streams; a missing or
 * unknown value is its HTTP default.
 */
export function iosStreamCapabilities(streamSettings: unknown): DeviceStreamCapabilities {
  const transport =
    streamSettings && typeof streamSettings === "object"
      ? (streamSettings as { transport?: unknown }).transport
      : undefined;
  return transport === "webrtc" ? IOS_WEBRTC_STREAM_CAPABILITIES : IOS_HTTP_STREAM_CAPABILITIES;
}

// iOS only has a Home button + app switcher; the rest are no-ops.
const BUTTON_NAME: Record<HardwareButton, string | null> = {
  home: "home",
  appSwitcher: "app_switcher",
  power: "lock",
  back: null,
  recents: null,
  hideKeyboard: null,
};

const decoder = new TextDecoder();

function parseIosStreamSettings(
  value: unknown,
  fallback: DeviceStreamEncoderSettings,
): DeviceStreamEncoderSettings {
  return normalizeDeviceStreamSettings(value, fallback);
}

function iosStreamSettingsPatch(
  patch: Partial<DeviceStreamEncoderSettings>,
): Partial<DeviceStreamEncoderSettings> | null {
  return Object.keys(patch).length > 0 ? patch : null;
}

function toWs(url: string): string {
  return url.replace(/^http/, "ws");
}

/**
 * `…/helper/<udid>/ws` -> `…/helper/ws?device=<udid>`
 * serve-sim
 */
export function toQueryStyleHelperWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  const match = url.pathname.match(/^(.*\/helper)\/([^/]+)\/ws$/);
  if (!match) throw new Error(`Invalid helper ws url, no deviceId matched: ${wsUrl}`);
  url.pathname = `${match[1]}/ws`;
  if (!url.searchParams.has("device")) {
    url.searchParams.set("device", decodeURIComponent(match[2]));
  }
  return url.toString();
}

/** Resolved connection: where to stream video/input, and how to reach logs/devices. */
interface ResolvedConfig {
  /** Base serve-sim helper URL used by `/stream.avcc`. */
  url: string;
  streamUrl: string;
  wsUrl: string;
  /** The helper sends `WS_MSG_INPUT_ADMITTED` to an admitted input socket. */
  inputAdmission: boolean;
  /** The helper answers `WS_MSG_PASTE`; an older one drops it. */
  inputPaste: boolean;
  /** The helper answers `WS_MSG_INPUT_BARRIER` by request ID; an older one only without one. */
  inputCopy: boolean;
  device: string | null;
  pid: number | null;
  /** Middleware exec-ws URL used for logs, events, metrics, and UI requests. */
  execWsUrl: string | null;
  execToken: string | null;
  configEventsPath: string;
  /** Relative SSE path to subscribe for logs, e.g. `/logs?device=<udid>`. */
  logsPath: string | null;
  /** Absolute URL of the foreground-app SSE stream. */
  appStateUrl: string | null;
  /** Absolute URL of the app icon route, when the server has one. */
  appIconUrl: string | null;
  /** Relative SSE path for normalized serve-sim events. */
  eventsPath: string | null;
  /** Relative SSE path for foreground app activity. */
  metricsPath: string | null;
  axUrl: string | null;
  /** Runtime encoder settings endpoint on the selected helper. */
  streamSettingsUrl: string | null;
  /** Initial server-provided stream settings, if present. */
  initialStreamSettings: unknown;
  transportLocked: boolean;
  gridApiUrl: string | null;
  /** Middleware route serving Xcode's iPhone Duo model (`grid/api/devicekit-model`). */
  deviceKitModelUrl: string | null;
  /** DeviceKit chrome advertised for the device: `phone15` is the Duo's cover, with its inner display as a variant. */
  chrome: DeviceDisplayChrome | null;
  webRtcCodec: WebRtcCodec;
  webRtcIceServers?: WebRtcIceServer[];
}

/** Shape of the serve-sim middleware `/api` (and grid) responses we read. */
interface PreviewApi {
  url?: string;
  streamUrl?: string;
  wsUrl?: string;
  inputAdmission?: boolean;
  inputPaste?: boolean;
  inputCopy?: boolean;
  device?: string;
  pid?: number;
  basePath?: string;
  execToken?: string;
  logsEndpoint?: string;
  appStateEndpoint?: string;
  appIconEndpoint?: string;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  axEndpoint?: string;
  streamSettingsEndpoint?: string;
  gridApiEndpoint?: string;
  /** Bezel geometry for `device`; its identifier names the DeviceKit chrome profile. */
  chrome?: DeviceDisplayChrome | null;
  proxyHelpers?: boolean;
  streamSettings?:
    | ({
        transport: "http";
        codec?: "auto" | "h264" | "mjpeg";
      } & Partial<DeviceStreamEncoderSettings>)
    | ({
        transport: "webrtc";
        codec: WebRtcCodec;
        iceServers?: WebRtcIceServer[];
      } & Partial<DeviceStreamEncoderSettings>);
}

// The requested server, device, and credentials that one resolved config belongs to.
function connectionKey(baseUrl: string, device: string | null, token: string | null): string {
  return JSON.stringify([baseUrl, device, token]);
}

function configKey(config: ResolvedConfig): string {
  const settings = config.initialStreamSettings as PreviewApi["streamSettings"];
  return JSON.stringify({
    ...config,
    initialStreamSettings: {
      ...normalizeDeviceStreamSettings(settings),
      transport: settings?.transport ?? "http",
      codec: settings?.codec ?? "h264",
    },
  });
}

/** @deprecated Use DeviceClientProvider with useDeviceClient or useDeviceScreenClient instead. */
export function useIosDeviceClient(options: DeviceConnectionOptions): DeviceClient {
  const {
    baseUrl,
    enabled = true,
    device: targetDevice = null,
    streamMode: requestedStreamMode,
    token = null,
  } = options;
  const active = enabled && !!baseUrl;
  const sessionFetch = useMemo(() => sessionTokenFetch(token), [token]);
  const socketProtocols = useMemo(() => sessionTokenProtocols("ios", token), [token]);
  const connectionScope = active ? JSON.stringify([baseUrl, targetDevice, token]) : null;
  const { deviceSettingsStatus, resetRead, settleRead } =
    useDeviceSettingsReadStatus(connectionScope);
  const deviceSettingVersionsRef = useRef(new Map<DeviceSettingKey, number>());

  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // A refusal stays visible until server admission confirms recovery.
  const [inputSocketError, setInputSocketError] = useState<string | null>(null);
  // serve-sim's native HID setup failed; lasts until serve-sim restarts.
  const [inputUnavailable, setInputUnavailable] = useState(false);
  // serve-sim's full config; `publicScreen` below is the platform-neutral part.
  const [screen, setScreen] = useState<SimScreenConfig | null>(null);
  const [fps, setFps] = useState(0);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Logs are opt-in: nothing streams until the user attaches.
  const [logsEnabled, setLogsEnabled] = useState(false);
  const [eventLogState, setEventLogState] = useState(createIosEventLogState);
  const events = eventLogState.events;
  const [eventsEnabled, setEventsEnabled] = useState(false);
  const [activity, setActivity] = useState<DeviceActivity | null>(null);
  const [activityDiscoveryError, setActivityDiscoveryError] = useState<string | null>(null);
  const [devices, setDevices] = useState<RunningDevice[]>(PLACEHOLDER_DEVICES);
  // The credentials above follow the options at once, but a new config waits for `/api`. Until
  // it arrives, the old config is not used, so its URLs never get another connection's token.
  // Effect cleanups still close the old connections with the credentials they opened them with.
  const [resolvedConfig, setResolvedConfig] = useState<{
    key: string;
    config: ResolvedConfig | null;
    middleware: Pick<ResolvedConfig, "execWsUrl" | "execToken" | "configEventsPath">;
  } | null>(null);
  const connection = resolvedConfig?.key === connectionScope ? resolvedConfig : null;
  const config = connection?.config ?? null;
  // @ref LLP 0015#temporary-drops — a helper restart keeps the stream mode and the device it showed
  // While a helper restarts, `/api` has no config for the same connection. The
  // last one still names the device, its transport, and its 3D model, so the
  // screen keeps its surface and media element instead of loading again.
  const lastConfigRef = useRef<{ scope: string | null; config: ResolvedConfig } | null>(null);
  if (config) lastConfigRef.current = { scope: connectionScope, config };
  const knownConfig =
    config ??
    (lastConfigRef.current?.scope === connectionScope ? lastConfigRef.current.config : null);
  // The helper's screen config goes with it. The view keeps the device's last
  // one until the replacement helper reports its own; a different device never
  // inherits it, so its hinge state cannot classify the next simulator.
  const screenOwner = JSON.stringify([connectionScope, knownConfig?.device ?? null]);
  const lastScreenRef = useRef<{ owner: string; screen: SimScreenConfig } | null>(null);
  const screenOwnerRef = useRef<{ owner: string; stale: SimScreenConfig | null }>({
    owner: screenOwner,
    stale: null,
  });
  if (screenOwnerRef.current.owner !== screenOwner) {
    // This render still holds the previous owner's config, until the helper effect clears it.
    screenOwnerRef.current = { owner: screenOwner, stale: screen };
    lastScreenRef.current = null;
  }
  if (screen && screen !== screenOwnerRef.current.stale) {
    lastScreenRef.current = { owner: screenOwner, screen };
  }
  const viewScreen =
    screen ?? (lastScreenRef.current?.owner === screenOwner ? lastScreenRef.current.screen : null);
  const activityScope = active
    ? JSON.stringify([
        baseUrl,
        targetDevice,
        token,
        config?.url,
        config?.device,
        config?.pid,
        config?.metricsPath,
        config?.execWsUrl,
        config?.execToken,
      ])
    : null;
  const { activityStatus, setActivityStatus } = useActivityStatus(activityScope);
  const refreshConfigRef = useRef<(() => void) | null>(null);
  const applyPreviewConfigRef = useRef<((value: PreviewApi | null) => void) | null>(null);
  const configUpdatesReadyRef = useRef(false);
  const streamCapabilities = config ? iosStreamCapabilities(config.initialStreamSettings) : null;
  const knownStreamCapabilities = knownConfig
    ? iosStreamCapabilities(knownConfig.initialStreamSettings)
    : null;
  // Preserve supported viewer choices; map unavailable ones to the server's transport.
  const streamMode = knownStreamCapabilities
    ? resolveDeviceStreamMode(requestedStreamMode, knownStreamCapabilities.modeAvailability)
    : requestedStreamMode;
  // @ref LLP 0013#shared-ios-control-channel — one channel per exec-ws identity, so a null config keeps it open
  // Exec-ws details outlive a null config, so its subscriptions can await a replacement helper.
  const controlWsUrl = connection?.middleware.execWsUrl ?? null;
  const controlToken = connection?.middleware.execToken ?? null;
  const controlSocket = useMemo(
    () =>
      controlWsUrl && controlToken
        ? createControlSocket(controlWsUrl, controlToken, {
            retryMs: RECONNECT_MS,
            openSocket: (address) => new WebSocket(address, socketProtocols),
          })
        : null,
    [controlWsUrl, controlToken, socketProtocols],
  );
  useEffect(() => {
    controlSocket?.activate();
    return () => controlSocket?.dispose();
  }, [controlSocket]);
  const requestHostUi = useCallback(
    (url: string, execToken: string, payload: Parameters<typeof hostUiRequest>[2]) =>
      hostUiRequest(url, execToken, payload, socketProtocols, controlSocket ?? undefined),
    [controlSocket, socketProtocols],
  );
  // The simulator's system dark/light setting. null until read.
  const [appearance, setAppearanceState] = useState<DeviceAppearance | null>(null);
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings | null>(null);
  const [deviceSettingsPending, setDeviceSettingsPending] = useState<ReadonlySet<DeviceSettingKey>>(
    () => new Set(),
  );
  // Browser HID injection remains active when this is false. Disabling the
  // Simulator-owned host connection lets iOS keep its software keyboard open.
  const [hardwareKeyboardConnected, setHardwareKeyboardConnectedState] = useState<boolean | null>(
    null,
  );
  const hardwareKeyboardIntentRef = useRef({ pending: false });
  // The frontmost app, pushed by the middleware's /appstate SSE. null until the
  // first event.
  const [foregroundApp, setForegroundApp] = useState<ForegroundApp | null>(null);

  const inputSocketRef = useRef<ReturnType<typeof createInputSocket> | null>(null);
  const [clipboardState, setClipboardState] = useState(IDLE_CLIPBOARD);
  const clipboardGenerationRef = useRef(0);
  // @ref LLP 0013#clipboard — another device or server clears the state; a replaced helper fails the action
  // The results of another device or server no longer show. A new helper for the same device does
  // not clear them, so a request that its input socket dropped ends in `clipboardError`.
  const clipboardIdentity = active && baseUrl ? connectionKey(baseUrl, targetDevice, token) : null;
  useEffect(() => {
    clipboardGenerationRef.current++;
    setClipboardState((state) => ({ ...IDLE_CLIPBOARD, actionId: state.actionId }));
  }, [clipboardIdentity]);
  const pendingInputRef = useRef<{
    scope: string | null;
    helper: string | null;
    messages: QueuedWsMessage[];
  }>({ scope: null, helper: null, messages: [] });
  const inputHelperKey = config
    ? JSON.stringify([config.device, config.wsUrl, config.pid, config.execToken])
    : null;
  // @ref LLP 0013#input-ownership — only a real scope/helper change retires input callbacks
  const [inputOwner, setInputOwner] = useState(() => ({
    scope: connectionScope,
    helper: inputHelperKey,
    identity: Symbol("ios-input"),
  }));
  if (
    inputOwner.scope !== connectionScope ||
    (inputOwner.helper !== null && inputHelperKey !== null && inputOwner.helper !== inputHelperKey)
  ) {
    setInputOwner({
      scope: connectionScope,
      helper: inputHelperKey,
      identity: Symbol("ios-input"),
    });
  } else if (inputOwner.helper === null && inputHelperKey !== null) {
    // Initial discovery binds the early queue without retiring its callbacks.
    setInputOwner({ ...inputOwner, helper: inputHelperKey });
  }
  const inputIdentity = inputOwner.identity;
  const committedInputIdentityRef = useRef(inputIdentity);
  useLayoutEffect(() => {
    committedInputIdentityRef.current = inputIdentity;
  }, [inputIdentity]);
  const ownsInput = useCallback(
    () =>
      committedInputIdentityRef.current === inputIdentity && pendingInputRef.current.scope !== null,
    [inputIdentity],
  );
  // @ref LLP 0013#ios-input-adapter — discovery gaps retain intent, known owner changes discard it
  useLayoutEffect(() => {
    const previous = pendingInputRef.current;
    const sameScope = previous.scope === connectionScope;
    const helper = inputHelperKey ?? (sameScope ? previous.helper : null);
    if (!sameScope || (previous.helper !== null && previous.helper !== helper)) {
      // Retire the old transport before callbacks can send into the new scope.
      inputSocketRef.current?.dispose();
      inputSocketRef.current = null;
      pendingInputRef.current = { scope: connectionScope, helper, messages: [] };
    } else {
      // Initial discovery binds early intent; a temporary null config keeps its owner.
      previous.helper = helper;
    }
  }, [connectionScope, inputHelperKey]);
  // Monotonic log id source, persisted across log-stream reconnects so ids stay
  // unique even though lines are kept (the stream effect may re-run).
  const logSeqRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [webRtcVideoElement, setWebRtcVideoElement] = useState<HTMLVideoElement | null>(null);
  const streamUrlRef = useRef<string | null>(null);
  const [avccFallback, dispatchAvccFallback] = useReducer(avccFallbackReducer, initialAvccFallback);
  const [webRtcCodec, setWebRtcCodecState] = useState<DeviceWebRtcCodec>("h264");
  const [activeWebRtcCodec, setActiveWebRtcCodec] = useState<WebRtcCodec>("h264");
  const deviceSettingWriteTrackerRef = useRef(new KeyedWriteTracker<DeviceSettingKey>());
  // Async option writes capture their config. Track only committed config so
  // an interrupted concurrent render cannot invalidate a legitimate rollback.
  const deviceSettingConfigRef = useRef(config);
  useLayoutEffect(() => {
    deviceSettingConfigRef.current = config;
  }, [config]);
  const activityLastSampleAtRef = useRef(0);
  const streamTransportLocked = config?.transportLocked ?? false;
  const useWebRtc = streamMode === "webrtc";
  const wantsAvcc = streamMode === "h264";
  const useAvcc = wantsAvcc && isAvccSupported() && !avccFallback.fellBack;

  // ── iPhone Duo: hinge state, mirroring serve-sim's client ──
  // Before native capability metadata arrives, recognize the Duo by Xcode's
  // DeviceKit chrome identifiers (phone15 is the cover profile and phone14 the
  // inner display variant) or by its name.
  const currentDeviceId = knownConfig?.device ?? targetDevice;
  const deviceName = devices.find((device) => device.id === currentDeviceId)?.name;
  const chromeIdentifier = knownConfig?.chrome?.identifier;
  const isDuo =
    viewScreen?.supportsHingeAngle === true ||
    chromeIdentifier === "phone14" ||
    chromeIdentifier === "phone15" ||
    /\biphone\s+duo\b/i.test(deviceName ?? "");
  // The flat view rounds the active display with its own glass corners, as the
  // 3D model shows them head-on. Other devices keep the Hub's calibrated shape.
  const displayCorners = useMemo<DisplayCornerRadii | null>(
    () =>
      isDuo && knownConfig?.chrome
        ? displayCornerRadii(
            displayChromeForScreen(knownConfig.chrome, viewScreen?.screenId),
            displayClipOrientation(viewScreen),
          )
        : null,
    [isDuo, knownConfig?.chrome, viewScreen],
  );
  // Consumers get the platform-neutral screen. serve-sim's hinge fields and
  // display IDs stay here, and a hinge move alone keeps the same object.
  const publicScreenRef = useRef<ScreenSize | null>(null);
  const publicScreen = useMemo(() => {
    const next = viewScreen ? simScreenSize(viewScreen, isDuo) : null;
    return screenSizesEqual(publicScreenRef.current, next) ? publicScreenRef.current : next;
  }, [viewScreen, isDuo]);
  publicScreenRef.current = publicScreen;
  // Elements a consumer attached through `displays`, by the kind each was attached as.
  const [panelElements, setPanelElements] = useState<
    Readonly<Record<DuoPanelId, DuoPanelElement | null>>
  >({ 1: null, 3: null });
  // The consumer streams the displays itself, so the flat stream parks meanwhile.
  const displayStreaming = isDuo && (panelElements[1] !== null || panelElements[3] !== null);
  // @ref LLP 0015#screen-sessions — a new device, server, token, surface, or media element loads again
  const screenSessionKey = connectionScope
    ? JSON.stringify([
        connectionScope,
        displayStreaming ? "displays" : "flat",
        useWebRtc ? "video" : useAvcc ? "canvas" : "img",
      ])
    : null;
  const [statusSessionKey, setStatusSessionKey] = useState(screenSessionKey);
  if (statusSessionKey !== screenSessionKey) {
    // The previous session's `streaming` is still in state during this render.
    setStatusSessionKey(screenSessionKey);
    setStatus(screenSessionKey ? "connecting" : "idle");
    setError(null);
  }
  const screenSessionKeyRef = useRef(screenSessionKey);
  useLayoutEffect(() => {
    screenSessionKeyRef.current = screenSessionKey;
  }, [screenSessionKey]);
  const [hingePending, setHingePending] = useState(false);
  const [hingeError, setHingeError] = useState<string | null>(null);
  // The requested state, shown until its acknowledgement and matching config arrive.
  const [hingePreview, setHingePreview] = useState<HingeControlState | null>(null);
  const [physicalPose, setPhysicalPose] = useState<FoldPose | null | undefined>(undefined);
  // A local rotation cleared the native preset; ignore older preset acknowledgements.
  const [orientationOverride, setOrientationOverride] = useState(false);
  const hingePendingRef = useRef(false);
  const sentHingePoseRef = useRef<FoldPose | null | undefined>(undefined);
  const hingeQueueRef = useRef<ReturnType<
    typeof createAcknowledgedControlQueue<FoldControlCommand>
  > | null>(null);
  const hingeListenersRef = useRef(new Set<(event: FoldCommandEvent) => void>());
  const emitHingeEvent = useCallback((event: FoldCommandEvent) => {
    for (const listener of [...hingeListenersRef.current]) listener(event);
  }, []);
  const observeHinge = useCallback((listener: (event: FoldCommandEvent) => void) => {
    hingeListenersRef.current.add(listener);
    return () => {
      hingeListenersRef.current.delete(listener);
    };
  }, []);
  const [streamStatsEnabled, setStreamStatsEnabled] = useState(false);
  const previewHingeAngle = hingePreview?.hingeAngle ?? viewScreen?.hingeAngle;
  const previewHingePose = hingePreview ? hingePreview.hingePose : viewScreen?.hingePose;
  // A pending angle or preset releases Table Mode, so the preview wins over a
  // face-down orientation that another client confirmed.
  const previewTableMode = hingePreview?.tableMode ?? viewScreen?.tableMode;
  const previewFaceDown =
    previewTableMode === true && viewScreen?.physicalOrientation === "facedown";
  // @ref LLP 0016#fold-state-and-commands — an unknown field leaves face down unknown, as serve-sim's framing reads it
  const knownFaceDown =
    previewFaceDown ||
    previewTableMode === false ||
    (viewScreen?.physicalOrientation !== undefined &&
      viewScreen.physicalOrientation !== "facedown");
  const electedPose = physicalPose === undefined ? previewHingePose : physicalPose;
  const activeScreenId = duoIntendedScreen(
    previewHingeAngle,
    electedPose,
    viewScreen?.screenId,
    knownFaceDown ? previewFaceDown : null,
  );
  // Control callbacks read the latest native state without re-registering
  // listeners on every config broadcast.
  const duoRef = useRef({ isDuo, screen });
  duoRef.current = { isDuo, screen };
  useEffect(() => {
    if (streamMode === "webrtc") return;
    setActiveWebRtcCodec(webRtcCodec);
  }, [streamMode, webRtcCodec]);
  // True while the in-flight single-finger drag began in the home-indicator band.
  const edgeGestureRef = useRef(false);
  // Latest screen config, read by the (stable) input callbacks for orientation.
  const screenRef = useRef<SimScreenConfig | null>(null);
  // Layout effects, so an input event right after a paint already maps with the new screen.
  useLayoutEffect(() => {
    screenRef.current = screen;
  }, [screen]);
  // @ref LLP 0015#temporary-drops — input maps with the screen the view shows, also a kept one
  // Pointer input is measured on the shown frame, so it maps back with the
  // same orientation: the helper's config, or the kept one while a helper restarts.
  const viewScreenRef = useRef<SimScreenConfig | null>(null);
  useLayoutEffect(() => {
    viewScreenRef.current = viewScreen;
  }, [viewScreen]);
  const rotationCursorRef = useRef(createRotationCursor());
  useEffect(() => {
    rotationCursorRef.current.updateReadback(screen?.orientation);
  }, [screen?.orientation]);
  // Once the helper WS pushes a config, it owns dimensions+orientation.
  const hasWsConfigRef = useRef(false);

  const applyStreamSrc = useCallback(() => {
    const img = imgRef.current;
    const url = streamUrlRef.current;
    if (!img || !url) return;
    img.src = freshStreamSrc(url);
  }, []);

  const attachVideo = useCallback(
    (el: HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | null) => {
      if (useWebRtc) {
        videoRef.current = (el as HTMLVideoElement) ?? null;
        setWebRtcVideoElement(videoRef.current);
        canvasRef.current = null;
        imgRef.current = null;
      } else if (useAvcc) {
        canvasRef.current = (el as HTMLCanvasElement) ?? null;
        videoRef.current = null;
        setWebRtcVideoElement(null);
        imgRef.current = null;
      } else {
        // The stream effect may have started before this element attached, so
        // only here can a detached <img> stop its multipart request.
        if (imgRef.current && imgRef.current !== el) imgRef.current.removeAttribute("src");
        imgRef.current = (el as HTMLImageElement) ?? null;
        canvasRef.current = null;
        videoRef.current = null;
        setWebRtcVideoElement(null);
        if (el) applyStreamSrc();
      }
    },
    [applyStreamSrc, useAvcc, useWebRtc],
  );

  // Every helper-socket message goes through here so a brief reconnect queues
  // input instead of dropping it (matching serve-sim's client).
  const sendWs = useCallback(
    (tag: number, payload: WsMessagePayload, onSent?: WsMessageSent) => {
      if (!ownsInput()) return false;
      const pending = pendingInputRef.current;
      if (inputSocketRef.current && deviceSettingConfigRef.current) {
        inputSocketRef.current.send(tag, payload, onSent);
      } else {
        pending.messages = sendOrQueueWsMessage(
          null,
          pending.messages,
          tag,
          payload,
          Date.now(),
          onSent,
        );
      }
      return true;
    },
    [ownsInput],
  );

  // The helper routes input to the display that native readback reports. A
  // gesture that begins on another display would land on the wrong panel, so
  // it is dropped through its end.
  const isNativeDisplay = useCallback(
    (display: DeviceDisplayId | undefined) =>
      display === undefined || DUO_PANEL_FOR_DISPLAY[display] === screenRef.current?.screenId,
    [],
  );
  const droppedDisplayGestureRef = useRef({ touch: false, multi: false });
  const dropsDisplayInput = useCallback(
    (
      kind: "touch" | "multi",
      display: DeviceDisplayId | undefined,
      phase: TouchSample["phase"],
    ) => {
      const dropped = droppedDisplayGestureRef.current;
      if (phase === "begin") dropped[kind] = !isNativeDisplay(display);
      if (!dropped[kind]) return false;
      if (phase === "end") dropped[kind] = false;
      return true;
    },
    [isNativeDisplay],
  );

  const sendTouch = useCallback(
    (sample: TouchSample) => {
      if (!ownsInput() || dropsDisplayInput("touch", sample.display, sample.phase)) return;
      const orientation = streamGeometry(viewScreenRef.current).inputOrientation;

      let displayEdge: number | undefined;
      if (sample.phase === "begin") {
        edgeGestureRef.current = homeIndicatorEdge(sample) !== undefined;
        if (edgeGestureRef.current) displayEdge = HID_EDGE_BOTTOM;
      } else if (edgeGestureRef.current) {
        displayEdge = HID_EDGE_BOTTOM;
        if (sample.phase === "end") edgeGestureRef.current = false;
      }

      const p = rawPointForDisplayPoint(orientation, sample.x, sample.y);
      const edge =
        displayEdge === undefined ? undefined : rawEdgeForDisplayEdge(orientation, displayEdge);
      const payload =
        edge === undefined ? { type: sample.phase, ...p } : { type: sample.phase, ...p, edge };
      if (sample.phase === "end" && sample.cancelled) {
        // A single→multi transition releases an admitted finger but is not a completed tap.
        const pending = pendingInputRef.current;
        pending.messages = discardUnfinishedQueuedGestures(pending.messages, WS_MSG_TOUCH);
        const socket = inputSocketRef.current;
        socket?.discardUnfinishedGestures(WS_MSG_TOUCH);
        socket?.trySend(WS_MSG_TOUCH, payload);
      } else {
        sendWs(WS_MSG_TOUCH, payload);
      }
    },
    [sendWs, ownsInput, dropsDisplayInput],
  );

  const sendMultiTouch = useCallback(
    (sample: MultiTouchSample) => {
      if (dropsDisplayInput("multi", sample.display, sample.phase)) return;
      const orientation = streamGeometry(viewScreenRef.current).inputOrientation;
      const a = rawPointForDisplayPoint(orientation, sample.a.x, sample.a.y);
      const b = rawPointForDisplayPoint(orientation, sample.b.x, sample.b.y);
      sendWs(WS_MSG_MULTI_TOUCH, { type: sample.phase, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    },
    [sendWs, dropsDisplayInput],
  );

  // Scroll-to-pan: forwarded as a native scroll event so iOS pans content
  // exactly as it would for a physical wheel — no synthesized finger drag.
  // Both the delta and the cursor anchor are rotated into raw device
  // orientation so scrolling tracks the visible content on rotated devices.
  const sendScroll = useCallback(
    (sample: ScrollSample) => {
      if (!Number.isFinite(sample.dx) || !Number.isFinite(sample.dy)) return;
      if (sample.dx === 0 && sample.dy === 0) return;
      if (!isNativeDisplay(sample.display)) return;
      const orientation = streamGeometry(viewScreenRef.current).inputOrientation;
      const delta = rawDeltaForDisplayDelta(orientation, sample.dx, sample.dy);
      const anchor = rawPointForDisplayPoint(orientation, sample.x, sample.y);
      sendWs(WS_MSG_SCROLL, { dx: delta.dx, dy: delta.dy, x: anchor.x, y: anchor.y });
    },
    [sendWs, isNativeDisplay],
  );

  // Keep ordinary input owned across discovery gaps; clipboard requests require a live config.
  const keyboard = useMemo(
    () =>
      createOrderedKeyboardInput({
        sendKey: (message: KeyMessage) => {
          sendWs(WS_MSG_KEY, message);
        },
        trySendFrame: (frame) =>
          ownsInput() && inputSocketRef.current?.trySendEncoded(frame) === true,
      }),
    [sendWs, ownsInput],
  );
  const keyboardInput = useCallback(
    () => (config && config === deviceSettingConfigRef.current && ownsInput() ? keyboard : null),
    [config, keyboard, ownsInput],
  );

  const sendKey = useCallback(
    (input: KeyboardInput): boolean => {
      const message = iosMessageForKeyboardInput(input);
      if (!message) return false;
      if (!ownsInput()) return false;
      keyboard.send(message);
      return true;
    },
    [keyboard, ownsInput],
  );

  const cancelInput = useCallback(() => {
    keyboard.cancelKeys((event) => {
      if (ownsInput()) inputSocketRef.current?.trySend(WS_MSG_KEY, event);
    });
    if (!ownsInput()) return;
    const pending = pendingInputRef.current;
    pending.messages = pending.messages.filter(
      (message) => message.tag !== WS_MSG_KEY && message.tag !== WS_MSG_SCROLL,
    );
    pending.messages = discardUnfinishedQueuedGestures(pending.messages, WS_MSG_TOUCH);
    pending.messages = discardUnfinishedQueuedGestures(pending.messages, WS_MSG_MULTI_TOUCH);
    const socket = inputSocketRef.current;
    socket?.discardQueued(WS_MSG_KEY);
    socket?.discardQueued(WS_MSG_SCROLL);
    socket?.discardUnfinishedGestures(WS_MSG_TOUCH);
    socket?.discardUnfinishedGestures(WS_MSG_MULTI_TOUCH);
  }, [keyboard, ownsInput]);
  useEffect(() => {
    const stopListening = listenForInputCancellation(cancelInput);
    return () => {
      stopListening();
      keyboard.cancel();
    };
  }, [cancelInput, keyboard]);
  // Pre-mapped key events (phone-keyboard capture) are paced a few ms apart so
  // iOS doesn't coalesce a pasted string into a couple of lost keystrokes.
  const sendKeyEvents = useCallback(
    (events: ReadonlyArray<HidKeyEvent>) => {
      if (ownsInput()) keyboard.enqueue(events);
    },
    [keyboard, ownsInput],
  );

  // @ref LLP 0013#clipboard — pending, error and warning follow the latest action; each call keeps its own result
  const runClipboardAction = useCallback(
    async <T>(
      kind: DeviceClipboardAction,
      action: () => Promise<{ value: T; warning?: string }>,
    ): Promise<T> => {
      const generation = ++clipboardGenerationRef.current;
      setClipboardState((state) => ({
        actionId: state.actionId + 1,
        action: kind,
        pending: kind,
        error: null,
        warning: null,
      }));
      const settle = (next: Omit<ClipboardState, "actionId" | "action">) => {
        if (generation === clipboardGenerationRef.current) {
          setClipboardState((state) => ({ ...state, ...next }));
        }
      };
      try {
        const { value, warning } = await action();
        settle({ pending: null, error: null, warning: warning ?? null });
        return value;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // A failed action can still leave a key held, as a failed Copy in serve-sim does.
        const warning =
          failure instanceof ClipboardActionError ? (failure.cleanupWarning ?? null) : null;
        settle({ pending: null, error: failure.message, warning });
        throw failure;
      }
    },
    [],
  );

  const pasteText = useCallback(
    (text?: string) =>
      runClipboardAction("paste", async () => {
        if (!config?.inputPaste) throw new Error("Paste is not available on this simulator.");
        const keyboard = keyboardInput();
        if (!keyboard) throw new Error(INPUT_DISCONNECTED_MESSAGE);
        const { cleanupWarning } = await keyboard.paste(text);
        return { value: undefined, warning: cleanupWarning };
      }),
    [config, keyboardInput, runClipboardAction],
  );

  const copyText = useCallback(
    () =>
      runClipboardAction("copy", async () => {
        const c = config;
        if (!baseUrl || !c?.inputCopy) throw new Error("Copy is not available on this simulator.");
        const keyboard = keyboardInput();
        if (!keyboard) throw new Error(INPUT_DISCONNECTED_MESSAGE);
        const { text, cleanupWarning } = await keyboard.readAfterInput((signal) =>
          copySimulatorText(
            baseUrl,
            c.device ?? targetDevice,
            c.execToken,
            c.execToken ? fetch : sessionFetch,
            signal,
          ),
        );
        return { value: text, warning: cleanupWarning };
      }),
    [baseUrl, config, keyboardInput, runClipboardAction, sessionFetch, targetDevice],
  );

  // Connect/disconnect the Mac keyboard from the guest through serve-sim's
  // `hardware-keyboard` simulator setting (the same request its settings panel
  // makes). Optimistic; reverted if the middleware rejects it.
  const setHardwareKeyboardConnected = useCallback(
    (connected: boolean) => {
      const c = config;
      if (!c || !c.execWsUrl || !c.execToken || !c.device) return;
      const intent = { pending: true };
      hardwareKeyboardIntentRef.current = intent;
      const previous = hardwareKeyboardConnected;
      setHardwareKeyboardConnectedState(connected);
      void requestHostUi(c.execWsUrl, c.execToken, {
        device: c.device,
        option: UI_OPTION_HARDWARE_KEYBOARD,
        value: connected ? "on" : "off",
      })
        .catch(() => {
          if (hardwareKeyboardIntentRef.current === intent)
            setHardwareKeyboardConnectedState(previous);
        })
        .finally(() => {
          if (hardwareKeyboardIntentRef.current === intent)
            hardwareKeyboardIntentRef.current = { pending: false };
        });
    },
    [config, hardwareKeyboardConnected, requestHostUi],
  );

  const toggleSoftwareKeyboard = useCallback(() => {
    sendWs(WS_MSG_SOFTWARE_KEYBOARD, {});
  }, [sendWs]);

  const pressButton = useCallback(
    (button: HardwareButton) => {
      const name = BUTTON_NAME[button];
      if (name) sendWs(WS_MSG_BUTTON, { button: name });
    },
    [sendWs],
  );

  // Reload the RN/Expo bundle by injecting ⌘R over the helper's key channel
  // (tag 0x06 → HID keystroke) — RN registers ⌘R as its reload shortcut. Mirrors
  // the serve-sim web client's sequence exactly: ⌘ down, R down, R up, ⌘ up, with
  // a sequential 30ms await between each event (so the gaps can't compress under
  // timer jitter). Harmless if the foreground app isn't RN.
  const reload = useCallback(async () => {
    const key = (type: "down" | "up", usage: number) => sendWs(WS_MSG_KEY, { type, usage });
    key("down", HID_USAGE_R);
    await new Promise((r) => setTimeout(r, 30));
    key("up", HID_USAGE_R);
  }, [sendWs]);

  // Keep cycling from requested poses while the helper's readback is delayed
  // or an app declines a pose. Screen state still comes only from readback.
  // Other devices follow Simulator's counterclockwise "Rotate Left"; the
  // iPhone Duo turns clockwise like Xcode's Device Hub and serve-sim, and the
  // native preset, which a rotation clears, is forgotten at once.
  const rotate = useCallback(() => {
    const duo = duoRef.current;
    const direction = duo.isDuo ? "right" : "left";
    if (duo.isDuo) {
      setHingePreview(null);
      setPhysicalPose(null);
      sentHingePoseRef.current = null;
      setOrientationOverride(true);
      emitHingeEvent({ type: "rotated" });
    }
    // Resolve each queued click in delivery order; refused, expired or evicted
    // input must not advance the cursor.
    sendWs(
      WS_MSG_ORIENTATION,
      () => ({ orientation: rotationCursorRef.current.peekNext(direction) }),
      (payload) =>
        rotationCursorRef.current.recordSent(
          (payload as { orientation: DeviceOrientation }).orientation,
        ),
    );
  }, [sendWs, emitHingeEvent]);

  // One command at a time: a live slider coalesces into the newest value and a
  // preset replaces queued edits. Replies arrive as 0x90 on the helper socket.
  if (!hingeQueueRef.current) {
    hingeQueueRef.current = createAcknowledgedControlQueue<FoldControlCommand>({
      send: (request) => {
        const wire = { ...request, command: hingeWireCommand(request.command) };
        if (!inputSocketRef.current?.trySend(WS_MSG_HINGE_CONTROL, wire)) return false;
        if (request.command.control === "pose") sentHingePoseRef.current = request.command.value;
        const panel = duoCommandScreen(request.command, sentHingePoseRef.current);
        emitHingeEvent({
          type: "sent",
          command: request.command,
          display: panel === undefined ? undefined : DUO_DISPLAY_FOR_PANEL[panel],
        });
        return true;
      },
      onPendingChange: (pending) => {
        hingePendingRef.current = pending;
        setHingePending(pending);
      },
      onResult: (command, reply) => {
        emitHingeEvent({ type: "acknowledged", command, ok: reply.ok });
      },
      onError: (message) => {
        // A failure discards the whole queue, including any preset whose
        // preview is already showing but was never sent or confirmed.
        setHingeError(message);
        setHingePreview(null);
        setPhysicalPose(undefined);
        sentHingePoseRef.current = undefined;
        setOrientationOverride(false);
        emitHingeEvent({ type: "failed", error: message });
      },
    });
  }

  const setHingeControl = useCallback(
    (input: FoldControlCommand) => {
      // Its own object per request, so a listener can follow each one to its reply.
      const command = { ...input };
      const { screen } = duoRef.current;
      setHingeError(null);
      // Editing the hinge or Table Mode clears the named preset, but preserves
      // the simulator's physical orientation (for example Laptop on a table).
      if (command.control === "pose") {
        setPhysicalPose(command.value);
        setOrientationOverride(false);
      }
      setHingePreview((previous) => ({
        hingeAngle: previous?.hingeAngle ?? screen?.hingeAngle,
        hingePose: previous ? previous.hingePose : screen?.hingePose,
        tableMode: previous?.tableMode ?? screen?.tableMode,
        ...hingeControlState(command),
      }));
      emitHingeEvent({ type: "requested", command });
      hingeQueueRef.current?.enqueue(command, {
        key: command.control,
        replaceQueued: command.control === "pose",
      });
    },
    [emitHingeEvent],
  );

  // serve-sim's middleware captures the sim via `simctl io <udid> screenshot`
  // and returns the PNG bytes. Use the resolved udid from `/api` (falling back
  // to the requested device); the middleware defaults to the booted sim if none.
  const screenshot = useCallback(async (): Promise<ScreenshotCapture | null> => {
    if (!baseUrl) return null;
    const udid = config?.device ?? targetDevice;
    return fetchScreenshot(baseUrl, udid, sessionFetch);
  }, [baseUrl, targetDevice, config, sessionFetch]);

  // Apply any serve-sim UI option over its authenticated exec-ws request
  // channel. The state is optimistic so the selected pill/switch responds at
  // once. Writes are serialized per option, while unrelated options can update
  // concurrently. A failed request re-reads only that option's authoritative
  // value so it cannot roll back another optimistic write.
  const setDeviceSetting = useCallback(
    (key: DeviceSettingKey, value: string) => {
      const c = config;
      if (!c?.execWsUrl || !c.execToken || !c.device) return;
      const { device, execToken, execWsUrl } = c;
      const tracker = deviceSettingWriteTrackerRef.current;
      const request = tracker.start(key);
      if (!request) return;
      deviceSettingVersionsRef.current.set(
        key,
        (deviceSettingVersionsRef.current.get(key) ?? 0) + 1,
      );
      setDeviceSettingsPending(tracker.pending);
      setDeviceSettings((current) => ({ ...(current ?? {}), [key]: value }));
      if (key === "appearance" && (value === "light" || value === "dark")) {
        setAppearanceState(value);
      }
      void requestHostUi(execWsUrl, execToken, {
        device,
        option: key,
        value,
      })
        .catch(async () => {
          if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
          try {
            const result = await requestHostUi(execWsUrl, execToken, { device });
            if (!tracker.isCurrent(request) || deviceSettingConfigRef.current !== c) return;
            const authoritative: DeviceSettings = {};
            for (const [nextKey, nextValue] of Object.entries(result.status ?? {})) {
              if (typeof nextValue === "string") {
                authoritative[nextKey as DeviceSettingKey] = nextValue;
              }
            }
            setDeviceSettings((current) =>
              mergeAuthoritativeDeviceSetting(current, key, authoritative),
            );
            if (key === "appearance") {
              const nextAppearance = authoritative.appearance;
              if (nextAppearance === "light" || nextAppearance === "dark") {
                setAppearanceState(nextAppearance);
              }
            }
          } catch {
            // Keep the optimistic value if both the write and authoritative
            // refresh channels are temporarily unavailable.
          }
        })
        .finally(() => {
          if (tracker.finish(request)) setDeviceSettingsPending(tracker.pending);
        });
    },
    [config, requestHostUi],
  );

  const setAppearance = useCallback(
    (mode: DeviceAppearance) => setDeviceSetting("appearance", mode),
    [setDeviceSetting],
  );

  const setInitialWebRtcCodec = useCallback((codec: DeviceWebRtcCodec) => {
    setWebRtcCodecState(codec);
    setActiveWebRtcCodec(codec);
  }, []);

  const attachLogs = useCallback(() => setLogsEnabled(true), []);
  const detachLogs = useCallback(() => setLogsEnabled(false), []);
  const clearLogs = useCallback(() => setLogs([]), []);
  const attachEvents = useCallback(() => setEventsEnabled(true), []);
  const detachEvents = useCallback(() => setEventsEnabled(false), []);
  const clearEvents = useCallback(() => {
    const device = config?.device;
    if (!device) return;
    setEventLogState((current) => clearIosEventLogState(current, device));
  }, [config?.device]);

  // ── Resolve the connection: discover the helper + log/device routes via /api. ──
  //
  // The Hub starts helpers explicitly (see `startIosHelper`) — it never boots a
  // sim just by connecting. So when the middleware is reachable but no helper is
  // attached yet (`/api` → null), we keep polling until the just-started helper
  // comes up, then resolve its streaming config. An unreachable middleware is
  // retried: `baseUrl` is never interpreted as a bare helper.
  useEffect(() => {
    if (!active || !baseUrl) {
      setResolvedConfig(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let revision = 0;
    let current: ResolvedConfig | null = null;
    let lastConfig: ResolvedConfig | null = null;
    // A newly selected device must not keep streaming the previous helper
    // under its name while its own config resolves.
    setResolvedConfig(null);
    setStatus("connecting");
    setError(null);

    // `baseUrl` may carry a path prefix (the plugin mount), so join onto it
    // rather than `new URL('/api', baseUrl)`, which would drop that prefix.
    const apiUrl = `${baseUrl.replace(/\/$/, "")}/api${
      targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ""
    }`;

    const toMiddleware = (rawConfig: PreviewApi): ResolvedConfig => {
      const middlewareUrl = new URL(baseUrl, window.location.href);
      const c = proxyPreviewConfigForBrowser(rawConfig, middlewareUrl);
      const basePath = c.basePath === "/" ? "" : (c.basePath ?? "");
      const absoluteMiddlewareUrl = (path?: string): string | null =>
        path
          ? c.proxyHelpers
            ? middlewareEndpointForBrowser(path, middlewareUrl, basePath)
            : new URL(path, middlewareUrl).toString()
          : null;
      const appStateUrl = absoluteMiddlewareUrl(c.appStateEndpoint);
      return {
        url: c.url!,
        // An <img> and an EventSource cannot set a header.
        streamUrl: withSessionTokenQuery(c.streamUrl ?? `${c.url}/stream.mjpeg`, token),
        wsUrl: toQueryStyleHelperWsUrl(c.wsUrl ?? `${toWs(c.url!)}/ws`),
        inputAdmission: c.inputAdmission === true,
        inputPaste: c.inputPaste === true,
        inputCopy: c.inputCopy === true,
        device: c.device ?? null,
        pid: c.pid ?? null,
        configEventsPath: `${basePath}/api/events${targetDevice ? `?device=${encodeURIComponent(targetDevice)}` : ""}`,
        execWsUrl: toWs(absoluteMiddlewareUrl(`${basePath}/exec-ws`)!),
        execToken: c.execToken ?? null,
        // These are subscription paths inside exec-ws, not browser URLs. The
        // server validates them against its internal middleware mount.
        logsPath: c.logsEndpoint ?? null,
        appStateUrl: appStateUrl && withSessionTokenQuery(appStateUrl, token),
        appIconUrl: absoluteMiddlewareUrl(c.appIconEndpoint),
        eventsPath: c.eventLogEventsEndpoint ?? null,
        metricsPath: c.metricsEndpoint ?? null,
        axUrl: absoluteMiddlewareUrl(c.axEndpoint),
        // A proxied helper URL uses the public middleware mount above rather
        // than an advertised internal host port that may be 0.
        streamSettingsUrl: c.streamSettingsEndpoint
          ? c.proxyHelpers
            ? `${c.url}/stream-settings`
            : absoluteMiddlewareUrl(c.streamSettingsEndpoint)
          : null,
        initialStreamSettings: c.streamSettings,
        transportLocked: c.streamSettings?.transport === "webrtc",
        gridApiUrl: absoluteMiddlewareUrl(c.gridApiEndpoint ?? `${basePath}/grid/api`),
        deviceKitModelUrl: withSessionTokenQuery(
          absoluteMiddlewareUrl(`${basePath}/grid/api/devicekit-model`)!,
          token,
        ),
        chrome: c.chrome ?? null,
        webRtcCodec: c.streamSettings?.transport === "webrtc" ? c.streamSettings.codec : "h264",
        ...(c.streamSettings?.transport === "webrtc" && c.streamSettings.iceServers
          ? { webRtcIceServers: c.streamSettings.iceServers }
          : {}),
      };
    };

    // Ask the grid to attach a helper for this device at most once per effect
    // run (i.e. per device). Resets whenever `targetDevice`/`baseUrl` change.
    let startRequested = false;

    const applyConfig = (value: PreviewApi | null) => {
      if (cancelled) return;
      const next = value?.url && value.device ? toMiddleware(value) : null;
      revision++;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      if (!next) {
        current = null;
        // Keep the middleware subscription alive while its helper is absent.
        setResolvedConfig((previous) =>
          previous?.key === connectionKey(baseUrl, targetDevice, token)
            ? { ...previous, config: null }
            : previous,
        );
        setStatus("connecting");
        setError(null);
        pollTimer = setTimeout(resolve, RECONNECT_MS);
        return;
      }
      if (current && configKey(current) === configKey(next)) return;
      if (
        current &&
        JSON.stringify(current.webRtcIceServers) === JSON.stringify(next.webRtcIceServers)
      ) {
        next.webRtcIceServers = current.webRtcIceServers;
      }
      const previousTransport =
        lastConfig && iosStreamCapabilities(lastConfig.initialStreamSettings);
      const nextTransport = iosStreamCapabilities(next.initialStreamSettings);
      if (
        !lastConfig ||
        lastConfig.device !== next.device ||
        previousTransport?.modeAvailability.webrtc !== nextTransport.modeAvailability.webrtc ||
        lastConfig.webRtcCodec !== next.webRtcCodec
      ) {
        setInitialWebRtcCodec(next.webRtcCodec);
      }
      current = next;
      lastConfig = next;
      setResolvedConfig({
        key: connectionKey(baseUrl, targetDevice, token),
        config: next,
        middleware: {
          execWsUrl: next.execWsUrl,
          execToken: next.execToken,
          configEventsPath: next.configEventsPath,
        },
      });
    };

    const resolve = async () => {
      if (cancelled || inFlight) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      inFlight = true;
      const requestRevision = revision;
      try {
        const res = await sessionFetch(apiUrl, {
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Discovery failed: ${res.status}`);
        const value = (await res.json()) as PreviewApi | null;
        // A pushed update is newer than an HTTP request that was already in flight.
        if (cancelled || requestRevision !== revision) return;
        setActivityDiscoveryError(null);
        applyConfig(value);
        if (!(value?.url && value.device) && targetDevice && !startRequested) {
          startRequested = true;
          void startIosHelper(targetDevice, baseUrl, sessionFetch).catch(() => {});
        }
      } catch {
        // A failed background refresh must not tear down a working video stream.
        if (!cancelled && requestRevision === revision) {
          if (!current) {
            settleRead("error");
            setActivityDiscoveryError(connectionKey(baseUrl, targetDevice, token));
          }
          pollTimer = setTimeout(resolve, RECONNECT_MS);
        }
      } finally {
        inFlight = false;
      }
    };
    const refresh = () => {
      void resolve();
    };
    refreshConfigRef.current = refresh;
    applyPreviewConfigRef.current = applyConfig;
    refresh();

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (refreshConfigRef.current === refresh) refreshConfigRef.current = null;
      if (applyPreviewConfigRef.current === applyConfig) applyPreviewConfigRef.current = null;
    };
  }, [active, baseUrl, targetDevice, setInitialWebRtcCodec, sessionFetch, token, settleRead]);

  // A replacement helper/session at the same URL still needs new video readers.
  const videoSessionKey = config
    ? JSON.stringify([config.url, config.device, config.pid, config.execToken])
    : null;
  const videoFetch = useMemo(
    () =>
      videoSessionKey
        ? (...args: Parameters<typeof sessionFetch>) => sessionFetch(...args)
        : sessionFetch,
    [sessionFetch, videoSessionKey],
  );

  const fpsCounterRef = useRef({ frames: 0, startedAt: 0 });
  const onAvccFrame = useCallback((frameDelta = 1) => {
    const now = performance.now();
    const counter = fpsCounterRef.current;
    if (counter.startedAt === 0) counter.startedAt = now;
    counter.frames += frameDelta;
    if (now - counter.startedAt < 1_000) return;
    const next = Math.round((counter.frames * 1_000) / (now - counter.startedAt));
    counter.frames = 0;
    counter.startedAt = now;
    setFps((previous) => (previous === next ? previous : next));
  }, []);

  // The stream this hook attached to the flat video, and its screen session.
  const webRtcAttachedRef = useRef<{
    video: HTMLVideoElement;
    stream: MediaStream;
    session: string | null;
  } | null>(null);
  // @ref LLP 0015#temporary-drops — as on Android, a reconnect keeps the last frame as a poster
  const preserveWebRtcFrame = useCallback(() => {
    const video = videoRef.current;
    const attached = webRtcAttachedRef.current;
    // Another session's frame must never stay on this surface.
    if (
      !video ||
      !video.srcObject ||
      attached?.video !== video ||
      attached.stream !== video.srcObject ||
      attached.session !== screenSessionKeyRef.current
    )
      return;
    if (preserveVideoFrame(video)) video.srcObject = null;
  }, []);

  // ── WebRTC with codec retries, confined to the advertised transport. ──
  const {
    stream: webRtcStream,
    failure: webRtcFailure,
    error: webRtcError,
    retrying: webRtcRetrying,
    markFrameDecoded: markWebRtcFrameDecoded,
    restart: restartWebRtc,
    streamStats: flatStreamStats,
    setStreamStatsEnabled: setFlatStreamStatsEnabled,
  } = useWebRtcStream({
    offerUrl: config ? `${config.url}/webrtc/offer` : "",
    closeUrl: config ? `${config.url}/webrtc/close` : "",
    closeBeaconUrl: config ? withSessionTokenQuery(`${config.url}/webrtc/close`, token) : "",
    statsUrl: config ? `${config.url}/webrtc/stats` : "",
    enabled: active && useWebRtc && !!config && !displayStreaming,
    codec: activeWebRtcCodec,
    iceServers: config?.webRtcIceServers,
    fetchImpl: videoFetch,
    transportLocked: streamTransportLocked,
    raiseH264Level: true,
    onBeforeDisconnect: preserveWebRtcFrame,
  });
  // Statistics come from the stream on screen: the flat stream, or the active
  // display while the consumer streams the displays.
  useEffect(() => {
    setFlatStreamStatsEnabled(streamStatsEnabled && !displayStreaming);
  }, [setFlatStreamStatsEnabled, streamStatsEnabled, displayStreaming]);
  const handledWebRtcFailureRef = useRef<string | null>(null);
  const ladderBackoffRef = useRef(createLadderBackoff());
  useEffect(() => {
    ladderBackoffRef.current = createLadderBackoff();
  }, [config?.url, webRtcCodec]);
  // A locked transport still reports exhaustion while its ladder waits to restart.
  const exhaustedDecision =
    webRtcFailure?.kind === "codec"
      ? webRtcFallbackDecision(webRtcCodec, activeWebRtcCodec, webRtcFailure, streamTransportLocked)
          ?.type
      : undefined;
  const webRtcCodecsExhausted =
    exhaustedDecision === "switch-to-http" || exhaustedDecision === "restart-ladder";

  const setWebRtcCodec = useCallback(
    (codec: DeviceWebRtcCodec) => {
      setInitialWebRtcCodec(codec);
      ladderBackoffRef.current = createLadderBackoff();
      // Selecting an already-active failed codec does not change the stream
      // hook's inputs, so retry its session explicitly.
      if (codec === activeWebRtcCodec && webRtcFailure) restartWebRtc();
    },
    [activeWebRtcCodec, webRtcFailure, restartWebRtc, setInitialWebRtcCodec],
  );

  // While the consumer streams the displays, their streams walk the same codec ladder.
  const [panelWebRtcFailure, setPanelWebRtcFailure] = useState<WebRtcStreamFailure | null>(null);
  const ladderFailure = displayStreaming ? panelWebRtcFailure : webRtcFailure;
  useEffect(() => {
    if (!useWebRtc || !ladderFailure) return;
    if (handledWebRtcFailureRef.current === ladderFailure.sessionId) return;
    handledWebRtcFailureRef.current = ladderFailure.sessionId;
    const decision = webRtcFallbackDecision(
      webRtcCodec,
      activeWebRtcCodec,
      ladderFailure,
      streamTransportLocked,
    );
    const ladderBackoff = ladderBackoffRef.current;
    // Every codec failure counts, so a slow walk cannot look like a settled stream.
    if (streamTransportLocked && decision) ladderBackoff.noteFailure(performance.now());
    if (decision?.type === "retry-codec") setActiveWebRtcCodec(decision.codec);
    if (decision?.type !== "restart-ladder") return;
    const timer = setTimeout(() => {
      setActiveWebRtcCodec(decision.codec);
      restartWebRtc();
    }, ladderBackoff.takeRestartDelayMs());
    return () => clearTimeout(timer);
  }, [
    useWebRtc,
    ladderFailure,
    webRtcCodec,
    activeWebRtcCodec,
    streamTransportLocked,
    restartWebRtc,
  ]);

  useEffect(() => {
    if (!useWebRtc || displayStreaming) return;
    // A transport retry reconnects by itself, so it is not a failure to show.
    if ((webRtcError && !webRtcRetrying) || webRtcCodecsExhausted) {
      setStatus("error");
      setError(webRtcError ?? "No supported WebRTC codec could establish a video stream.");
    } else if (!webRtcStream) {
      setStatus("connecting");
      setError(null);
    }
  }, [
    useWebRtc,
    displayStreaming,
    webRtcError,
    webRtcRetrying,
    webRtcStream,
    webRtcCodecsExhausted,
  ]);

  // @ref LLP 0012#hidden-tabs-and-startup-diagnosis — surface remounts keep the peer
  useEffect(() => {
    if (!useWebRtc) return;
    const video = webRtcVideoElement;
    // A pending negotiation leaves the last frame, or its poster, in place.
    if (!video || !webRtcStream) return;
    let stopped = false;
    let firstFrame = true;
    let frameCallback = 0;
    let previousPresentedFrames: number | null = null;

    const markFrame = (presentedFrameDelta = 1) => {
      if (stopped) return;
      const { videoWidth: width, videoHeight: height } = video;
      if (width > 0 && height > 0 && !hasWsConfigRef.current) {
        setScreen((prev) =>
          prev && prev.orientation === undefined && prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }
      onAvccFrame(presentedFrameDelta);
      markWebRtcFrameDecoded(presentedFrameDelta);
      if (firstFrame) {
        firstFrame = false;
        video.removeAttribute("poster");
        setStatus("streaming");
        setError(null);
      }
    };
    const onVideoFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (stopped) return;
      const presentedFrameDelta = presentedVideoFrameDelta(
        previousPresentedFrames,
        metadata.presentedFrames,
      );
      if (Number.isSafeInteger(metadata.presentedFrames) && metadata.presentedFrames >= 0) {
        previousPresentedFrames = metadata.presentedFrames;
      }
      markFrame(presentedFrameDelta);
      frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    };
    const onTimeUpdate = () => markFrame();
    const onLoadedData = () => markFrame(0);
    const onVisibilityChange = () => {
      if (stopped || document.hidden || videoRef.current !== video || !video.paused) return;
      void video.play().catch(() => {});
    };

    video.srcObject = webRtcStream;
    webRtcAttachedRef.current = {
      video,
      stream: webRtcStream,
      session: screenSessionKeyRef.current,
    };
    const supportsVideoFrameCallback = typeof video.requestVideoFrameCallback === "function";
    if (supportsVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(onVideoFrame);
    else video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("loadeddata", onLoadedData, { once: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    void video.play().catch(() => {});

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("timeupdate", onTimeUpdate);
      if (frameCallback && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameCallback);
      }
    };
  }, [useWebRtc, webRtcStream, webRtcVideoElement, markWebRtcFrameDecoded, onAvccFrame]);

  // Detach the media only when this surface stops showing WebRTC or a new
  // screen session starts on it; a lost stream alone keeps its last frame.
  useEffect(() => {
    if (!useWebRtc) return;
    const video = webRtcVideoElement;
    if (!video) return;
    return () => {
      video.removeAttribute("poster");
      video.srcObject = null;
    };
  }, [useWebRtc, webRtcVideoElement, screenSessionKey]);

  // ── H.264 AVCC (WebCodecs) with serve-sim's MJPEG fallback policy. ──
  // The fallback is about this browser and this device's stream, so a
  // replacement helper for the same device (a new pid) keeps it, as does the
  // gap while that helper starts.
  const avccFallbackScope = knownConfig
    ? JSON.stringify([knownConfig.url, knownConfig.device])
    : null;
  useEffect(() => {
    dispatchAvccFallback("reset");
    setFps(0);
  }, [streamMode, avccFallbackScope, knownConfig?.webRtcCodec]);

  useEffect(() => {
    if (!useAvcc || !config?.url || displayStreaming) return;
    const timer = setTimeout(() => dispatchAvccFallback("timeout"), AVCC_FRAME_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [useAvcc, config?.url, displayStreaming, videoSessionKey]);

  useAvccStream({
    url: config?.url ?? "",
    enabled: active && useAvcc && !!config && !displayStreaming,
    canvasRef,
    fetchImpl: videoFetch,
    // Each read starts a gap until its first frame; the canvas keeps the last one.
    onConnecting: () => setStatus("connecting"),
    onFirstFrame: () => {
      setStatus("streaming");
      setError(null);
    },
    onFrame: onAvccFrame,
    onDecodedFrame: () => dispatchAvccFallback("decoded-frame"),
    onResize: (width, height) => {
      if (!hasWsConfigRef.current) {
        setScreen((prev) =>
          prev && prev.orientation === undefined && prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }
    },
    onError: (message) => {
      setStatus("error");
      setError(message);
    },
    onDecoderError: () => dispatchAvccFallback("error"),
  });

  // ── MJPEG video (<img>) ──
  const streamUrl = useAvcc || useWebRtc || displayStreaming ? null : (config?.streamUrl ?? null);
  // An unmount stops the visible request; a new config for the same screen may keep its frame.
  const unmountedRef = useRef(false);
  useLayoutEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);
  useEffect(() => {
    if (!streamUrl) {
      streamUrlRef.current = null;
      return;
    }
    streamUrlRef.current = streamUrl;
    setStatus("connecting");
    setError(null);

    let cancelled = false;
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // A request that loads off screen while the visible <img> keeps its last
    // frame, and the <img> it is for.
    let probe: HTMLImageElement | null = null;
    let probeTarget: HTMLImageElement | null = null;
    // After a failed request, the frame on screen is old until a new request paints.
    let failed = false;
    // A retry's frame behind the visible <img>, until that <img> paints its own.
    let bridging: { target: HTMLImageElement; sawEmpty: boolean; until: number } | null = null;
    const session = screenSessionKeyRef.current;
    const img = imgRef.current;

    const stopProbe = () => {
      if (!probe) return;
      probe.onload = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      probe = null;
      probeTarget = null;
    };

    const markStreaming = () => {
      // While a probe loads, or after a failure, the visible frame is the old one.
      if (cancelled || settled || probe || failed) return;
      const el = imgRef.current;
      if (!el || el.naturalWidth === 0 || el.naturalHeight === 0) return;
      settled = true;
      setStatus("streaming");
      setError(null);
      if (!hasWsConfigRef.current) {
        setScreen((prev) =>
          prev &&
          prev.orientation === undefined &&
          prev.width === el.naturalWidth &&
          prev.height === el.naturalHeight
            ? prev
            : { width: el.naturalWidth, height: el.naturalHeight },
        );
      }
    };
    const scheduleRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!cancelled) load();
      }, RECONNECT_MS);
    };
    // @ref LLP 0015#temporary-drops — a retry loads off screen, so a failed request never replaces the last frame
    const load = () => {
      const visible = imgRef.current;
      const url = streamUrlRef.current;
      if (!visible || !url) return;
      // An <img> without a frame has nothing to keep; a detached image needs `Image`.
      if (!(visible.complete && visible.naturalWidth > 0) || typeof Image === "undefined") {
        // The new request paints from an empty element, so its frame is new.
        failed = false;
        applyStreamSrc();
        return;
      }
      stopProbe();
      const next = freshStreamSrc(url);
      const candidate = new Image();
      probe = candidate;
      probeTarget = visible;
      candidate.onload = () => handOver(candidate, visible, next);
      candidate.onerror = () => {
        if (cancelled || probe !== candidate) return;
        stopProbe();
        scheduleRetry();
      };
      candidate.src = next;
    };
    // A newly attached <img> got its own request from `attachVideo`, so the
    // retry is moot, and that request's first frame counts as new.
    const dropProbeForNewImage = () => {
      if (!probe || imgRef.current === probeTarget) return false;
      stopProbe();
      failed = false;
      return true;
    };
    const handOver = (candidate: HTMLImageElement, visible: HTMLImageElement, next: string) => {
      if (cancelled || probe !== candidate || candidate.naturalWidth === 0) return;
      if (dropProbeForNewImage()) return;
      // The browser clears the visible <img> until its new request paints; the
      // retry's frame stays behind it meanwhile.
      bridgeMjpegFrame(visible, candidate);
      bridging = { target: visible, sawEmpty: false, until: Date.now() + 5_000 };
      stopProbe();
      failed = false;
      visible.src = next;
      // The retry painted, so the stream is back.
      settled = true;
      setStatus("streaming");
      setError(null);
    };
    // The <img> retries by itself, so a failed request is a gap, not an error.
    const onError = () => {
      if (cancelled) return;
      settled = false;
      failed = true;
      setStatus("connecting");
      setError(null);
      scheduleRetry();
    };
    img?.addEventListener("load", markStreaming);
    img?.addEventListener("error", onError);
    load();
    // A multipart stream need not fire `load` per frame, so poll both elements.
    const poll = setInterval(() => {
      dropProbeForNewImage();
      const candidate = probe;
      if (candidate && probeTarget) handOver(candidate, probeTarget, candidate.src);
      if (bridging) {
        const { target } = bridging;
        if (target.naturalWidth === 0) bridging.sawEmpty = true;
        else if (bridging.sawEmpty || Date.now() > bridging.until) {
          clearMjpegBridge(target);
          bridging = null;
        }
      }
      markStreaming();
    }, 400);

    return () => {
      cancelled = true;
      clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      stopProbe();
      img?.removeEventListener("load", markStreaming);
      img?.removeEventListener("error", onError);
      clearMjpegBridge(bridging?.target ?? null);
      // A helper restart for the same screen keeps the last frame. Another
      // screen session, or an unmount, stops the multipart request on the
      // element this effect started: a consumer that streams the displays may
      // have unmounted the flat <img> already, which nulls the ref.
      const keepFrame =
        !unmountedRef.current && screenSessionKeyRef.current === session && imgRef.current === img;
      if (!keepFrame) {
        img?.removeAttribute("src");
        imgRef.current?.removeAttribute("src");
      }
      // The helper's pushed config outlives a transport switch.
      if (!hasWsConfigRef.current) setScreen(null);
      setFps(0);
    };
  }, [streamUrl, videoSessionKey, applyStreamSrc]);

  // ── Helper control WebSocket (touch/buttons out, screen config in) ──
  const wsUrl = config?.wsUrl ?? null;
  const requireInputAdmission = config?.inputAdmission ?? false;
  const controlDevice = config?.device ?? null;
  useEffect(() => {
    rotationCursorRef.current = createRotationCursor(screenRef.current?.orientation ?? "portrait");
  }, [wsUrl, controlDevice, videoSessionKey]);
  // A replacement helper cannot restore lost input, so its notice outlives the socket.
  // A helper can report a null config while it restarts; that gap keeps the notice.
  const lostInputTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputOwnerRef = useRef<{ scope: string | null; helper: string | null } | null>(null);
  useEffect(() => {
    const previous = inputOwnerRef.current;
    const sameScope = previous !== null && previous.scope === connectionScope;
    const helper = wsUrl
      ? JSON.stringify([controlDevice, wsUrl])
      : sameScope
        ? previous.helper
        : null;
    if (previous !== null && (!sameScope || previous.helper !== helper)) {
      clearTimeout(lostInputTimerRef.current);
      lostInputTimerRef.current = undefined;
      setInputSocketError(null);
    }
    inputOwnerRef.current = { scope: connectionScope, helper };
  }, [connectionScope, wsUrl, controlDevice]);
  useEffect(() => () => clearTimeout(lostInputTimerRef.current), []);
  useEffect(() => {
    hardwareKeyboardIntentRef.current = { pending: false };
    setHardwareKeyboardConnectedState(null);
    setInputSocketError((current) => (lostInputTimerRef.current === undefined ? null : current));
    setInputUnavailable(false);
    // A new helper, or none, owns the screen config from here. The media
    // paths fill the size back in until its first push arrives, so a previous
    // simulator's hinge state never classifies the next one.
    hasWsConfigRef.current = false;
    setScreen(null);
    if (!wsUrl) return;
    hasWsConfigRef.current = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingOwner = pendingInputRef.current;
    const initialMessages = pendingOwner.messages;
    pendingOwner.messages = [];
    // @ref LLP 0013#ios-input-adapter — refusals clear only on admission; rediscovery waits for the reconnect
    const input = createInputSocket(
      wsUrl,
      {
        onAdmitted() {
          // Keep main's software-character path active for browser-layout typing.
          if (!input.trySend(WS_MSG_HARDWARE_KEYBOARD, { enabled: false })) return false;
          hardwareKeyboardIntentRef.current = { pending: false };
          setHardwareKeyboardConnectedState(false);
        },
        onMessage(data) {
          if (!(data instanceof ArrayBuffer) || keyboard.receive(data)) return false;
          const bytes = new Uint8Array(data);
          if (bytes[0] === WS_TAG_HINGE_REPLY) {
            try {
              const reply = JSON.parse(
                decoder.decode(bytes.subarray(1)),
              ) as AcknowledgedControlReply;
              if (reply && typeof reply.requestId === "number" && typeof reply.ok === "boolean") {
                hingeQueueRef.current?.receive(reply);
              }
            } catch {}
            return false;
          }
          if (bytes[0] !== WS_MSG_CONFIG) return false;
          try {
            const c = JSON.parse(decoder.decode(bytes.subarray(1))) as SimScreenConfig & {
              inputUnavailable?: boolean;
            };
            if (
              typeof c.width !== "number" ||
              typeof c.height !== "number" ||
              !Number.isFinite(c.width) ||
              !Number.isFinite(c.height) ||
              c.width <= 0 ||
              c.height <= 0 ||
              (c.inputUnavailable !== undefined && typeof c.inputUnavailable !== "boolean")
            )
              return false;
            rotationCursorRef.current.updateReadback(c.orientation);
            setInputUnavailable(c.inputUnavailable === true);
            hasWsConfigRef.current = true;
            // A rotation clears the native named pose. Observe the received
            // config even when its values equal the previous React state.
            if (c.hingePose === null && !hingePendingRef.current) setOrientationOverride(false);
            setScreen((prev) => (screenConfigsEqual(prev, c) ? prev : c));
            return true;
          } catch {
            return false;
          }
        },
        onDisconnect() {
          keyboard.cancelRequests();
          hardwareKeyboardIntentRef.current = { pending: false };
          setHardwareKeyboardConnectedState(null);
          setPhysicalPose(undefined);
          sentHingePoseRef.current = undefined;
          setOrientationOverride(false);
          if (hingePendingRef.current) {
            const message = "Connection lost while changing the device pose.";
            hingeQueueRef.current?.clear();
            setHingePreview(null);
            setHingeError(message);
            emitHingeEvent({ type: "failed", error: message });
          }
          // Normally exec-ws pushes replacement config by the reconnect. HTTP discovery
          // recovers rotated credentials or a proxy that cannot upgrade WebSockets.
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(() => {
            if (!configUpdatesReadyRef.current) refreshConfigRef.current?.();
          }, RECONNECT_MS);
        },
        onRefused(reason) {
          clearTimeout(lostInputTimerRef.current);
          lostInputTimerRef.current = undefined;
          setInputSocketError(reason);
          // Admission cannot undo commands already lost to a queue overflow.
          if (reason !== WS_REASON_INPUT_UNAVAILABLE) {
            lostInputTimerRef.current = setTimeout(() => {
              lostInputTimerRef.current = undefined;
              setInputSocketError((current) => (current === reason ? null : current));
            }, 5_000);
          }
        },
        onRecovered() {
          setInputSocketError(null);
        },
      },
      {
        initialMessages,
        requireAdmission: requireInputAdmission,
        reconnectDelayMs: RECONNECT_MS,
        openSocket: (address) => new WebSocket(address, socketProtocols),
      },
    );
    inputSocketRef.current = input;
    input.start();
    return () => {
      clearTimeout(refreshTimer);
      let messages = input.takePending();
      keyboard.cancelRequests();
      input.dispose();
      if (pendingInputRef.current === pendingOwner) {
        for (const message of pendingOwner.messages) messages = enqueueWsMessage(messages, message);
        pendingOwner.messages = messages;
      }
      if (inputSocketRef.current === input) inputSocketRef.current = null;
      hingeQueueRef.current?.clear();
      setHardwareKeyboardConnectedState(null);
    };
  }, [
    wsUrl,
    requireInputAdmission,
    controlDevice,
    socketProtocols,
    videoSessionKey,
    keyboard,
    emitHingeEvent,
  ]);

  // ── iPhone Duo: pose bookkeeping and the displays' own streams ──
  // The hinge queue belongs to one input socket. Every change that replaces
  // that socket also changes this key: the helper and its process, the socket
  // URL, and its admission. A changed token or device first drops the config.
  const hingeSessionKey = config
    ? JSON.stringify([videoSessionKey, config.wsUrl, config.inputAdmission])
    : null;
  const hingeSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = hingeSessionRef.current;
    hingeSessionRef.current = hingeSessionKey;
    // A config refresh for the same session, or a strict-mode rerun, keeps
    // the pending commands.
    if (previous === hingeSessionKey) return;
    setHingePending(false);
    setHingeError(null);
    setHingePreview(null);
    setPhysicalPose(undefined);
    sentHingePoseRef.current = undefined;
    setOrientationOverride(false);
    hingeQueueRef.current?.clear();
    // Every command of the old session gets a final event, so no listener
    // waits for a reply or a confirmation that cannot come.
    if (previous !== null) emitHingeEvent({ type: "reset" });
  }, [hingeSessionKey, emitHingeEvent]);

  useEffect(() => {
    if (!hingePreview || hingePending || !screen) return;
    // Configs from earlier commands can arrive while the latest request is
    // queued. Hold the requested pose until both its acknowledgement and its
    // matching config arrive, so rapid preset changes never animate backwards.
    if (
      (hingePreview.hingeAngle === undefined || hingePreview.hingeAngle === screen.hingeAngle) &&
      (hingePreview.hingePose === undefined || hingePreview.hingePose === screen.hingePose) &&
      (hingePreview.tableMode === undefined || hingePreview.tableMode === screen.tableMode)
    ) {
      setHingePreview(null);
      emitHingeEvent({ type: "confirmed" });
    }
  }, [hingePreview, hingePending, screen, emitHingeEvent]);

  useEffect(() => {
    // Also learn poses applied outside this browser. An older queued reply
    // must not replace the orientation chosen by the latest local request.
    // Rotate clears the known native physical pose. Ignore an older
    // preset acknowledgement until native reports that its pose was cleared.
    if (orientationOverride || hingePreview || hingePending) return;
    if (screen?.hingePose) {
      setPhysicalPose(screen.hingePose);
      sentHingePoseRef.current = screen.hingePose;
    } else if (duoPhysicalPoseChanged(physicalPose, screen?.physicalOrientation)) {
      // Another client turned the device over without a preset.
      setPhysicalPose(null);
      sentHingePoseRef.current = null;
    }
  }, [
    orientationOverride,
    hingePreview,
    hingePending,
    screen?.hingePose,
    screen?.physicalOrientation,
    physicalPose,
  ]);

  const videoKind = useWebRtc ? "video" : useAvcc ? "canvas" : "img";
  // A new kind re-registers the consumer's elements through new ref callbacks,
  // as the flat `attachVideo` does.
  const attachCover = useCallback(
    (element: DuoPanelElement["element"] | null) =>
      setPanelElements((previous) => ({
        ...previous,
        1: element ? { kind: videoKind, element } : null,
      })),
    [videoKind],
  );
  const attachInner = useCallback(
    (element: DuoPanelElement["element"] | null) =>
      setPanelElements((previous) => ({
        ...previous,
        3: element ? { kind: videoKind, element } : null,
      })),
    [videoKind],
  );
  const displays = useMemo<readonly DeviceDisplay[] | null>(
    () =>
      isDuo
        ? [
            { id: "cover", active: activeScreenId === 1, attachVideo: attachCover },
            { id: "inner", active: activeScreenId === 3, attachVideo: attachInner },
          ]
        : null,
    [isDuo, activeScreenId, attachCover, attachInner],
  );

  const onPanelAvccError = useCallback(() => dispatchAvccFallback("error"), []);
  const panelFeeds = useMemo<DuoPanelFeeds | null>(() => {
    if (!displayStreaming || !active || !config) return null;
    return {
      url: config.url,
      token,
      session: videoSessionKey,
      mode: useWebRtc ? "webrtc" : useAvcc ? "avcc" : "mjpeg",
      codec: activeWebRtcCodec,
      iceServers: config.webRtcIceServers,
      transportLocked: streamTransportLocked,
      statsEnabled: streamStatsEnabled,
      onFrame: onAvccFrame,
      onAvccError: onPanelAvccError,
      onWebRtcFailure: setPanelWebRtcFailure,
    };
  }, [
    displayStreaming,
    active,
    config,
    token,
    videoSessionKey,
    useWebRtc,
    useAvcc,
    activeWebRtcCodec,
    streamTransportLocked,
    onAvccFrame,
    onPanelAvccError,
    streamStatsEnabled,
  ]);
  const {
    streaming: panelStreaming,
    error: panelError,
    stats: panelStats,
  } = useDuoPanelStreams(panelFeeds, panelElements, activeScreenId);
  // While the consumer streams the displays, the active display's health is the connection status.
  useEffect(() => {
    if (!displayStreaming) return;
    if (panelError) {
      setStatus("error");
      setError(panelError);
    } else {
      setStatus(panelStreaming ? "streaming" : "connecting");
      setError(null);
    }
  }, [displayStreaming, panelError, panelStreaming]);
  useEffect(() => {
    if (!displayStreaming) return;
    return () => {
      setStatus("connecting");
      setError(null);
      setFps(0);
    };
  }, [displayStreaming]);

  // Like serve-sim, fold controls show once the helper reports hinge support or an angle.
  const hingeReported = viewScreen?.supportsHingeAngle ?? viewScreen?.hingeAngle !== undefined;
  const foldCapabilities = useMemo<DeviceFoldCapabilities>(
    () =>
      isDuo && hingeReported
        ? {
            angle: DUO_FOLD_ANGLE,
            poses: DUO_FOLD_POSES,
            tableMode: true,
            faceDown: viewScreen?.supportsPhysicalOrientation === true,
          }
        : false,
    [isDuo, hingeReported, viewScreen?.supportsPhysicalOrientation],
  );
  const fold = useMemo<DeviceFold | null>(() => {
    if (!isDuo) return null;
    const state: DeviceFold = {
      angle: previewHingeAngle,
      pose: previewHingePose,
      pending: hingePending,
      error: hingeError,
      setControl: setHingeControl,
      observe: observeHinge,
    };
    // @ref LLP 0016#fold-state-and-commands — the groups come with the capability that reports them
    if (!foldCapabilities) return state;
    return {
      ...state,
      tableMode: {
        enabled: hingePreview?.tableMode ?? viewScreen?.tableMode,
        available: viewScreen?.tableModeAvailable,
      },
      physical: { pose: physicalPose, faceDown: knownFaceDown ? previewFaceDown : undefined },
    };
  }, [
    isDuo,
    foldCapabilities,
    physicalPose,
    previewHingePose,
    previewHingeAngle,
    hingePreview?.tableMode,
    viewScreen?.tableMode,
    viewScreen?.tableModeAvailable,
    previewFaceDown,
    knownFaceDown,
    hingePending,
    hingeError,
    setHingeControl,
    observeHinge,
  ]);

  // ── Long-lived middleware SSE routes multiplexed over one authenticated
  //    exec-ws, matching serve-sim's browser client. Keeping logs, events, and
  //    metrics off separate HTTP streams avoids the per-origin connection cap. ──
  const execWsUrl = connection?.middleware.execWsUrl ?? null;
  const execToken = connection?.middleware.execToken ?? null;
  const configEventsPath = connection?.middleware.configEventsPath ?? null;
  const logsPath = config?.logsPath ?? null;
  const eventsPath = config?.eventsPath ?? null;
  const metricsPath = config?.metricsPath ?? null;
  const deviceUdid = config?.device ?? null;
  const axUrl = config?.axUrl ?? null;

  const accessibilityLoader = useMemo<AccessibilityLoader | null>(
    () => (axUrl ? (signal) => loadIosAccessibility(axUrl, signal, sessionFetch) : null),
    [axUrl, sessionFetch],
  );
  const accessibilityState = useAccessibility(accessibilityLoader);

  // One-shot typed host actions (`location.*`, `app.*`) over the exec channel.
  const runAction = useMemo(
    () =>
      execWsUrl && execToken
        ? (action: string, params?: Parameters<typeof runHostAction>[3]) =>
            runHostAction(
              execWsUrl,
              execToken,
              action,
              params,
              socketProtocols,
              controlSocket ?? undefined,
            )
        : null,
    [execWsUrl, execToken, socketProtocols, controlSocket],
  );

  const locationBackend = useMemo<DeviceLocationBackend | null>(() => {
    if (!runAction || !deviceUdid) return null;
    return {
      set: (fix) => setIosLocation(runAction, deviceUdid, fix),
      clear: () => clearIosLocation(runAction, deviceUdid),
    };
  }, [runAction, deviceUdid]);
  const {
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    locationCapabilities,
  } = useDeviceLocation(locationBackend);

  // serve-sim exposes permissions over its CLI channel only, so the Hub has no
  // route to read them. The section stays hidden until serve-sim serves them.
  const appPermissions = useAppPermissions({ active, appId: null, backend: null });

  useEffect(() => {
    setEventLogState(createIosEventLogState());
  }, [eventsPath, deviceUdid]);

  useEffect(() => {
    activityLastSampleAtRef.current = 0;
    if (!metricsPath) {
      setActivity(null);
      return;
    }
    setActivity({ hostCores: null, samples: [], errored: false, stale: false });
    const watchdog = setInterval(() => {
      const lastSampleAt = activityLastSampleAtRef.current;
      if (lastSampleAt > 0 && Date.now() - lastSampleAt > ACTIVITY_STALE_MS) {
        setActivity((current) =>
          current && !current.stale ? { ...current, stale: true } : current,
        );
      }
    }, 1000);
    return () => clearInterval(watchdog);
  }, [metricsPath, activityScope]);

  const emitControlEvent = useCallback(
    (kind: "logs" | "events" | "metrics", block: ParsedSseBlock) => {
      if (kind === "logs") {
        let message = block.data;
        try {
          const parsed = JSON.parse(block.data) as { eventMessage?: string };
          if (typeof parsed.eventMessage === "string") message = parsed.eventMessage;
        } catch {}
        if (message) {
          setLogs((previous) =>
            [...previous, { id: `i${++logSeqRef.current}`, source: "syslog", message }].slice(
              -MAX_LOGS,
            ),
          );
        }
        return;
      }
      if (kind === "events" && deviceUdid) {
        setEventLogState((current) => mergeIosEventLogPayload(current, block.data, deviceUdid));
        return;
      }
      if (kind !== "metrics") return;
      try {
        const payload = JSON.parse(block.data) as unknown;
        if (block.event === "meta") {
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
          const hostCores = parseActivityHostCores(payload);
          setActivityStatus("ready");
          setActivity((current) =>
            current && (current.hostCores !== hostCores || current.errored)
              ? { ...current, hostCores, errored: false }
              : current,
          );
          return;
        }
        const sample = parseActivitySample(payload);
        if (!sample) return;
        setActivityStatus("ready");
        activityLastSampleAtRef.current = Date.now();
        setActivity((current) =>
          appendActivitySample(
            current ?? { hostCores: null, samples: [], errored: false, stale: false },
            sample,
          ),
        );
      } catch {}
    },
    [deviceUdid, setActivityStatus],
  );

  const subscribeControl = useCallback(
    (kind: "logs" | "events" | "metrics", path: string) => {
      if (!controlSocket) return;
      let buffer = "";
      if (kind === "metrics") setActivityStatus("loading");
      return controlSocket.subscribe(
        path,
        (chunk) => {
          buffer = drainSseChunk(buffer, chunk, (block) => emitControlEvent(kind, block));
        },
        () => {
          buffer = "";
          if (kind !== "metrics") return;
          setActivityStatus("error");
          setActivity((current) =>
            current && !current.errored ? { ...current, errored: true } : current,
          );
        },
      );
    },
    [controlSocket, emitControlEvent, setActivityStatus],
  );
  useEffect(() => {
    if (logsEnabled && logsPath) return subscribeControl("logs", logsPath);
  }, [logsEnabled, logsPath, subscribeControl]);
  useEffect(() => {
    if (eventsEnabled && eventsPath && deviceUdid) return subscribeControl("events", eventsPath);
  }, [eventsEnabled, eventsPath, deviceUdid, subscribeControl]);
  useEffect(() => {
    if (metricsPath) return subscribeControl("metrics", metricsPath);
  }, [metricsPath, subscribeControl]);
  useEffect(() => {
    if (!controlSocket || !configEventsPath) return;
    let buffer = "";
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = controlSocket.subscribe(
      configEventsPath,
      (chunk) => {
        buffer = drainSseChunk(buffer, chunk, (block) => {
          try {
            applyPreviewConfigRef.current?.(JSON.parse(block.data) as PreviewApi | null);
            configUpdatesReadyRef.current = true;
          } catch {}
        });
      },
      () => {
        buffer = "";
        configUpdatesReadyRef.current = false;
        // HTTP discovery covers rotated credentials until the subscription recovers.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => refreshConfigRef.current?.(), RECONNECT_MS);
      },
    );
    return () => {
      clearTimeout(refreshTimer);
      configUpdatesReadyRef.current = false;
      unsubscribe();
    };
  }, [controlSocket, configEventsPath]);

  // Bulk reads hydrate the controls and track changes made inside the simulator.
  // Wait between completed reads; hidden tabs and interrupted control sockets pause polling.
  // TODO: Replace per-client polling with server-pushed settings changes over WebSocket.
  useEffect(() => {
    const tracker = deviceSettingWriteTrackerRef.current;
    tracker.reset();
    deviceSettingVersionsRef.current.clear();
    setDeviceSettingsPending(new Set());
    resetRead();
    setAppearanceState(null);
    setDeviceSettings(null);
    if (!execWsUrl || !execToken || !deviceUdid) {
      if (deviceUdid) settleRead("error");
      return;
    }
    let cancelled = false;
    let interrupted = false;
    let reading = false;
    let revision = 0;
    let refreshQueued = false;
    let retryDelay = RECONNECT_MS;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const pageDocument = typeof document === "undefined" ? null : document;
    const isHidden = () => pageDocument?.hidden === true;
    const clearTimer = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
    };
    const scheduleRefresh = (delay: number) => {
      clearTimer();
      if (cancelled || interrupted || isHidden()) return;
      refreshTimer = setTimeout(() => void refresh(), delay);
    };
    const invalidate = () => {
      interrupted = true;
      revision++;
      refreshQueued = false;
      clearTimer();
    };
    const refresh = async () => {
      if (cancelled || interrupted || isHidden()) return;
      const readRevision = ++revision;
      if (reading) {
        refreshQueued = true;
        return;
      }
      refreshQueued = false;
      clearTimer();
      reading = true;
      const versions = new Map(deviceSettingVersionsRef.current);
      const pendingAtStart = tracker.pending;
      const keyboardIntent = hardwareKeyboardIntentRef.current;
      try {
        const res = await requestHostUi(execWsUrl, execToken, { device: deviceUdid });
        // A response from before an interruption cannot restore availability.
        if (cancelled || readRevision !== revision) return;
        if (!res.status || typeof res.status !== "object" || Array.isArray(res.status)) {
          throw new Error("Simulator settings request returned an invalid status");
        }
        const next: DeviceSettings = {};
        for (const [key, value] of Object.entries(res.status)) {
          if (typeof value === "string") next[key as DeviceSettingKey] = value;
        }
        const pending = tracker.pending;
        const canApply = (key: DeviceSettingKey) =>
          !pendingAtStart.has(key) &&
          !pending.has(key) &&
          deviceSettingVersionsRef.current.get(key) === versions.get(key);
        setDeviceSettings((current) => {
          let merged = current ?? {};
          for (const key of new Set([...Object.keys(merged), ...Object.keys(next)])) {
            const setting = key as DeviceSettingKey;
            if (!canApply(setting) || merged[setting] === next[setting]) continue;
            if (merged === current) merged = { ...merged };
            if (next[setting] === undefined) delete merged[setting];
            else merged[setting] = next[setting];
          }
          return merged;
        });
        settleRead("ready");
        if (canApply("appearance") && (next.appearance === "light" || next.appearance === "dark")) {
          setAppearanceState(next.appearance);
        }
        // The setting is shared. Reconcile readback unless a newer intent or pending write owns it.
        const keyboardValue = res.status?.[UI_OPTION_HARDWARE_KEYBOARD];
        if (
          hardwareKeyboardIntentRef.current === keyboardIntent &&
          !keyboardIntent.pending &&
          (keyboardValue === "on" || keyboardValue === "off")
        ) {
          setHardwareKeyboardConnectedState(keyboardValue === "on");
        }
        retryDelay = RECONNECT_MS;
        scheduleRefresh(DEVICE_SETTINGS_POLL_MS);
      } catch {
        if (!cancelled && readRevision === revision) {
          settleRead("error");
          scheduleRefresh(retryDelay);
          retryDelay = Math.min(retryDelay * 2, DEVICE_SETTINGS_RETRY_MAX_MS);
        }
      } finally {
        reading = false;
        // Coalesce reconnects during a read into one fresh follow-up request.
        if (!cancelled && refreshQueued) void refresh();
      }
    };
    const onVisibilityChange = () => {
      if (isHidden()) {
        refreshQueued = false;
        clearTimer();
      } else {
        retryDelay = RECONNECT_MS;
        void refresh();
      }
    };
    const resume = () => {
      if (!interrupted) return;
      interrupted = false;
      retryDelay = RECONNECT_MS;
      void refresh();
    };
    pageDocument?.addEventListener("visibilitychange", onVisibilityChange);
    // Pause reads while the shared control channel is down and read again once
    // it authenticates. Stream ends do not interrupt the channel.
    const stopWatchingControl = controlSocket?.onConnectionChange((ready) => {
      if (cancelled) return;
      if (ready) {
        resume();
        return;
      }
      invalidate();
      settleRead("error");
    });
    void refresh();
    return () => {
      cancelled = true;
      clearTimer();
      stopWatchingControl?.();
      pageDocument?.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [execWsUrl, execToken, deviceUdid, controlSocket, requestHostUi, resetRead, settleRead]);

  // ── Runtime encoder settings (serve-sim helper GET/PATCH endpoint) ──
  const streamSettingsUrl = config?.streamSettingsUrl ?? null;
  const initialStreamSettings = config?.initialStreamSettings;
  const normalizedInitialStreamSettings = useMemo(
    () => (streamSettingsUrl ? normalizeDeviceStreamSettings(initialStreamSettings) : null),
    [initialStreamSettings, streamSettingsUrl],
  );
  const { streamSettings, streamSettingsPending, updateStreamSettings } = useStreamSettingsResource(
    {
      url: streamSettingsUrl,
      initialSettings: normalizedInitialStreamSettings,
      parse: parseIosStreamSettings,
      toPatch: iosStreamSettingsPatch,
      fetchImpl: sessionFetch,
    },
  );

  // ── Foreground app (middleware /appstate SSE) — the middleware bootstraps a
  //    fresh subscriber with the current frontmost app, then pushes changes as
  //    SpringBoard foregrounds apps. EventSource reconnects on its own. ──
  const appStateUrl = config?.appStateUrl ?? null;
  useEffect(() => {
    setForegroundApp(null);
    if (!appStateUrl) return;
    let source: EventSource | null = null;
    try {
      source = new EventSource(appStateUrl);
    } catch {
      return;
    }
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as {
          bundleId?: string;
          pid?: number;
          isReactNative?: boolean;
        };
        if (data.bundleId) {
          // Merge repeat events for the same app so a relaunch (new pid)
          // doesn't wipe the bundle details filled in below.
          setForegroundApp((prev) =>
            prev && prev.id === data.bundleId
              ? prev.pid === data.pid && prev.isReactNative === data.isReactNative
                ? prev
                : { ...prev, pid: data.pid, isReactNative: data.isReactNative }
              : { id: data.bundleId!, pid: data.pid, isReactNative: data.isReactNative },
          );
        }
      } catch {}
    };
    return () => source?.close();
  }, [appStateUrl]);

  // ── Foreground app details (name, versions, icon) — introspected from the
  //    app bundle on the host over exec-ws whenever the foreground bundle id
  //    changes. Cached per udid:bundleId, so revisits apply instantly. A server
  //    with the icon route serves the icon over plain HTTP instead, fetched
  //    again on every foreground change. ──
  const foregroundAppId = foregroundApp?.id ?? null;
  const appIconUrl = config?.appIconUrl ?? null;
  useEffect(() => {
    if (!foregroundAppId || !runAction || !deviceUdid) return;
    let cancelled = false;
    getIosAppDetails(runAction, deviceUdid, foregroundAppId, { includeIcon: !appIconUrl })
      .then((details) => {
        if (cancelled || !details) return;
        setForegroundApp((prev) =>
          prev && prev.id === foregroundAppId ? { ...prev, ...details } : prev,
        );
      })
      .catch(() => {
        /* exec channel unavailable — the id/pid line still renders */
      });
    return () => {
      cancelled = true;
    };
  }, [foregroundAppId, runAction, deviceUdid, appIconUrl]);

  useEffect(() => {
    if (!foregroundAppId || !appIconUrl) return;
    const controller = new AbortController();
    fetchIosAppIcon(appIconUrl, foregroundAppId, {
      fetchImpl: sessionFetch,
      signal: controller.signal,
    })
      .then((iconDataUrl) => {
        if (controller.signal.aborted || !iconDataUrl) return;
        setForegroundApp((prev) =>
          prev && prev.id === foregroundAppId ? { ...prev, iconDataUrl } : prev,
        );
      })
      .catch(() => {
        /* route unavailable or app not installed — the placeholder still renders */
      });
    return () => controller.abort();
  }, [foregroundAppId, appIconUrl, sessionFetch]);

  // ── Running simulators (middleware /grid/api) ──
  const gridApiUrl = config?.gridApiUrl ?? null;
  useEffect(() => {
    if (!gridApiUrl) {
      setDevices(PLACEHOLDER_DEVICES);
      return;
    }
    let cancelled = false;
    sessionFetch(gridApiUrl, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json())
      .then((data: { devices?: Array<Record<string, unknown>> }) => {
        if (cancelled || !Array.isArray(data.devices) || data.devices.length === 0) return;
        setDevices(
          data.devices.map((d) => ({
            id: String(d.device ?? d.id ?? "ios"),
            name: String(d.name ?? d.device ?? "Simulator"),
            system: typeof d.runtime === "string" ? d.runtime : undefined,
            platform: "ios" as const,
            current: d.helper != null,
          })),
        );
      })
      .catch(() => {
        /* unreachable — keep the placeholder */
      });
    return () => {
      cancelled = true;
    };
  }, [gridApiUrl, sessionFetch]);

  const deviceSettingsAvailable = !!execWsUrl && !!execToken && !!deviceUdid;
  const activityAvailable = !!metricsPath;
  const eventsAvailable = !!eventsPath;
  const accessibilityAvailable = accessibilityLoader !== null;
  const streamSettingsAvailable = !!streamSettingsUrl;
  const clipboardPaste = config?.inputPaste ?? false;
  const clipboardCopy = config?.inputCopy ?? false;
  const capabilities = useMemo<DeviceCapabilities>(
    () => ({
      deviceSettings: deviceSettingsAvailable,
      activity: activityAvailable,
      events: eventsAvailable,
      camera: false,
      accessibility: accessibilityAvailable,
      streamSettings: streamSettingsAvailable ? IOS_STREAM_SETTING_CAPABILITIES : false,
      location: locationCapabilities,
      permissions: false,
      clipboard:
        clipboardPaste || clipboardCopy ? { paste: clipboardPaste, copy: clipboardCopy } : false,
      fold: foldCapabilities,
    }),
    [
      deviceSettingsAvailable,
      activityAvailable,
      eventsAvailable,
      accessibilityAvailable,
      streamSettingsAvailable,
      locationCapabilities,
      clipboardPaste,
      clipboardCopy,
      foldCapabilities,
    ],
  );

  // iOS reconnects until a real error, so a loaded screen gets the first load's limit too.
  const presentation = useScreenPresentation(screenSessionKey, status, error, {
    dropTimeoutMs: SCREEN_LOAD_TIMEOUT_MS,
  });

  return {
    platform: "ios",
    status: presentation.status,
    error: presentation.error,
    framePresented: presentation.framePresented,
    inputError: inputUnavailable ? IOS_INPUT_UNAVAILABLE_MESSAGE : inputSocketError,
    screen: publicScreen,
    fold,
    displays,
    deviceModelUrl: isDuo ? (knownConfig?.deviceKitModelUrl ?? null) : null,
    displayCorners,
    fps,
    devices,
    logs,
    logsEnabled,
    attachLogs,
    detachLogs,
    clearLogs,
    events,
    eventsEnabled,
    attachEvents,
    detachEvents,
    clearEvents,
    activity,
    activityStatus:
      !active || (config && !metricsPath)
        ? "idle"
        : (!config && activityDiscoveryError === connectionScope) ||
            (metricsPath && (!execWsUrl || !execToken))
          ? "error"
          : activityStatus,
    deviceSettings,
    deviceSettingsStatus,
    deviceSettingsPending,
    setDeviceSetting,
    displayWidthDp: null,
    camera: null,
    cameraPending: NO_PENDING_CAMERA_WRITES,
    cameraError: null,
    setCameraImage: noop,
    clearCameraImage: noop,
    ...accessibilityState,
    location,
    locationPending,
    locationError,
    setLocation,
    clearLocation,
    ...appPermissions,
    pasteText,
    copyText,
    clipboardActionId: clipboardState.actionId,
    clipboardAction: clipboardState.action,
    clipboardPending: clipboardState.pending,
    clipboardError: clipboardState.error,
    clipboardWarning: clipboardState.warning,
    streamCapabilities,
    screenRecording: null,
    streamSettings,
    streamSettingsPending,
    updateStreamSettings,
    streamSource: null,
    streamSourcePending: false,
    streamSourceError: null,
    setStreamSource: noop,
    setGrpcImageMode: noop,
    setGrpcEncoder: noop,
    setGrpcInputSource: noop,
    streamStats: displayStreaming && useWebRtc ? panelStats : flatStreamStats,
    setStreamStatsEnabled,
    webRtcCodec,
    setWebRtcCodec,
    capabilities,
    foregroundApp,
    videoKind,
    attachVideo,
    sendTouch,
    sendMultiTouch,
    cancelInput,
    sendKey,
    sendKeyEvents,
    sendScroll,
    pressButton,
    reload,
    rotate,
    screenshot,
    appearance,
    setAppearance,
    hardwareKeyboardConnected,
    setHardwareKeyboardConnected,
    toggleSoftwareKeyboard,
  };
}
