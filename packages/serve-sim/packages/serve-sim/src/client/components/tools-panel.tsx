import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../Panel";
import { execOnHost } from "../utils/exec";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";
import { EventLogTool } from "./event-log-tool";
import { MetricsTool } from "./metrics-tool";
import { PANEL_BACKGROUND } from "./panel-colors";
import { SimulatorSettingsTool } from "./simulator-settings-tool";
import { StreamSettingsTool } from "./stream-settings-tool";
import type {
  StreamControlSettings,
  StreamEncoderSettings,
  StreamPlaybackSettings,
} from "../../stream-settings";

/** The preview's collapsible tools panel: app detection, metrics, camera, permissions, and settings. */
export function ToolsPanel({
  open,
  onClose,
  peerConnection,
  webrtcStatsUrl,
  webrtcSessionId,
  udid,
  deviceRuntime,
  currentApp,
  eventLogEventsEndpoint,
  metricsEndpoint,
  axOverlayEnabled,
  onToggleAxOverlay,
  streamSettings,
  onStreamPlaybackSettingsChange,
  onStreamEncoderSettingsChange,
  activeCodec,
  avccSupported,
  streamSettingsPending,
  streamTransportLocked = false,
  width,
}: {
  open: boolean;
  onClose: () => void;
  peerConnection: RTCPeerConnection | null;
  webrtcStatsUrl?: string;
  webrtcSessionId?: string | null;
  udid: string;
  deviceRuntime: string | null;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  streamSettings: StreamControlSettings;
  onStreamPlaybackSettingsChange: (patch: Partial<StreamPlaybackSettings>) => void;
  onStreamEncoderSettingsChange: (patch: Partial<StreamEncoderSettings>) => void;
  activeCodec: string;
  avccSupported: boolean;
  streamSettingsPending: boolean;
  streamTransportLocked?: boolean;
  width: number;
}) {
  return (
    <Panel open={open} width={width} style={{ backgroundColor: PANEL_BACKGROUND }}>
      <PanelHeader>
        <PanelTitle>Tools</PanelTitle>
        <PanelCloseButton onClick={onClose} />
      </PanelHeader>

      {open && (
        <div className="p-3.5 overflow-y-auto flex-1 flex flex-col gap-3">
          <AppDetectionTool udid={udid} currentApp={currentApp} />
          <MetricsTool
            udid={udid}
            currentAppBundleId={currentApp?.bundleId ?? null}
            metricsEndpoint={metricsEndpoint}
          />
          <EventLogTool udid={udid} eventsEndpoint={eventLogEventsEndpoint} />
          <SimulatorSettingsTool udid={udid} runtime={deviceRuntime} />
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <LocationEmulationTool udid={udid} exec={execOnHost} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <StreamSettingsTool
            settings={streamSettings}
            onPlaybackSettingsChange={onStreamPlaybackSettingsChange}
            onEncoderSettingsChange={onStreamEncoderSettingsChange}
            activeCodec={activeCodec}
            avccSupported={avccSupported}
            encoderSettingsDisabled={streamSettingsPending}
            transportLocked={streamTransportLocked}
            peerConnection={peerConnection}
            webrtcStatsUrl={webrtcStatsUrl}
            webrtcSessionId={webrtcSessionId}
          />
        </div>
      )}
    </Panel>
  );
}
