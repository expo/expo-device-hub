import { createRoot } from "react-dom/client";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  SimulatorView,
  digitalCrownDeltaFromWheel,
  displayStreamConfig,
  fallbackScreenSize,
  screenBorderRadius,
  SimulatorToolbar,
  getDeviceType,
  simulatorAspectRatio,
  simulatorMaxWidth,
  ROTATE_LEFT_CYCLE,
  ROTATE_RIGHT_CYCLE,
  type DeviceType,
  type SimulatorOrientation,
  type StreamConfig,
} from "./simulator";

import { Globe, Maximize2, PanelRight, ScrollText, Upload } from "lucide-react";
import { ReloadIcon } from "./icons";
import { AxDomOverlay } from "./components/ax-dom-overlay";
import { AxStateProvider } from "./components/ax-state-provider";
import { AxToolbarButton } from "./components/ax-toolbar-button";
import { DeviceSidebarToggle } from "./components/device-sidebar-toggle";
import { DevicePlaceholder } from "./components/device-placeholder";
import { DuoModelView } from "./components/duo-model-view";
import { DuoPanelStreams, type DuoPanelPeer } from "./components/duo-panel-streams";
import { useLadderRestart } from "./hooks/use-ladder-restart";
import type { StreamPanelPeer } from "./components/stream-settings-tool";
import { duoIntendedScreen, duoPhysicalPoseChanged } from "./simulator/duo-pose";
import { DUO_FACE_DOWN_HELD, duoFaceDownFraming, duoInitialView, duoPresetView, duoRotateView, type DuoFaceDownFraming, type DuoView } from "./simulator/duo-view";
import { rotationDegreesForOrientation } from "./simulator/orientation";
import { recordDuoHingeCommand, type DuoHingeCommands } from "./simulator/duo-hinge-commands";
import { PresentationControls } from "./components/presentation-controls";
import {
  KeyboardCapture,
  KeyboardToggleButton,
} from "./components/keyboard-capture";
import { DeviceKitChrome, deviceKitChromeForScreen, deviceKitChromeGeometry, deviceKitScreenRadius, type ChromeButtonPress } from "./components/device-chrome-frame";
import { createPacedKeySender } from "./utils/paced-key-sender";
import { GridPanel } from "./components/grid-panel";
import { IconButton } from "./components/icon-button";
import { LogsDrawer } from "./components/logs-drawer";
import { ResizeHandle } from "./components/resize-handle";
import { SimulatorResizeCornerHandle } from "./components/simulator-resize-corner-handle";
import { ServeSimToaster, showInputSocketError } from "./components/app-toasts";
import { ShareSessionButton } from "./components/share-session-button";
import { SimulatorResizeSizeBadge } from "./components/simulator-resize-size-badge";
import { StreamStatusPill } from "./components/stream-status-pill";
import { HingeControls } from "./components/hinge-controls";
import { screenConfigsEqual } from "./simulator/screen-config-state";
import { HINGE_POSES, hingeControlState, type HingeControlCommand, type HingeControlState, type HingePose } from "../hinge-control";
import { createAcknowledgedControlQueue, type AcknowledgedControlReply } from "./utils/acknowledged-control-queue";
import { ToolsPanel } from "./components/tools-panel";
import { WebKitDevtoolsPanel } from "./components/webkit-devtools-panel";
import { useMediaDrop } from "./hooks/use-media-drop";
import { useMjpegStream } from "./hooks/use-mjpeg-stream";
import { useAvccStream } from "./hooks/use-avcc-stream";
import { useWebRtcStream } from "./hooks/use-webrtc-stream";
import { useResizableHeight, useResizableWidth } from "./hooks/use-resizable-width";
import { useScreenshotToast } from "./hooks/use-screenshot-toast";
import { useSimulatorResize } from "./hooks/use-simulator-resize";
import { useFlipLayout } from "./hooks/use-flip-layout";
import { useUploadToasts } from "./hooks/use-upload-toasts";
import { useWebKitDevtools } from "./hooks/use-webkit-devtools";
import { useGridDevices } from "./hooks/use-grid-devices";
import { useStreamSettings } from "./hooks/use-stream-settings";
import type { DeviceKitChromeDescriptor } from "./utils/grid";
import {
  avccFallbackReducer,
  initialAvccFallback,
  AVCC_FRAME_TIMEOUT_MS,
} from "./avcc-fallback";
import { fileExtension } from "./utils/drop";
import { openHostEventStream, runHostAction } from "./utils/exec";
import { hidUsageForCode } from "./utils/hid";
import { keydownForward, shiftedCharacter } from "./utils/mobile-keyboard";
import {
  DEVICE_SIDEBAR_WIDTH,
  DEVTOOLS_PANEL_WIDTH,
  LOGS_DRAWER_HEIGHT,
  PANEL_WIDTH,
} from "./utils/panel-widths";
import { proxyPreviewConfigForBrowser } from "./utils/preview-config";
import { mjpegStreamUrlFrom, simEndpoint, streamConfigFrom, webrtcCloseUrlFrom, webrtcOfferUrlFrom, webrtcStatsUrlFrom } from "./utils/sim-endpoint";
import { startLogsPoll } from "./utils/logs-poll";
import { shouldStreamSimulatorLogs } from "./utils/simulator-logs";
import { useBlockPageZoom } from "./hooks/use-block-page-zoom";
import { useCoarsePointer } from "./hooks/use-coarse-pointer";
import {
  escapeKeyOutcome,
  presentationModeFromSearch,
  writeFullscreenSearchParam,
} from "./utils/presentation";
import {
  getPresentationFrameWidth,
  roundToDevicePixel,
  SIMULATOR_RESIZE_DRAG_TRANSITION,
  SIMULATOR_RESIZE_PAGE_TRANSITION,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION,
  SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS,
  isVisualViewportKeyboardRaised,
  readNativeKeyboardRaised,
  SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
  SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION,
} from "./utils/simulator-resize";
import {
  flushWsMessageQueue,
  sendOrQueueWsMessage,
  trySendWsMessage,
  type QueuedWsMessage,
} from "./utils/ws-send-queue";
import {
  webRtcFallbackDecision,
  type WebRtcCodec,
  type WebRtcStreamFailure,
} from "./webrtc-codec-fallback";

// ─── App ───

// Default CSS-pixel width of the fixed 1:1 Duo stage, independent of either screen.
const DUO_STAGE_DEFAULT_WIDTH = 580;

type PreviewConfig = NonNullable<Window["__SIM_PREVIEW__"]>;

function isLogsShortcut(e: KeyboardEvent): boolean {
  return e.code === "Backquote" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

function previewConfigKey(config: PreviewConfig | null): string {
  return config
    ? `${config.device}:${config.pid}:${config.streamUrl}:${config.wsUrl}:${JSON.stringify(config.streamSettings ?? null)}`
    : "";
}

function App() {
  const [injectedConfig] = useState(() => streamConfigFrom(window.__SIM_PREVIEW__));
  const [config, setConfig] = useState<PreviewConfig | null>(() =>
    proxyPreviewConfigForBrowser(injectedConfig, window.location)
  );
  const [streaming, setStreaming] = useState(false);
  // The device the user wants to view. Selecting a row in the sidebar updates
  // this and re-subscribes the SSE below — the main view swaps streams instantly
  // (or shows a Start placeholder) without a full page reload.
  const [selectedUdid, setSelectedUdid] = useState<string | null>(() => {
    if (injectedConfig) return injectedConfig.device;
    return new URLSearchParams(window.location.search).get("device");
  });
  const [axOverlayEnabled, setAxOverlayEnabled] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [chromeEnabled, setChromeEnabled] = useState(() =>
    typeof window === "undefined" ? true : !window.matchMedia("(pointer: coarse)").matches,
  );
  const [presentationBoot] = useState(() =>
    typeof window === "undefined"
      ? { initial: false, embedLocked: false }
      : presentationModeFromSearch(window.location.search),
  );
  const embedLocked = presentationBoot.embedLocked;
  const [presentation, setPresentation] = useState(presentationBoot.initial);
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const swallowEscapeRef = useRef(false);
  const [chromeGone, setChromeGone] = useState(presentationBoot.initial);
  useEffect(() => {
    if (!presentation) {
      setChromeGone(false);
      return;
    }
    const id = setTimeout(() => setChromeGone(true), SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [presentation]);
  const [logsOpen, setLogsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isLogsShortcut(e)) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setLogsOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Open the sidebar by default when the viewport has room for it beside the
  // simulator; narrow windows keep it collapsed so the device isn't squeezed.
  const [gridOpen, setGridOpen] = useState(() => {
    if (typeof window === "undefined" || presentationBoot.initial) return false;
    return window.innerWidth >= DEVICE_SIDEBAR_WIDTH + 640;
  });
  const { width: gridPanelWidth, onPointerDown: onGridResize } = useResizableWidth(
    "serve-sim:device-sidebar-width",
    DEVICE_SIDEBAR_WIDTH,
    240,
    640,
    "right",
  );
  const [selectedDevtoolsTargetId, setSelectedDevtoolsTargetId] = useState<string | null>(null);

  // Grid device list + boot/shutdown actions, shared by the sidebar and the
  // main placeholder. Endpoints resolve from simEndpoint so this also works in
  // the no-helper empty state (the grid routes are always served).
  const preview = window.__SIM_PREVIEW__;
  const gridCatalogEndpoint = preview?.gridCatalogEndpoint ?? simEndpoint("grid/api/catalog");
  const gridStatusEndpoint = preview?.gridStatusEndpoint ?? simEndpoint("grid/api/status");
  const gridStatusEventsEndpoint = preview?.gridStatusEventsEndpoint ?? simEndpoint("grid/api/status/events");
  const gridStartEndpoint = preview?.gridStartEndpoint ?? simEndpoint("grid/api/start");
  const gridShutdownEndpoint = preview?.gridShutdownEndpoint ?? simEndpoint("grid/api/shutdown");
  const [starting, setStarting] = useState<Record<string, boolean>>({});
  const [shuttingDown, setShuttingDown] = useState<Record<string, boolean>>({});
  const [actionErrors, setActionErrors] = useState<Record<string, string | null>>({});
  const {
    devices: gridDevices,
    total: gridTotal,
    loadMore: loadMoreGrid,
    loadAll: loadAllGrid,
    resetPage: resetGridPage,
    hasMore: gridHasMore,
  } = useGridDevices(
    gridCatalogEndpoint,
    gridStatusEventsEndpoint,
    true,
    selectedUdid,
  );
  // Re-subscribe the stream SSE the instant the selected device gains (or loses)
  // a helper, so its config lands as soon as it boots rather than waiting on the
  // next filesystem-watch tick — the stream appears sooner after boot.
  const selectedHasHelper = !!(
    selectedUdid && gridDevices?.find((d) => d.device === selectedUdid)?.helper
  );

  const selectDevice = useCallback((udid: string) => {
    setSelectedUdid(udid);
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("device", udid);
      window.history.replaceState(null, "", u.toString());
    } catch {}
  }, []);

  const enterPresentation = useCallback(() => {
    setPresentation(true);
    setGridOpen(false);
    if (!embedLocked) writeFullscreenSearchParam(true);
  }, [embedLocked]);

  const exitPresentation = useCallback(() => {
    if (embedLocked) return;
    setPresentation(false);
    writeFullscreenSearchParam(false);
  }, [embedLocked]);

  useEffect(() => {
    if (embedLocked) return;
    const onKey = (e: KeyboardEvent) => {
      // `key`, not `code`: synthetic input often omits `code`.
      if (e.key !== "Escape") return;
      const outcome = escapeKeyOutcome(
        { type: e.type === "keyup" ? "keyup" : "keydown", repeat: e.repeat },
        { presentation: presentationRef.current, swallowing: swallowEscapeRef.current },
      );
      swallowEscapeRef.current = outcome.swallowing;
      if (!outcome.swallow) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (outcome.exit) exitPresentation();
    };
    // A blur mid-press never delivers the keyup.
    const onBlur = () => {
      swallowEscapeRef.current = false;
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [embedLocked, exitPresentation]);

  const waitForHelper = useCallback(
    async (udid: string, timeoutMs = 20_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const endpoint = new URL(gridStatusEndpoint, window.location.href);
          endpoint.searchParams.set("device", udid);
          const res = await fetch(endpoint, { cache: "no-store" });
          const json = await res.json();
          if ((json.statuses ?? []).some((d: any) => d.device === udid && d.helper)) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 400));
      }
      return false;
    },
    [gridStatusEndpoint],
  );

  const startDevice = useCallback(
    async (udid: string) => {
      setStarting((p) => ({ ...p, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridStartEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
          return;
        }
        // The helper registers asynchronously; once it does, the SSE (subscribed
        // to this udid) delivers its config and the main view starts streaming.
        await waitForHelper(udid);
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setStarting((p) => ({ ...p, [udid]: false }));
      }
    },
    [gridStartEndpoint, waitForHelper],
  );

  const shutdownDevice = useCallback(
    async (udid: string) => {
      setShuttingDown((s) => ({ ...s, [udid]: true }));
      setActionErrors((e) => ({ ...e, [udid]: null }));
      try {
        const res = await fetch(gridShutdownEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.ok) {
          setActionErrors((e) => ({ ...e, [udid]: json.error ?? `HTTP ${res.status}` }));
        }
      } catch (err: any) {
        setActionErrors((e) => ({ ...e, [udid]: err?.message ?? "Request failed" }));
      } finally {
        setShuttingDown((s) => ({ ...s, [udid]: false }));
      }
    },
    [gridShutdownEndpoint],
  );

  // Pick a sensible default device once the grid loads and nothing is selected:
  // prefer a live helper, then a booted sim, then the first available.
  useEffect(() => {
    if (selectedUdid) return;
    if (config?.device) {
      setSelectedUdid(config.device);
      return;
    }
    if (!gridDevices || gridDevices.length === 0) return;
    const pick =
      gridDevices.find((d) => d.helper) ??
      gridDevices.find((d) => d.state === "Booted") ??
      gridDevices[0];
    if (pick) setSelectedUdid(pick.device);
  }, [selectedUdid, config?.device, gridDevices]);

  // Subscribe to the selected device's stream config. Re-runs on selection
  // change so switching devices swaps the stream without reloading the page.
  useEffect(() => {
    const eventsUrl = `${simEndpoint("api/events")}${selectedUdid ? `?device=${encodeURIComponent(selectedUdid)}` : ""}`;

    const applyConfig = (next: PreviewConfig | null) => {
      setConfig((prev) => {
        next = proxyPreviewConfigForBrowser(streamConfigFrom(next), window.location);
        if (previewConfigKey(prev) === previewConfigKey(next)) return prev;
        if (next) {
          window.__SIM_PREVIEW__ = next;
        } else if (window.__SIM_PREVIEW__) {
          // Keep the minimal injection: the empty state still routes through
          // simEndpoint (basePath) and authenticates /exec (execToken).
          const { basePath, execToken } = window.__SIM_PREVIEW__;
          window.__SIM_PREVIEW__ = { basePath, execToken } as Window["__SIM_PREVIEW__"];
        }
        return next;
      });
    };

    // Server pushes the serve-sim state only when it actually changes (helper
    // boot/shutdown or device selection), so there's no polling loop here.
    const es = openHostEventStream(eventsUrl);
    es.onmessage = (event) => {
      try {
        applyConfig(streamConfigFrom(JSON.parse(event.data) as Window["__SIM_PREVIEW__"]));
      } catch {}
    };
    return () => es.close();
  }, [selectedUdid, selectedHasHelper]);

  useEffect(() => {
    if (!config?.logsEndpoint || !shouldStreamSimulatorLogs(window.location)) return;

    const procColors = new Map<string, string>();
    const palette = [
      "#8be9fd", "#50fa7b", "#ffb86c", "#ff79c6", "#bd93f9",
      "#f1fa8c", "#6272a4", "#ff5555", "#69ff94", "#d6acff",
      "#ffffa5", "#a4ffff", "#ff6e6e", "#caa9fa", "#5af78e",
    ];
    function colorFor(name: string): string {
      let c = procColors.get(name);
      if (!c) {
        let h = 0;
        for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
        c = palette[Math.abs(h) % palette.length]!;
        procColors.set(name, c);
      }
      return c;
    }

    let lastProc = "";
    let groupOpen = false;
    let since = 0;

    const stop = startLogsPoll(config.logsEndpoint, {
      getSince: () => since,
      setSince: (seq) => {
        since = seq;
      },
      onBatch: (batch) => {
        for (const { fields } of batch) {
          const { process: proc, subsystem, category, message: msg, level } = fields;

          if (proc !== lastProc) {
            if (groupOpen) console.groupEnd();
            const color = colorFor(proc);
            console.groupCollapsed(
              `%c${proc}${subsystem ? ` %c${subsystem}${category ? ":" + category : ""}` : ""}`,
              `color:${color};font-weight:bold`,
              ...(subsystem ? ["color:#888;font-weight:normal"] : []),
            );
            groupOpen = true;
            lastProc = proc;
          }

          const tag = subsystem && proc === lastProc
            ? `%c${category || subsystem}%c `
            : "";
          const tagStyles = tag
            ? ["color:#888;font-style:italic", "color:inherit"]
            : [];

          if (level === "fault" || level === "error") {
            console.log(`${tag}%c${msg}`, ...tagStyles, "color:#ff5555");
          } else if (level === "debug") {
            console.log(`${tag}%c${msg}`, ...tagStyles, "color:#6272a4");
          } else {
            console.log(`${tag}%c${msg}`, ...tagStyles, "color:inherit");
          }
        }
      },
    });

    return () => {
      if (groupOpen) console.groupEnd();
      stop();
    };
  }, [config?.logsEndpoint]);

  // Selection drives the view: stream when the selected device's helper config
  // has arrived, otherwise a placeholder (connecting / boot-and-start).
  const effectiveUdid = selectedUdid ?? config?.device ?? null;
  const selectedDevice = gridDevices?.find((d) => d.device === effectiveUdid) ?? null;
  // The catalog is a fetch behind the inlined config, so until it lands the
  // device would lay out at the bare screen aspect and then reflow into its bezel.
  // Once available, prefer the catalog's complete cover/inner display variants.
  const inlineChrome =
    injectedConfig?.device === effectiveUdid
      ? injectedConfig.chrome ?? null
      : null;
  const isStreaming = !!config && config.device === effectiveUdid;

  let mainView: ReactNode;
  if (isStreaming && config) {
    mainView = (
      <AppWithConfig
        config={config}
        deviceName={selectedDevice?.name ?? null}
        deviceRuntime={selectedDevice?.runtime ?? null}
        chrome={selectedDevice?.chrome ?? inlineChrome}
        axOverlayEnabled={axOverlayEnabled}
        setAxOverlayEnabled={setAxOverlayEnabled}
        devtoolsOpen={devtoolsOpen}
        setDevtoolsOpen={setDevtoolsOpen}
        logsOpen={logsOpen}
        setLogsOpen={setLogsOpen}
        gridOpen={gridOpen}
        setGridOpen={setGridOpen}
        gridPanelWidth={gridPanelWidth}
        selectedDevtoolsTargetId={selectedDevtoolsTargetId}
        setSelectedDevtoolsTargetId={setSelectedDevtoolsTargetId}
        streaming={streaming}
        setStreaming={setStreaming}
        presentation={presentation}
        onEnterPresentation={enterPresentation}
        onExitPresentation={exitPresentation}
        embedLocked={embedLocked}
        chromeEnabled={chromeEnabled}
        setChromeEnabled={setChromeEnabled}
      />
    );
  } else {
    const leftPad = gridOpen ? gridPanelWidth + 36 : 24;
    mainView = (
      <div
        className="h-dvh flex flex-col items-center justify-center gap-3 bg-page font-system box-border [transition:padding_0.25s_ease]"
        style={{ paddingLeft: leftPad, paddingRight: 24 }}
      >
        {selectedDevice ? (
          <DevicePlaceholder
            name={selectedDevice.name}
            runtime={selectedDevice.runtime}
            chrome={selectedDevice.chrome ?? null}
            placeholderAsset={selectedDevice.placeholderAsset ?? null}
            busy={!!selectedDevice.helper || !!starting[selectedDevice.device]}
            busyLabel={selectedDevice.helper ? "Connecting…" : "Starting…"}
            error={actionErrors[selectedDevice.device] ?? null}
            onStart={() => startDevice(selectedDevice.device)}
          />
        ) : gridDevices ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-[18px] m-0 text-white/90">No simulators available</h1>
            <p className="text-white/55 text-[14px] max-w-120">
              Create a simulator in Xcode, or start one with{" "}
              <code className="bg-[#222] px-1.5 py-0.5 rounded text-[13px]">bunx @expo/serve-sim --detach</code>.
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      {mainView}
      <ServeSimToaster />
      {/* Persistent left device sidebar — overlays every main view so swapping
          streams never remounts (and refetches) the picker. */}
      <div
        aria-hidden={presentation}
        style={{
          opacity: presentation ? 0 : 1,
          // `visibility`, not `hidden`: an unrendered element has no opacity to
          // fade back in from. Still keeps it out of the tab order.
          visibility: chromeGone ? "hidden" : "visible",
          pointerEvents: presentation ? "none" : undefined,
          transition: `opacity ${SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS}ms ease`,
        }}
      >
        <GridPanel
          open={gridOpen}
          onClose={() => setGridOpen(false)}
          width={gridPanelWidth}
          side="left"
          devices={gridDevices}
          total={gridTotal}
          hasMore={gridHasMore}
          onLoadMore={loadMoreGrid}
          onLoadAll={loadAllGrid}
          onResetPage={resetGridPage}
          selectedUdid={effectiveUdid}
          onSelect={selectDevice}
          starting={starting}
          shuttingDown={shuttingDown}
          onShutdown={shutdownDevice}
        />
        <ResizeHandle
          panelWidth={gridPanelWidth}
          visible={gridOpen}
          onPointerDown={onGridResize}
          ariaLabel="Resize simulators sidebar"
          side="left"
        />
        <DeviceSidebarToggle open={gridOpen} onClick={() => setGridOpen(true)} />
      </div>
    </>
  );
}

interface AppWithConfigProps {
  config: PreviewConfig;
  deviceName: string | null;
  deviceRuntime: string | null;
  chrome: DeviceKitChromeDescriptor | null;
  axOverlayEnabled: boolean;
  setAxOverlayEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  devtoolsOpen: boolean;
  setDevtoolsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  logsOpen: boolean;
  setLogsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridOpen: boolean;
  setGridOpen: React.Dispatch<React.SetStateAction<boolean>>;
  gridPanelWidth: number;
  selectedDevtoolsTargetId: string | null;
  setSelectedDevtoolsTargetId: React.Dispatch<React.SetStateAction<string | null>>;
  streaming: boolean;
  setStreaming: (v: boolean) => void;
  presentation: boolean;
  onEnterPresentation: () => void;
  onExitPresentation: () => void;
  embedLocked: boolean;
  chromeEnabled: boolean;
  setChromeEnabled: React.Dispatch<React.SetStateAction<boolean>>;
}

function AppWithConfig({
  config,
  deviceName,
  deviceRuntime,
  chrome: defaultChrome,
  axOverlayEnabled,
  setAxOverlayEnabled,
  devtoolsOpen,
  setDevtoolsOpen,
  logsOpen,
  setLogsOpen,
  gridOpen,
  setGridOpen,
  gridPanelWidth,
  selectedDevtoolsTargetId,
  setSelectedDevtoolsTargetId,
  streaming,
  setStreaming,
  presentation,
  onEnterPresentation,
  onExitPresentation,
  embedLocked,
  chromeEnabled,
  setChromeEnabled,
}: AppWithConfigProps) {
  useEffect(() => {
    document.title = deviceName ? `Simulator - ${deviceName}` : "Simulator Preview";
  }, [deviceName]);

  const deviceType: DeviceType = getDeviceType(deviceName);
  // Screen config now arrives over the input WebSocket (pushed by the helper on
  // connect + on every dimension/orientation change) instead of a 1s /config poll.
  const [wsStreamConfig, setWsStreamConfig] = useState<StreamConfig | null>(null);
  const streamConfig = wsStreamConfig;
  const hingeAngle = streamConfig?.hingeAngle;
  const supportsHingeAngle = streamConfig?.supportsHingeAngle;
  // Before native capability metadata arrives, recognize Duo's Xcode DeviceKit
  // chrome identifiers: phone15 is the cover profile and phone14 the inner
  // display variant. These are asset identifiers, not iPhone model numbers.
  const isDuo = supportsHingeAngle === true ||
    /\biphone\s+duo\b/i.test(deviceName ?? "") ||
    defaultChrome?.identifier === "phone14" || defaultChrome?.identifier === "phone15";
  const [duoViewMode, setDuoViewModeState] = useState<"2d" | "3d">(() => {
    try { return localStorage.getItem("serve-sim:duo-view-mode") === "2d" ? "2d" : "3d"; } catch { return "3d"; }
  });
  const [duoModelUnavailable, setDuoModelUnavailable] = useState(false);
  const useDuoModel = isDuo && duoViewMode === "3d" && chromeEnabled && !axOverlayEnabled && !duoModelUnavailable;
  const setDuoViewMode = useCallback((mode: "2d" | "3d") => {
    setDuoViewModeState(mode);
    setDuoModelUnavailable(false);
    if (mode === "3d") {
      setChromeEnabled(true);
      setAxOverlayEnabled(false);
    }
    try { localStorage.setItem("serve-sim:duo-view-mode", mode); } catch { /* Viewer storage is optional. */ }
  }, [setChromeEnabled, setAxOverlayEnabled]);
  const [cacheScreenOnFold, setCacheScreenOnFoldState] = useState(() => {
    try { return localStorage.getItem("serve-sim:duo-cache-screen-on-fold") === "true"; } catch { return false; }
  });
  const [duoSizeMode, setDuoSizeModeState] = useState<"physical" | "fill">(() => {
    try { return localStorage.getItem("serve-sim:duo-preview-size") === "physical" ? "physical" : "fill"; } catch { return "fill"; }
  });
  const setCacheScreenOnFold = useCallback((enabled: boolean) => {
    setCacheScreenOnFoldState(enabled);
    try { localStorage.setItem("serve-sim:duo-cache-screen-on-fold", String(enabled)); } catch { /* Viewer storage is optional. */ }
  }, []);
  const setDuoSizeMode = useCallback((mode: "physical" | "fill") => {
    setDuoSizeModeState(mode);
    try { localStorage.setItem("serve-sim:duo-preview-size", mode); } catch { /* Viewer storage is optional. */ }
  }, []);
  const [duoPanelPeer, setDuoPanelPeer] = useState<DuoPanelPeer | null>(null);
  const [duoPanelError, setDuoPanelError] = useState<string | null>(null);
  const useDuoPanelFeeds = useDuoModel;
  const onDuoUnavailable = useCallback(() => setDuoModelUnavailable(true), []);
  useEffect(() => setDuoModelUnavailable(false), [config.streamUrl]);
  const devtools = useWebKitDevtools(config.devtoolsEndpoint ?? simEndpoint("devtools"), devtoolsOpen);

  useEffect(() => {
    if (!devtoolsOpen) return;
    if (selectedDevtoolsTargetId && devtools.targets.some((target) => target.id === selectedDevtoolsTargetId)) return;
    setSelectedDevtoolsTargetId(devtools.targets.length === 1 ? devtools.targets[0]!.id : null);
  }, [devtoolsOpen, devtools.targets, selectedDevtoolsTargetId, setSelectedDevtoolsTargetId]);

  useEffect(() => {
    setSelectedDevtoolsTargetId(null);
  }, [config.device, setSelectedDevtoolsTargetId]);

  // Prefer H.264 (AVCC via WebCodecs) when the browser supports it; otherwise
  // fall back to MJPEG. The MJPEG reader stays dormant (null url) under AVCC so
  // we never pull both streams at once. The AVCC frames are decoded view-side
  // by SimulatorView's `useAvccStream`; this hook just reports browser support.
  //
  // Browser support is necessary but not sufficient: native H.264 encoding can
  // still fail on a constrained host. If no frame decodes during the startup
  // window, `avccFallback` drops to MJPEG. See avcc-fallback.ts.
  const avcc = useAvccStream();
  const streamSettingsState = useStreamSettings({
    device: config.device,
    endpoint: config.streamSettingsEndpoint,
    initialSettings: config.streamSettings,
  });
  const streamSettings = streamSettingsState.settings;
  const updateStreamPlayback = streamSettingsState.updatePlayback;
  const streamTransportLocked = streamSettingsState.transportLocked;
  const streamConfiguredMaxDimension = streamSettingsState.configuredMaxDimension;

  const wantsWebRtcVideo = streamSettings.transport === "webrtc";
  const handledWebRtcFailureRef = useRef<string | null>(null);
  const useWebRtcVideo = wantsWebRtcVideo;
  const [webRtcCodecOverride, setWebRtcCodecOverride] = useState<WebRtcCodec | null>(null);
  const configuredWebRtcCodec = streamSettings.webRtcCodec;
  const effectiveWebRtcCodec = webRtcCodecOverride ?? configuredWebRtcCodec;
  const webrtc = useWebRtcStream({
    offerUrl: webrtcOfferUrlFrom(config),
    closeUrl: webrtcCloseUrlFrom(config),
    enabled: useWebRtcVideo && !useDuoPanelFeeds,
    codec: effectiveWebRtcCodec,
    iceServers: streamSettings.iceServers,
    statsUrl: webrtcStatsUrlFrom(config),
    transportLocked: streamTransportLocked,
  });
  const { retry: retryWebRtcStream, markFrameDecoded: markWebRtcFrameDecoded } = webrtc;
  /// In Duo the stream above is disabled and each screen runs its own, so a restart has to go
  /// to whichever one is actually live.
  const restartWebRtcStream = useCallback(() => {
    setWebRtcCodecOverride(null);
    (useDuoPanelFeeds ? duoPanelPeer?.retry : retryWebRtcStream)?.();
  }, [duoPanelPeer, retryWebRtcStream, useDuoPanelFeeds]);
  const ladderRestart = useLadderRestart(restartWebRtcStream);
  /// The panel reads whichever stream is on screen: in Duo that is a screen's own peer, not
  /// the disabled one above.
  const streamPanelPeer: StreamPanelPeer = useDuoPanelFeeds
    ? {
        peerConnection: duoPanelPeer?.peerConnection ?? null,
        subscribeStats: duoPanelPeer?.subscribeStats,
        statsUrl: duoPanelPeer?.statsUrl,
        sessionId: duoPanelPeer?.sessionId ?? null,
        onResetCodec: restartWebRtcStream,
      }
    : {
        peerConnection: webrtc.peerConnection,
        subscribeStats: webrtc.subscribeStats,
        statsUrl: webrtcStatsUrlFrom(config),
        sessionId: webrtc.sessionId,
        onResetCodec: restartWebRtcStream,
      };
  const [avccFallback, dispatchAvccFallback] = useReducer(
    avccFallbackReducer,
    initialAvccFallback,
  );
  // `?codec=mjpeg` forces the JPEG fallback path even where WebCodecs exists —
  // an escape hatch for browsers whose H.264 decode misbehaves, and the way to
  // exercise the MJPEG pipeline in a browser that would otherwise pick AVCC.
  const [forceMjpeg] = useState(
    () => new URLSearchParams(window.location.search).get("codec") === "mjpeg",
  );
  const useMjpegHttp = streamSettings.httpCodec === "mjpeg";
  const useAvccVideo =
    !useWebRtcVideo &&
    !useMjpegHttp &&
    avcc.supported &&
    !avccFallback.fellBack &&
    !forceMjpeg;
  const mjpeg = useMjpegStream(useDuoPanelFeeds || useAvccVideo || useWebRtcVideo ? null : mjpegStreamUrlFrom(config));

  // Re-arm AVCC whenever the target stream changes (device switch / reconnect).
  useEffect(() => {
    setStreaming(false);
    dispatchAvccFallback("reset");
    setWebRtcCodecOverride(null);
    // The session a pending restart was scheduled for is being replaced.
    ladderRestart.cancel();
  }, [
    ladderRestart,
    config.streamUrl,
    setStreaming,
    streamSettings.transport,
    streamSettings.httpCodec,
    streamSettings.webRtcCodec,
  ]);
  const handleWebRtcFailure = useCallback((failure: WebRtcStreamFailure) => {
    if (!wantsWebRtcVideo || handledWebRtcFailureRef.current === failure.sessionId) return;
    handledWebRtcFailureRef.current = failure.sessionId;
    ladderRestart.noteFailure(performance.now());
    const decision = webRtcFallbackDecision(configuredWebRtcCodec, effectiveWebRtcCodec, failure);
    if (!decision) return;
    if (decision.type === "switch-to-http") {
      if (!streamTransportLocked) {
        updateStreamPlayback({ transport: "http" });
        return;
      }
      // A locked session has nowhere to fall back to, so start over rather than stay dead.
      // Only codec exhaustion qualifies; a permanent fault never resolves.
      if (failure.kind === "codec") ladderRestart.schedule();
      return;
    }
    setWebRtcCodecOverride(decision.codec);
  }, [
    configuredWebRtcCodec,
    effectiveWebRtcCodec,
    ladderRestart,
    streamTransportLocked,
    updateStreamPlayback,
    wantsWebRtcVideo,
  ]);
  useEffect(() => {
    if (webrtc.failure) handleWebRtcFailure(webrtc.failure);
  }, [webrtc.failure, handleWebRtcFailure]);
  // A restart armed for the old failure would tear down the stream that recovered.
  useEffect(() => {
    if (!wantsWebRtcVideo || streaming) ladderRestart.cancel();
  }, [ladderRestart, streaming, wantsWebRtcVideo]);
  const onPanelAvccError = useCallback(() => dispatchAvccFallback("error"), []);
  const lockedWebRtcError =
    streamTransportLocked && webrtc.failure && !webrtc.error
      ? "WebRTC streaming failed. HTTP fallback is disabled for this session."
      : null;
  // One-shot startup window; the JPEG seed paints immediately but only a
  // decoded H.264 frame proves AVCC is viable and cancels this fallback.
  useEffect(() => {
    if (!useAvccVideo || useDuoPanelFeeds) return;
    const timer = setTimeout(
      () => dispatchAvccFallback("timeout"),
      AVCC_FRAME_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [useAvccVideo, useDuoPanelFeeds, config.streamUrl]);
  const [liveStreamConfig, setLiveStreamConfig] = useState<StreamConfig | null>(null);
  const [hingePending, setHingePending] = useState(false);
  const [hingeError, setHingeError] = useState<string | null>(null);
  const [hingePreview, setHingePreview] = useState<HingeControlState | null>(null);
  const [physicalPose, setPhysicalPose] = useState<HingePose | null | undefined>(undefined);
  const [duoView, setDuoView] = useState<DuoView | null>(null);
  const faceDownFramingRef = useRef<DuoFaceDownFraming>({ saved: null, held: false });
  const [orientationOverride, setOrientationOverride] = useState(false);
  const hingePendingRef = useRef(false);
  const [hingeCommands, setHingeCommands] = useState<DuoHingeCommands>({ pending: false, coverDepartures: 0, innerDepartures: 0 });
  const sentHingePoseRef = useRef<HingePose | null | undefined>(undefined);
  const hingeQueueRef = useRef<ReturnType<typeof createAcknowledgedControlQueue<HingeControlCommand>> | null>(null);
  const activeStreamConfig: StreamConfig = liveStreamConfig ?? streamConfig ?? fallbackScreenSize(deviceType, deviceName);
  const activeScreenId = liveStreamConfig?.screenId ?? streamConfig?.screenId;
  const chrome = defaultChrome ? deviceKitChromeForScreen(defaultChrome, activeScreenId) : null;
  const previewHingeAngle = hingePreview?.hingeAngle ?? hingeAngle;
  const previewHingePose = hingePreview ? hingePreview.hingePose : streamConfig?.hingePose;
  // A pending angle or preset releases Table Mode, so the preview wins over a
  // face-down orientation that another client confirmed.
  const previewFaceDown = (hingePreview?.tableMode ?? activeStreamConfig.tableMode) === true &&
    activeStreamConfig.physicalOrientation === "facedown";
  const initialDuoView = useMemo(() => duoInitialView(hingeAngle, streamConfig?.hingePose, activeStreamConfig),
    [hingeAngle, streamConfig?.hingePose, activeStreamConfig]);
  // Control callbacks read the latest native state without re-registering
  // keyboard and folding-handle listeners on every config broadcast.
  const duoControlStateRef = useRef({ streamConfig, initialDuoView, orientation: activeStreamConfig.orientation });
  duoControlStateRef.current = { streamConfig, initialDuoView, orientation: activeStreamConfig.orientation };
  const showHingeControls = !presentation && (supportsHingeAngle ?? hingeAngle !== undefined);
  const clipOrientation = activeStreamConfig.orientation ?? (activeStreamConfig.width > activeStreamConfig.height ? "landscape_left" : "portrait");
  const hasDisplayRadii = !!chrome?.screenCornerRadii;
  const imgBorderRadius = chrome && hasDisplayRadii
    ? deviceKitScreenRadius(chrome, clipOrientation)
    : screenBorderRadius(deviceType, activeStreamConfig);
  const frameMaxWidth = simulatorMaxWidth(deviceType, activeStreamConfig);
  const frameAspectRatio = simulatorAspectRatio(activeStreamConfig);
  const frameDisplayConfig = displayStreamConfig(activeStreamConfig);
  const frameAspectRatioValue = frameDisplayConfig
    ? frameDisplayConfig.width / frameDisplayConfig.height
    : 1;

  // DeviceKit chrome wraps the live stream in the real device bezel (with
  // working hardware buttons), rotating its artwork around the active screen.
  // When chromed, the on-screen container is the full frame (bezel + screen):
  // `chromeScale` is how much bigger the frame
  // is than the screen, so we scale the container up by it while keeping the
  // *screen* at the same comfortable size — and resize / panel-collision math
  // all operate on the frame dimensions.
  const chromeGeometry = chrome ? deviceKitChromeGeometry(chrome, clipOrientation) : null;
  const useChrome = !!chromeGeometry && chromeEnabled && !useDuoModel;
  const chromeScale = useChrome ? chromeGeometry!.frame.width / chromeGeometry!.screen.width : 1;
  // The 3D stage keeps one footprint as the device folds and changes active
  // displays. Resizing it with each native screen configuration would apply a
  // second animation on top of the physical hinge motion and crop the model.
  const containerDefaultWidth = useDuoModel ? DUO_STAGE_DEFAULT_WIDTH : frameMaxWidth * chromeScale;
  const containerAspectRatioValue = useDuoModel ? 1 : useChrome
    ? chromeGeometry!.frame.width / chromeGeometry!.frame.height
    : frameAspectRatioValue;
  const containerAspectRatio = useDuoModel ? "1 / 1" : useChrome
    ? `${chromeGeometry!.frame.width} / ${chromeGeometry!.frame.height}`
    : frameAspectRatio;

  // Touch/button relay via direct WebSocket
  const wsRef = useRef<WebSocket | null>(null);
  if (!hingeQueueRef.current) {
    hingeQueueRef.current = createAcknowledgedControlQueue<HingeControlCommand>({
      send: (request) => {
        if (!trySendWsMessage(wsRef.current, 0x10, request)) return false;
        if (request.command.control === "pose") sentHingePoseRef.current = request.command.value;
        const pose = sentHingePoseRef.current;
        setHingeCommands((previous) => recordDuoHingeCommand(previous, request.command, pose));
        return true;
      },
      onPendingChange: (pending) => {
        hingePendingRef.current = pending;
        setHingePending(pending);
        setHingeCommands((previous) => ({ ...previous, pending }));
      },
      onError: (message) => {
        setHingeError(message);
        setHingePreview(null);
        setPhysicalPose(undefined);
        sentHingePoseRef.current = undefined;
        setOrientationOverride(false);
      },
    });
  }
  const pendingWsMessagesRef = useRef<QueuedWsMessage[]>([]);
  const coarsePointerRef = useRef(false);
  useEffect(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let currentWs: WebSocket | null = null;
    pendingWsMessagesRef.current = [];

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 1000);
    };

    const connect = () => {
      const ws = new WebSocket(config.wsUrl);
      ws.binaryType = "arraybuffer";
      currentWs = ws;
      wsRef.current = ws;
      ws.onopen = () => {
        pendingWsMessagesRef.current = flushWsMessageQueue(
          ws,
          pendingWsMessagesRef.current,
        );
        // A touch client disconnects the sim's hardware keyboard so its
        // on-screen keyboard shows; desktop leaves it connected.
        if (coarsePointerRef.current) {
          pendingWsMessagesRef.current = sendOrQueueWsMessage(
            ws,
            pendingWsMessagesRef.current,
            0x0e,
            { enabled: false },
          );
        }
      };
      ws.onmessage = (ev) => {
        if (stopped) return;
        // Server -> client screen-config push (tag 0x82): [tag][JSON].
        if (!(ev.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(ev.data);
        if (bytes.length < 1) return;
        if (bytes[0] === 0x90) {
          try {
            const result = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as AcknowledgedControlReply;
            if (result && typeof result.requestId === "number" && typeof result.ok === "boolean") {
              hingeQueueRef.current?.receive(result);
            }
          } catch {}
          return;
        }
        if (bytes[0] !== 0x82) return;
        try {
          const cfg = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as StreamConfig;
          if (cfg.width <= 0 || cfg.height <= 0) return;
          // A rotation clears the native named pose. Observe the received
          // config even when its values equal the previous React state.
          if (cfg.hingePose === null && !hingePendingRef.current) setOrientationOverride(false);
          setWsStreamConfig((prev) =>
            screenConfigsEqual(prev, cfg) ? prev : cfg,
          );
        } catch {}
      };
      ws.onclose = (event) => {
        if (!stopped && event.code === 1013) showInputSocketError(event.reason || "The server is busy. Try again shortly.");
        if (wsRef.current === ws) wsRef.current = null;
        if (!stopped) {
          setPhysicalPose(undefined);
          sentHingePoseRef.current = undefined;
          setOrientationOverride(false);
        }
        if (!stopped && hingePendingRef.current) {
          hingeQueueRef.current?.clear();
          setHingePreview(null);
          setHingeError("Connection lost while changing the device pose.");
        }
        scheduleReconnect();
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current === currentWs) wsRef.current = null;
      hingeQueueRef.current?.clear();
      currentWs?.close();
    };
  }, [config.wsUrl]);

  const sendWs = useCallback((tag: number, payload: object) => {
    pendingWsMessagesRef.current = sendOrQueueWsMessage(
      wsRef.current,
      pendingWsMessagesRef.current,
      tag,
      payload,
    );
  }, []);

  const keySender = useMemo(
    () => createPacedKeySender((e) => sendWs(0x06, e)),
    [sendWs],
  );
  useEffect(() => () => keySender.dispose(), [keySender]);

  const onStreamTouch = useCallback(
    (data: { type: string; x: number; y: number; edge?: number }) => {
      sendWs(0x03, data);
    },
    [sendWs],
  );

  const onStreamMultiTouch = useCallback((data: any) => sendWs(0x05, data), [sendWs]);
  const onStreamButton = useCallback((button: string) => sendWs(0x04, { button }), [sendWs]);
  // A hardware button on the device chrome was pressed/released. Forward its HID
  // (page, usage) so the helper injects it via arbitrary HID — `down`/`up` phases
  // let power / side buttons be held for their long-press menus.
  const handleChromeButton = useCallback(
    ({ phase, button }: ChromeButtonPress) => {
      if (button.usagePage == null || button.usage == null) return;
      sendWs(0x04, {
        button: button.name,
        page: button.usagePage,
        usage: button.usage,
        phase,
      });
    },
    [sendWs],
  );
  const onStreamDigitalCrown = useCallback((delta: number) => sendWs(0x0a, { delta }), [sendWs]);
  const onStreamScroll = useCallback((data: { dx: number; dy: number; x: number; y: number }) => sendWs(0x0b, data), [sendWs]);
  const onScreenConfigChange = useCallback((next: StreamConfig) => {
    setLiveStreamConfig((prev) =>
      screenConfigsEqual(prev, next) ? prev : next,
    );
  }, []);
  const setHingeControl = useCallback((command: HingeControlCommand) => {
    const { streamConfig, initialDuoView } = duoControlStateRef.current;
    setHingeError(null);
    faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
    // Editing the hinge or Table Mode clears the named preset, but preserves
    // the simulator's physical orientation (for example Laptop on a table).
    if (command.control === "pose") {
      setPhysicalPose(command.value);
      setOrientationOverride(false);
      setDuoView(duoPresetView(command.value));
    } else {
      // Lock even an early edit before the first complete native config.
      setDuoView((previous) => previous ?? initialDuoView);
    }
    setHingePreview((previous) => ({
      hingeAngle: previous?.hingeAngle ?? streamConfig?.hingeAngle,
      hingePose: previous ? previous.hingePose : streamConfig?.hingePose,
      tableMode: previous?.tableMode ?? streamConfig?.tableMode,
      ...hingeControlState(command),
    }));
    hingeQueueRef.current?.enqueue(command, { key: command.control, replaceQueued: command.control === "pose" });
  }, []);
  const setHingeAngleFromHandle = useCallback((value: number) => {
    setHingeControl({ control: "angle", value });
  }, [setHingeControl]);
  const rotateDevice = useCallback((orientation: SimulatorOrientation, direction?: "left" | "right") => {
    const current = duoControlStateRef.current;
    const turns = direction ? (direction === "left" ? -1 : 1)
      : (rotationDegreesForOrientation(current.orientation) - rotationDegreesForOrientation(orientation)) / 90;
    setDuoView((previous) => duoRotateView(previous ?? current.initialDuoView, turns));
    faceDownFramingRef.current = DUO_FACE_DOWN_HELD;
    setHingePreview(null);
    setPhysicalPose(null);
    sentHingePoseRef.current = null;
    setOrientationOverride(true);
    sendWs(0x07, { orientation });
  }, [sendWs]);
  const currentOrientation =
    (activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? "portrait";
  const canRotate = deviceType !== "watch" && deviceType !== "vision";
  const rotateBy = useCallback(
    (direction: "left" | "right") => {
      if (!canRotate) return;
      const next = (direction === "left" ? ROTATE_LEFT_CYCLE : ROTATE_RIGHT_CYCLE)[currentOrientation];
      rotateDevice(next, direction);
    },
    [canRotate, currentOrientation, rotateDevice],
  );

  useEffect(() => {
    setLiveStreamConfig(null);
    setWsStreamConfig(null);
    setHingePending(false);
    setHingeError(null);
    setHingePreview(null);
    setPhysicalPose(undefined);
    setDuoView(null);
    faceDownFramingRef.current = { saved: null, held: false };
    sentHingePoseRef.current = undefined;
    setOrientationOverride(false);
  }, [config.streamUrl]);

  useEffect(() => {
    // Use native orientation once when connecting, never as a live view control.
    if (!duoView && activeStreamConfig.screenId !== undefined) setDuoView((previous) => previous ?? initialDuoView);
  }, [duoView, activeStreamConfig.screenId, initialDuoView]);

  useEffect(() => {
    if (!hingePreview || hingePending || !streamConfig) return;
    // Configs from earlier commands can arrive while the latest request is
    // queued. Hold the requested pose until both its acknowledgement and its
    // matching config arrive, so rapid preset changes never animate backwards.
    if (
      (hingePreview.hingeAngle === undefined || hingePreview.hingeAngle === streamConfig.hingeAngle) &&
      (hingePreview.hingePose === undefined || hingePreview.hingePose === streamConfig.hingePose) &&
      (hingePreview.tableMode === undefined || hingePreview.tableMode === streamConfig.tableMode)
    ) setHingePreview(null);
  }, [hingePreview, hingePending, streamConfig]);

  useEffect(() => {
    // Also learn poses applied outside this browser. An older queued reply
    // must not replace the orientation chosen by the latest local request.
    // Rotate clears the known native physical pose. Ignore an older
    // preset acknowledgement until native reports that its pose was cleared.
    if (orientationOverride || hingePreview || hingePending) return;
    if (streamConfig?.hingePose) {
      setPhysicalPose(streamConfig.hingePose);
      sentHingePoseRef.current = streamConfig.hingePose;
    } else if (duoPhysicalPoseChanged(physicalPose, streamConfig?.physicalOrientation)) {
      // Another client turned the device over without a preset. Frame it as
      // on connect; face-down framing below still turns it to the cover.
      setPhysicalPose(null);
      sentHingePoseRef.current = null;
      setDuoView(null);
    }
  }, [orientationOverride, hingePreview, hingePending, streamConfig?.hingePose, streamConfig?.physicalOrientation, physicalPose]);

  useEffect(() => {
    // Another client can turn a half-open device face down without a preset.
    // Frame the elected cover as Tent does, and restore the previous view when
    // the device turns back. Local hinge and rotation controls own the view.
    if (hingePreview || hingePending || streamConfig?.hingePose === "tent") return;
    const faceDown = streamConfig?.tableMode === true && streamConfig.physicalOrientation === "facedown";
    const { state, view } = duoFaceDownFraming(faceDownFramingRef.current, faceDown, duoView ?? initialDuoView);
    faceDownFramingRef.current = state;
    if (view) setDuoView(view);
  }, [hingePreview, hingePending, streamConfig?.hingePose, streamConfig?.tableMode, streamConfig?.physicalOrientation, duoView, initialDuoView]);

  useEffect(() => {
    const confirmedConfig = streamConfig;
    if (!confirmedConfig) return;
    setLiveStreamConfig((prev) =>
      screenConfigsEqual(prev, confirmedConfig) ? prev : null,
    );
  }, [streamConfig, streamConfig?.width, streamConfig?.height, streamConfig?.orientation, streamConfig?.screenId, streamConfig?.hingeAngle, streamConfig?.supportsHingeAngle, streamConfig?.hingePose, streamConfig?.tableMode, streamConfig?.tableModeAvailable, streamConfig?.inputUnavailable]);

  const sendKey = useCallback((type: "down" | "up", usage: number) => {
    sendWs(0x06, { type, usage });
  }, [sendWs]);

  // Subscribe to app-state SSE.
  const [currentApp, setCurrentApp] = useState<{ bundleId: string; isReactNative: boolean; pid?: number } | null>(null);
  // Start with the tools panel open when the viewport has room for it beside
  // the simulator (typical device frame ≈ 420px plus page/panel gutters);
  // smaller windows keep it closed so the device isn't squeezed on load.
  const [panelOpen, setPanelOpen] = useState(() => {
    if (typeof window === "undefined" || presentation) return false;
    const stored = Number(window.localStorage.getItem("serve-sim:tools-panel-width"));
    const panelWidth = Number.isFinite(stored) && stored > 0 ? stored : PANEL_WIDTH;
    return window.innerWidth >= panelWidth + 640;
  });
  const openPanelsRef = useRef({ panel: false, devtools: false });
  openPanelsRef.current = { panel: panelOpen, devtools: devtoolsOpen };
  const panelsBeforePresentationRef = useRef<{ panel: boolean; devtools: boolean } | null>(null);
  useEffect(() => {
    if (presentation) {
      panelsBeforePresentationRef.current ??= openPanelsRef.current;
      setPanelOpen(false);
      setDevtoolsOpen(false);
      return;
    }
    const restored = panelsBeforePresentationRef.current;
    if (!restored) return;
    panelsBeforePresentationRef.current = null;
    setPanelOpen(restored.panel);
    setDevtoolsOpen(restored.devtools);
  }, [presentation, setDevtoolsOpen]);
  const { width: toolsPanelWidth, onPointerDown: onToolsResize } = useResizableWidth(
    "serve-sim:tools-panel-width",
    PANEL_WIDTH,
    240,
    720,
  );
  const { width: devtoolsPanelWidth, onPointerDown: onDevtoolsResize } = useResizableWidth(
    "serve-sim:devtools-panel-width",
    DEVTOOLS_PANEL_WIDTH,
    420,
    1400,
  );
  const { height: logsDrawerHeight, onPointerDown: onLogsResize } = useResizableHeight(
    "serve-sim:logs-drawer-height",
    LOGS_DRAWER_HEIGHT,
    140,
    720,
  );
  const [viewportWidth, setViewportWidth] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth : 0),
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.visualViewport?.height ?? window.innerHeight,
  );
  const [windowInnerHeight, setWindowInnerHeight] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerHeight,
  );
  useEffect(() => {
    const vv = window.visualViewport;
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      setWindowInnerHeight(window.innerHeight);
      setViewportHeight(vv?.height ?? window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    vv?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onResize);
    };
  }, []);
  useEffect(() => {
    setCurrentApp(null);
    const es = openHostEventStream(config.appStateEndpoint ?? simEndpoint("appstate"));
    let timer: ReturnType<typeof setTimeout> | null = null;
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as { bundleId: string; pid?: number; isReactNative: boolean };
        if (timer) clearTimeout(timer);
        const delay = next?.isReactNative ? 0 : 600;
        timer = setTimeout(() => setCurrentApp(next), delay);
      } catch {}
    };
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [config.appStateEndpoint]);

  // R to reload the RN/Expo bundle.
  // expo-go https://github.com/expo/expo/blob/f043020ffffd39fabb7684d52937d349f1ddc148/apps/expo-go/ios/Exponent/Kernel/DevSupport/EXKernelDevKeyCommands.m#L236
  // dev-client https://github.com/expo/expo/blob/f043020ffffd39fabb7684d52937d349f1ddc148/packages/expo-dev-menu/ios/Interceptors/DevMenuKeyCommandsInterceptor.swift#L46
  // react-native https://github.com/react/react-native/blob/c1652651c09506b8dda0b9515b5f0e5829220f0d/packages/react-native/React/Base/RCTKeyCommands.m#L69-L74
  const sendReactNativeReload = useCallback(async () => {
    const R = 0x15;
    sendKey("down", R);
    await new Promise((r) => setTimeout(r, 30));
    sendKey("up", R);
  }, [sendKey]);

  const simContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const flipRef = useRef<HTMLDivElement | null>(null);
  const [deviceRenderedWidth, setDeviceRenderedWidth] = useState(0);
  const [deviceRenderedHeight, setDeviceRenderedHeight] = useState(0);
  useEffect(() => {
    const el = simContainerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      setDeviceRenderedWidth(rect?.width ?? 0);
      setDeviceRenderedHeight(rect?.height ?? 0);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [simFocused, setSimFocused] = useState(true);
  const simFocusedRef = useRef(true);
  simFocusedRef.current = simFocused;
  const pressedKeysRef = useRef<Set<number>>(new Set());
  const coarsePointer = useCoarsePointer();
  coarsePointerRef.current = coarsePointer;
  useBlockPageZoom(coarsePointer);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const keyboardOpenRef = useRef(keyboardOpen);
  keyboardOpenRef.current = keyboardOpen;
  const keyboardInputRef = useRef<HTMLInputElement | null>(null);
  const phoneKeyboardWasRaisedRef = useRef(false);

  const closePhoneKeyboard = useCallback(() => {
    keyboardInputRef.current?.blur();
    setKeyboardOpen(false);
  }, []);

  const toggleKeyboard = useCallback(() => {
    const el = keyboardInputRef.current;
    const focused = document.activeElement === el;
    const raised = readNativeKeyboardRaised();
    if (keyboardOpen && (raised || focused)) {
      closePhoneKeyboard();
    } else {
      el?.focus();
      setKeyboardOpen(true);
    }
  }, [keyboardOpen, closePhoneKeyboard]);

  const phoneKeyboardRaised =
    coarsePointer && isVisualViewportKeyboardRaised(windowInnerHeight, viewportHeight);
  const stableViewportHeight = coarsePointer ? windowInnerHeight : viewportHeight;
  const containerHeight = phoneKeyboardRaised ? viewportHeight : stableViewportHeight;

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !phoneKeyboardRaised) return;
    let lastY = 0;
    const onStart = (e: TouchEvent) => {
      lastY = e.touches[0]?.clientY ?? 0;
    };
    const onMove = (e: TouchEvent) => {
      const target = e.target as Element | null;
      if (target && (flipRef.current?.contains(target) || target.closest("[data-panel]"))) return;
      const y = e.touches[0]?.clientY ?? lastY;
      el.scrollTop += lastY - y;
      lastY = y;
      e.preventDefault();
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
    };
  }, [phoneKeyboardRaised]);

  useEffect(() => {
    if (!keyboardOpen) {
      phoneKeyboardWasRaisedRef.current = false;
      return;
    }
    if (phoneKeyboardRaised) {
      phoneKeyboardWasRaisedRef.current = true;
      return;
    }
    if (!phoneKeyboardWasRaisedRef.current) return;
    const id = setTimeout(() => {
      if (readNativeKeyboardRaised()) return;
      phoneKeyboardWasRaisedRef.current = false;
      closePhoneKeyboard();
    }, 200);
    return () => clearTimeout(id);
  }, [keyboardOpen, phoneKeyboardRaised, closePhoneKeyboard]);

  useEffect(() => {
    if (presentation) {
      setSimFocused(true);
      return;
    }
    const onPointerDown = (e: PointerEvent) => {
      const inside = !!simContainerRef.current?.contains(e.target as Node);
      setSimFocused(inside);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [presentation]);

  useEffect(() => {
    if (simFocused) return;
    const held = pressedKeysRef.current;
    if (held.size === 0) return;
    for (const usage of held) sendWs(0x06, { type: "up", usage });
    held.clear();
  }, [simFocused, sendWs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent, type: "down" | "up") => {
      const simFocused = simFocusedRef.current;
      const keyboardOpen = keyboardOpenRef.current;
      if (simFocused && !keyboardOpen) {
        // Leave Command+digits to browser tab switching. Use physical codes so
        // Option+Shift's layout-specific characters do not affect pose lookup.
        if (supportsHingeAngle && e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && /^Digit[1-5]$/.test(e.code)) {
          e.preventDefault();
          if (type === "down" && !e.repeat) {
            const pose = HINGE_POSES[Number(e.code.slice(-1)) - 1];
            if (pose) setHingeControl({ control: "pose", value: pose.id });
          }
          return;
        }
        if (e.code === "KeyH" && e.metaKey && e.shiftKey) {
          e.preventDefault();
          if (type === "down" && !e.repeat) sendWs(0x04, { button: "home" });
          return;
        }
        if ((e.code === "ArrowLeft" || e.code === "ArrowRight") && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
          e.preventDefault();
          if (type === "down" && !e.repeat) {
            rotateBy(e.code === "ArrowLeft" ? "left" : "right");
          }
          return;
        }
        if (e.code === "KeyA" && e.metaKey && e.shiftKey) {
          e.preventDefault();
          if (type === "down" && !e.repeat) {
            runHostAction("appearance.get", { udid: config.device }).then((r) => {
              const next = r.stdout.trim() === "dark" ? "light" : "dark";
              return runHostAction("appearance.set", { udid: config.device, value: next });
            }).catch(() => {});
          }
          return;
        }
        if (e.code === "KeyK" && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey) {
          e.preventDefault();
          if (type === "down" && !e.repeat) sendWs(0x0c, {});
          return;
        }
      }
      if (type === "up") {
        // Always release a key we are holding, even if the gate changed since the
        // keydown, so a flip between down and up cannot leave it stuck on the sim.
        const usage = hidUsageForCode(e.code);
        if (usage == null || !pressedKeysRef.current.has(usage)) return;
        e.preventDefault();
        pressedKeysRef.current.delete(usage);
        sendWs(0x06, { type, usage });
        return;
      }
      if (isLogsShortcut(e)) return;
      const usage = keydownForward(e.code, {
        simFocused,
        keyboardOpen,
        captureInputEmpty: (keyboardInputRef.current?.value ?? "") === "",
      });
      if (usage == null) return;
      e.preventDefault();
      pressedKeysRef.current.add(usage);
      sendWs(0x06, {
        type,
        usage,
        ...(shiftedCharacter(e) !== undefined ? { key: e.key, shifted: true } : {}),
      });
    };
    const down = (e: KeyboardEvent) => onKey(e, "down");
    const up = (e: KeyboardEvent) => onKey(e, "up");
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sendWs, config.device, rotateBy, supportsHingeAngle, setHingeControl]);

  const uploads = useUploadToasts();
  const screenshot = useScreenshotToast(config.device);
  const mediaDrop = useMediaDrop({
    udid: config.device,
    enabled: streaming,
    onUploadStart: uploads.add,
    onUploadProgress: uploads.setProgress,
    onUploadEnd: (id, ok, message) =>
      uploads.update(id, { status: ok ? "success" : "error", message }),
    onUnsupported: (file) => {
      const id = uploads.add(file.name, "media");
      uploads.update(id, {
        status: "error",
        message: `Unsupported: ${file.type || fileExtension(file)}`,
      });
    },
    onHostPathDrop: screenshot.dismiss,
  });

  const simulatorResize = useSimulatorResize({
    defaultWidth: containerDefaultWidth,
    viewportWidth,
    viewportHeight: stableViewportHeight,
    aspectRatio: containerAspectRatioValue,
    reservedForChrome: SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
    onStart: () => setSimFocused(false),
  });

  // Only shift the simulator when a panel would otherwise collide with it.
  // Tools/DevTools dock on the right; the device sidebar docks on the left, so
  // each pushes the centered simulator the opposite way.
  const PANEL_EDGE_OFFSET = 12;
  const PANEL_GAP = 24;
  const RAIL_PANEL_GAP = 8;
  const SM_BREAKPOINT = 640;
  const deviceWidth = deviceRenderedWidth > 0
    ? Math.min(deviceRenderedWidth, simulatorResize.width)
    : simulatorResize.width;
  // Shift needed to clear a docked panel of `panelWidthPx` on the given side
  // without ever pushing the device under the opposite edge.
  const shiftToClear = (panelWidthPx: number): number => {
    if (panelWidthPx <= 0) return 0;
    const panelInnerEdge = viewportWidth - PANEL_EDGE_OFFSET - panelWidthPx;
    const deviceEdgeAtCenter = viewportWidth / 2 + deviceWidth / 2;
    const overlap = deviceEdgeAtCenter - (panelInnerEdge - PANEL_GAP);
    if (overlap <= 0) return 0;
    const shiftNeeded = 2 * overlap;
    return shiftNeeded <= panelWidthPx + PANEL_GAP ? shiftNeeded : 0;
  };
  const rightPanelWidthPx = devtoolsOpen
    ? devtoolsPanelWidth
    : panelOpen
    ? toolsPanelWidth
    : 0;
  const [exitScaling, setExitScaling] = useState(false);
  useEffect(() => {
    if (presentation) {
      setExitScaling(true);
      return;
    }
    if (!exitScaling) return;
    const id = setTimeout(() => setExitScaling(false), SIMULATOR_RESIZE_PRESENTATION_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [presentation, exitScaling]);
  const scaling = presentation || exitScaling;
  const shiftForRightPanel = presentation ? 0 : shiftToClear(rightPanelWidthPx);
  const shiftForLeftPanel = presentation ? 0 : shiftToClear(gridOpen ? gridPanelWidth : 0);
  const presentationInset = SIMULATOR_RESIZE_VIEWPORT_INSET_FOR_PRESENTATION;
  const layoutWidth = simulatorResize.width;
  const layoutHeight =
    containerAspectRatioValue > 0
      ? roundToDevicePixel(layoutWidth / containerAspectRatioValue)
      : 0;
  const frameWidth = presentation
    ? getPresentationFrameWidth(
        viewportWidth,
        stableViewportHeight,
        containerAspectRatioValue,
        presentationInset,
      )
    : layoutWidth;
  const layoutScale =
    layoutWidth > 0 && frameWidth > 0 ? frameWidth / layoutWidth : 1;
  const resizing = simulatorResize.isResizing || simulatorResize.isInertia;
  useFlipLayout(
    flipRef,
    !resizing && !presentation && !useDuoModel,
    layoutWidth,
    layoutHeight,
    stableViewportHeight,
    phoneKeyboardRaised,
    scaling,
  );

  return (
    <AxStateProvider endpoint={axOverlayEnabled ? config?.axEndpoint : undefined}>
    <div
      ref={scrollContainerRef}
      className={`flex flex-col items-center h-dvh bg-page font-system box-border ${
        phoneKeyboardRaised ? "justify-start overflow-y-hidden" : "justify-center"
      } ${presentation ? "gap-0" : "pt-16 pb-6 sm:py-6 gap-3"}`}
      style={{
        height: containerHeight > 0 ? containerHeight : undefined,
        paddingTop: presentation ? presentationInset : undefined,
        paddingBottom: presentation ? presentationInset : logsOpen ? logsDrawerHeight : undefined,
        paddingLeft: presentation ? presentationInset : 24 + shiftForLeftPanel,
        paddingRight: presentation ? presentationInset : 24 + shiftForRightPanel,
        transition: resizing || scaling ? "none" : SIMULATOR_RESIZE_PAGE_TRANSITION,
      }}
    >
      {phoneKeyboardRaised && (
        <div
          aria-hidden
          style={{
            height: presentation
              ? "max(env(safe-area-inset-top, 0px), 68px)"
              : "env(safe-area-inset-top, 0px)",
            flexShrink: 0,
            width: "100%",
          }}
        />
      )}
      <div
        className={`flex flex-col items-center min-w-0 ${phoneKeyboardRaised ? "shrink-0" : ""} ${presentation ? "gap-0" : "gap-3"}`}
        style={{
          width: layoutWidth,
          transition: resizing ? SIMULATOR_RESIZE_DRAG_TRANSITION : undefined,
        }}
      >
        {!presentation && (
        <div className={`fixed sm:static top-[18px] sm:top-auto left-1/2 -translate-x-1/2 sm:translate-x-0 z-30 sm:z-auto self-center ${panelOpen || devtoolsOpen ? "max-sm:hidden" : ""}`}>
          <SimulatorToolbar
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Simulator status"
            style={{
              width: "auto",
              minWidth: 0,
              maxWidth: "100%",
              flexWrap: "nowrap",
              justifyContent: "center",
              gap: 10,
              padding: "6px 10px",
              borderRadius: 18,
            }}
          >
            <span className="hidden sm:contents">
              <SimulatorToolbar.Title
                onClick={() => setGridOpen((o) => !o)}
                aria-label="Toggle simulators sidebar"
                aria-pressed={gridOpen}
                title="Simulators"
                hideSubtitle
                hideChevron
                style={{
                  maxWidth: "min(230px, calc(100vw - 170px))",
                }}
              />
            </span>
            <StreamStatusPill streaming={streaming} inputUnavailable={streamConfig?.inputUnavailable} />
          </SimulatorToolbar>
        </div>
        )}
        {presentation && !embedLocked && (
          <PresentationControls onExit={onExitPresentation}>
            {coarsePointer && (
              <KeyboardToggleButton
                open={keyboardOpen}
                onClick={toggleKeyboard}
              />
            )}
          </PresentationControls>
        )}
        <KeyboardCapture
          open={keyboardOpen}
          onKeys={(events) => keySender.enqueue(events)}
          inputRef={keyboardInputRef}
        />
        <div
          ref={flipRef}
          style={{
            width: layoutWidth,
            height: layoutHeight > 0 ? layoutHeight : undefined,
            transition: resizing ? SIMULATOR_RESIZE_DRAG_TRANSITION : undefined,
          }}
        >
        <div
          ref={simContainerRef}
          className="relative w-full h-full"
          style={{
            aspectRatio: containerAspectRatio,
            transform: scaling ? `scale(${layoutScale})` : undefined,
            transformOrigin: "center center",
            transition: resizing
              ? undefined
              : scaling
                ? SIMULATOR_RESIZE_PRESENTATION_TRANSITION
                : undefined,
            willChange: resizing ? "width" : scaling ? "transform" : undefined,
          }}
          {...mediaDrop.dropZoneProps}
        >
          {(() => {
            const streamView = (
              <SimulatorView
                url={config.url}
                wsUrl={config.wsUrl}
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  pointerEvents:
                    simulatorResize.isResizing || simulatorResize.isInertia ? "none" : undefined,
                }}
                imageStyle={{
                  // With chrome the screen slot clips (rounded) and the bezel
                  // provides the edge, so the stream itself is square + flush.
                  // Without chrome, round the screen and add a subtle bezel as an
                  // INSET shadow (not a border): a 1px border sits outside the
                  // content and, on the <canvas> path, composites its
                  // semi-transparent white against the black page as a visible
                  // outline. An inset shadow paints over the (opaque) video edge.
                  borderRadius: useChrome || useDuoModel ? 0 : imgBorderRadius,
                  cornerShape: useChrome || useDuoModel || hasDisplayRadii ? undefined : "superellipse(1.3)",
                  ...(useChrome || useDuoModel
                    ? {}
                    : { boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.2)" }),
                } as CSSProperties}
                hideControls
                onStreamingChange={setStreaming}
                onStreamTouch={onStreamTouch}
                onStreamMultiTouch={onStreamMultiTouch}
                onStreamButton={onStreamButton}
                onStreamDigitalCrown={onStreamDigitalCrown}
                onStreamScroll={onStreamScroll}
                streamMode={useWebRtcVideo ? "webrtc" : useAvccVideo ? "avcc" : "mjpeg"}
                webRtcStream={webrtc.stream}
                onWebRtcFrame={markWebRtcFrameDecoded}
                streamError={useWebRtcVideo ? webrtc.error ?? lockedWebRtcError : null}
                onAvccError={() => dispatchAvccFallback("error")}
                onAvccDecodedFrame={() => dispatchAvccFallback("decoded-frame")}
                subscribeFrame={useAvccVideo ? undefined : mjpeg.subscribeFrame}
                streamFrame={useAvccVideo ? undefined : mjpeg.frame}
                streamConfig={activeStreamConfig}
                enableDigitalCrown={deviceType === "watch"}
                onScreenConfigChange={onScreenConfigChange}
              />
            );
            const screenContent = (
              <>
                {streamView}
                {axOverlayEnabled && !presentation && <AxDomOverlay />}
              </>
            );
            if (useDuoModel) return (
              <DuoModelView
                key={config.device}
                angle={previewHingeAngle}
                pose={previewHingePose}
                physicalPose={physicalPose}
                faceDown={previewFaceDown}
                view={duoView ?? initialDuoView}
                streamConfig={activeStreamConfig}
                hingeCommands={hingeCommands}
                onUnavailable={onDuoUnavailable}
                streamError={useDuoPanelFeeds ? duoPanelError : null}
                cacheScreenOnFold={cacheScreenOnFold}
                sizeMode={duoSizeMode}
                onHingeAngleChange={showHingeControls && !resizing ? setHingeAngleFromHandle : undefined}
                onTouch={resizing ? undefined : onStreamTouch}
                onMultiTouch={resizing ? undefined : onStreamMultiTouch}
                onScroll={resizing ? undefined : onStreamScroll}
              >
                {useDuoPanelFeeds ? <DuoPanelStreams
                  streamUrl={config.streamUrl}
                  mode={useWebRtcVideo ? "webrtc" : useAvccVideo ? "avcc" : "mjpeg"}
                  activeScreenId={duoIntendedScreen(previewHingeAngle, physicalPose === undefined ? previewHingePose : physicalPose, activeScreenId, previewFaceDown)}
                  codec={effectiveWebRtcCodec}
                  iceServers={streamSettings.iceServers}
                  onStreamingChange={setStreaming}
                  onAvccError={onPanelAvccError}
                  onWebRtcFailure={handleWebRtcFailure}
                  transportLocked={streamTransportLocked}
                  onWebRtcPeerChange={setDuoPanelPeer}
                  onStreamError={setDuoPanelError}
                /> : streamView}
              </DuoModelView>
            );
            if (!useChrome) return screenContent;
            // The screen slot is the bezel's true opening; the stream letterboxes
            // (contains) inside it, filling the constraining axis and leaving a
            // thin black margin on the other — the device's own black screen
            // border. Containing (not covering) keeps the stream from ever
            // overflowing past the bezel.
            return (
              <DeviceKitChrome
                chrome={chrome!}
                orientation={clipOrientation}
                interactive
                containerSize={
                  // Measured, not computed: pixel rects can't self-correct the
                  // way the percentage layout did.
                  deviceRenderedWidth > 0 && deviceRenderedHeight > 0
                    ? { width: deviceRenderedWidth, height: deviceRenderedHeight }
                    : undefined
                }
                onButton={handleChromeButton}
                onCrownWheel={(deltaY, deltaMode) => {
                  const delta = digitalCrownDeltaFromWheel(
                    deltaY,
                    deltaMode,
                    deviceRenderedHeight || 1,
                  );
                  if (delta != null) onStreamDigitalCrown(delta);
                }}
                screen={screenContent}
              />
            );
          })()}
          {mediaDrop.isDragOver && (
            <div
              // No backdrop-blur here: the canvas underneath repaints every
              // stream frame, and backdrop-filter forces a full re-blur per
              // frame for the whole drag — the tint alone stays cheap.
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-accent bg-[rgba(99,102,241,0.18)] text-accent pointer-events-none z-20"
              style={{ borderRadius: useChrome ? undefined : imgBorderRadius }}
            >
              <Upload size={32} strokeWidth={1.5} />
              <span className="text-[13px] font-medium">Drop media or .ipa</span>
            </div>
          )}
          {!presentation && viewportWidth >= SM_BREAKPOINT && (
            <SimulatorResizeCornerHandle
              simulatorResize={simulatorResize}
              deviceType={deviceType}
              streamConfig={activeStreamConfig}
              containerWidth={deviceRenderedWidth || simulatorResize.width}
              containerHeight={
                deviceRenderedHeight ||
                (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
              }
            />
          )}
          <SimulatorResizeSizeBadge
            width={deviceRenderedWidth || simulatorResize.width}
            height={
              deviceRenderedHeight ||
              (containerAspectRatioValue > 0 ? simulatorResize.width / containerAspectRatioValue : 0)
            }
            visible={!presentation && (simulatorResize.isResizing || simulatorResize.isInertia)}
          />
        </div>
        </div>
        {!presentation && (
        <div className="inline-flex flex-wrap items-center justify-center gap-2 max-w-full pb-1 sm:pb-0">
          {showHingeControls && (
            <HingeControls
              key={config.device}
              angle={previewHingeAngle}
              pose={previewHingePose}
              supported={supportsHingeAngle}
              pending={hingePending}
              error={panelOpen ? null : hingeError}
              onChange={setHingeControl}
            />
          )}
          <SimulatorToolbar
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Simulator actions"
            style={{
              alignSelf: "center",
              width: "auto",
              minWidth: 0,
              maxWidth: "100%",
              justifyContent: "center",
              padding: "6px 8px",
              borderRadius: 18,
            }}
          >
            <SimulatorToolbar.Actions>
              {currentApp?.isReactNative && (
                <SimulatorToolbar.Button
                  aria-label="Reload React Native bundle"
                  title="Reload (R)"
                  onClick={() => void sendReactNativeReload()}
                >
                  <ReloadIcon />
                </SimulatorToolbar.Button>
              )}
              <SimulatorToolbar.HomeButton title="Home" />
              <SimulatorToolbar.ScreenshotButton
                title="Screenshot"
                onClick={(e) => { e.preventDefault(); void screenshot.capture(); }}
              />
              <SimulatorToolbar.RotateButton title="Rotate device" direction={isDuo ? "right" : "left"} />
            </SimulatorToolbar.Actions>
          </SimulatorToolbar>
          <SimulatorToolbar
            onRotate={rotateDevice}
            orientation={(activeStreamConfig as { orientation?: SimulatorOrientation }).orientation ?? null}
            deviceUdid={config.device}
            deviceName={deviceName}
            deviceRuntime={deviceRuntime}
            streaming={streaming}
            aria-label="Accessibility overlay"
            style={{
              width: "auto",
              minWidth: 0,
              justifyContent: "center",
              padding: 6,
              borderRadius: 22,
            }}
          >
            <AxToolbarButton
              overlayEnabled={axOverlayEnabled}
              streaming={streaming}
              onToggleOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
            />
          </SimulatorToolbar>
        </div>
        )}
      </div>

      {!presentation && (
      <>
      <div
        className="fixed top-3 flex flex-row sm:flex-col gap-1 p-1 bg-panel-bg border border-white/8 rounded-[10px] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] [transition:right_0.24s_cubic-bezier(0.22,1,0.36,1)] z-30"
        style={{
          right:
            PANEL_EDGE_OFFSET +
            ((panelOpen || devtoolsOpen) && viewportWidth >= SM_BREAKPOINT
              ? rightPanelWidthPx + RAIL_PANEL_GAP
              : 0),
        }}
      >
        {coarsePointer && (
          <KeyboardToggleButton
            open={keyboardOpen}
            onClick={toggleKeyboard}
          />
        )}
        <ShareSessionButton config={config} />
        <IconButton
          onClick={onEnterPresentation}
          aria-label="Full screen"
          title="Full screen"
        >
          <Maximize2 size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          onClick={() => {
            setDevtoolsOpen(false);
            setPanelOpen((o) => !o);
          }}
          aria-label="Open tools panel"
          aria-pressed={panelOpen}
          title="Tools"
        >
          <PanelRight size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          onClick={() => {
            setPanelOpen(false);
            setDevtoolsOpen((o) => !o);
          }}
          className="max-sm:hidden"
          aria-label="Open WebKit DevTools"
          aria-pressed={devtoolsOpen}
          title="WebKit DevTools"
        >
          <Globe size={18} strokeWidth={1.75} />
        </IconButton>
        <IconButton
          onClick={() => setLogsOpen((o) => !o)}
          aria-label="Open device logs"
          aria-pressed={logsOpen}
          title="Logs"
        >
          <ScrollText size={18} strokeWidth={1.75} />
        </IconButton>
      </div>

      <ToolsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        udid={config.device}
        deviceRuntime={deviceRuntime}
        currentApp={currentApp}
        eventLogEventsEndpoint={config.eventLogEventsEndpoint}
        metricsEndpoint={config.metricsEndpoint}
        crashesEndpoint={config.crashesEndpoint}
        captureEndpoint={config.captureEndpoint}
        axOverlayEnabled={axOverlayEnabled}
        onToggleAxOverlay={() => setAxOverlayEnabled((enabled) => !enabled)}
        streamSettings={streamSettings}
        onStreamPlaybackSettingsChange={streamSettingsState.updatePlayback}
        onStreamEncoderSettingsChange={streamSettingsState.updateEncoder}
        activeCodec={useWebRtcVideo ? `webrtc/${effectiveWebRtcCodec}` : useAvccVideo ? "h264" : "mjpeg"}
        peer={streamPanelPeer}
        avccSupported={avcc.supported}
        streamSettingsPending={
          streamSettingsState.pending || !streamSettingsState.encoderSettingsAvailable
        }
        streamTransportLocked={streamTransportLocked}
        streamConfiguredMaxDimension={streamConfiguredMaxDimension}
        width={toolsPanelWidth}
        chromeEnabled={chromeEnabled}
        onChromeEnabledChange={setChromeEnabled}
        hasChrome={!!chrome || isDuo}
        hingeControls={showHingeControls ? {
          angle: previewHingeAngle,
          pose: previewHingePose,
          tableMode: hingePreview?.tableMode ?? streamConfig?.tableMode,
          tableModeAvailable: streamConfig?.tableModeAvailable,
          supported: supportsHingeAngle,
          pending: hingePending,
          error: hingeError,
          onChange: setHingeControl,
          viewMode: useDuoModel ? "3d" : "2d",
          onViewModeChange: setDuoViewMode,
          viewError: duoModelUnavailable ? "3D preview unavailable. Select 3D to retry." : null,
          cacheScreenOnFold,
          onCacheScreenOnFoldChange: setCacheScreenOnFold,
          sizeMode: duoSizeMode,
          onSizeModeChange: setDuoSizeMode,
        } : undefined}
      />
      <ResizeHandle
        panelWidth={toolsPanelWidth}
        visible={panelOpen}
        onPointerDown={onToolsResize}
        ariaLabel="Resize tools panel"
      />

      <WebKitDevtoolsPanel
        open={devtoolsOpen}
        onClose={() => setDevtoolsOpen(false)}
        udid={config.device}
        targets={devtools.targets}
        selectedTargetId={selectedDevtoolsTargetId}
        onSelectTarget={setSelectedDevtoolsTargetId}
        loading={devtools.loading}
        error={devtools.error}
        onRefresh={() => void devtools.refresh()}
        width={devtoolsPanelWidth}
      />
      <ResizeHandle
        panelWidth={devtoolsPanelWidth}
        visible={devtoolsOpen}
        onPointerDown={onDevtoolsResize}
        ariaLabel="Resize WebKit DevTools panel"
      />
      </>
      )}
      <LogsDrawer
        open={logsOpen}
        hidden={presentation}
        onClose={() => setLogsOpen(false)}
        udid={config.device}
        logsEndpoint={config.logsEndpoint}
        currentAppPid={currentApp?.pid ?? null}
        height={logsDrawerHeight}
        leftInset={gridOpen ? gridPanelWidth : 0}
        rightInset={rightPanelWidthPx > 0 ? 12 + rightPanelWidthPx : 0}
        onResizePointerDown={onLogsResize}
      />
    </div>
    </AxStateProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
