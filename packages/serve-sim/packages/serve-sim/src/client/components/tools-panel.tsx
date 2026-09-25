import { useState } from "react";
import { Smartphone } from "lucide-react";
import { CollapsibleSection } from "./collapsible-section";
import { SettingSwitch } from "./setting-switch";
import { LocationEmulationTool } from "../location-emulation-tool";
import { Panel, PanelCloseButton, PanelHeader, PanelTitle } from "../panel";
import { AppDetectionTool } from "./app-detection-tool";
import { AppPermissionsTool } from "./app-permissions-tool";
import { AxTreeTool } from "./ax-tree-tool";
import { CameraTool } from "./camera-tool";
import { CrashTool } from "./crash-tool";
import { EventLogTool } from "./event-log-tool";
import type { HingeControlsProps } from "./hinge-controls";
import { MetricsTool } from "./metrics-tool";
import { NetworkCaptureTool } from "./network-capture-tool";
import { PANEL_BACKGROUND } from "./panel-colors";
import { SimulatorSettingsTool } from "./simulator-settings-tool";
import { StreamSettingsTool } from "./stream-settings-tool";
import type { StreamPanelPeer } from "./stream-settings-tool";
import type {
  StreamControlSettings,
  StreamEncoderSettings,
  StreamPlaybackSettings,
} from "../../stream-settings";

export function ToolsPanel({
  open,
  onClose,
  udid,
  deviceRuntime,
  currentApp,
  eventLogEventsEndpoint,
  metricsEndpoint,
  crashesEndpoint,
  captureEndpoint,
  axOverlayEnabled,
  onToggleAxOverlay,
  streamSettings,
  onStreamPlaybackSettingsChange,
  onStreamEncoderSettingsChange,
  activeCodec,
  peer,
  avccSupported,
  streamSettingsPending,
  streamTransportLocked = false,
  streamConfiguredMaxDimension = 0,
  width,
  chromeEnabled,
  onChromeEnabledChange,
  hasChrome = false,
  hingeControls,
}: {
  open: boolean;
  onClose: () => void;
  udid: string;
  deviceRuntime: string | null;
  currentApp: { bundleId: string; isReactNative: boolean; pid?: number } | null;
  eventLogEventsEndpoint?: string;
  metricsEndpoint?: string;
  crashesEndpoint?: string;
  captureEndpoint?: string;
  axOverlayEnabled: boolean;
  onToggleAxOverlay: () => void;
  streamSettings: StreamControlSettings;
  onStreamPlaybackSettingsChange: (patch: Partial<StreamPlaybackSettings>) => void;
  onStreamEncoderSettingsChange: (patch: Partial<StreamEncoderSettings>) => void;
  activeCodec: string;
  peer: StreamPanelPeer;
  avccSupported: boolean;
  streamSettingsPending: boolean;
  streamTransportLocked?: boolean;
  streamConfiguredMaxDimension?: number;
  width: number;
  chromeEnabled?: boolean;
  onChromeEnabledChange?: (enabled: boolean) => void;
  hasChrome?: boolean;
  hingeControls?: HingeControlsProps;
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
          <NetworkCaptureTool udid={udid} captureEndpoint={captureEndpoint} />
          <EventLogTool udid={udid} eventsEndpoint={eventLogEventsEndpoint} />
          <SimulatorSettingsTool udid={udid} runtime={deviceRuntime} hingeControls={hingeControls} />
          <AxTreeTool
            overlayEnabled={axOverlayEnabled}
            onToggleOverlay={onToggleAxOverlay}
          />
          <CameraTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          <LocationEmulationTool udid={udid} />
          <AppPermissionsTool udid={udid} bundleId={currentApp?.bundleId ?? null} />
          {hasChrome && onChromeEnabledChange && (
            <DisplayTool chromeEnabled={!!chromeEnabled} onChromeEnabledChange={onChromeEnabledChange} />
          )}
          <StreamSettingsTool
            settings={streamSettings}
            onPlaybackSettingsChange={onStreamPlaybackSettingsChange}
            onEncoderSettingsChange={onStreamEncoderSettingsChange}
            activeCodec={activeCodec}
            peer={peer}
            avccSupported={avccSupported}
            encoderSettingsDisabled={streamSettingsPending}
            transportLocked={streamTransportLocked}
            configuredMaxDimension={streamConfiguredMaxDimension}
          />
          <CrashTool udid={udid} crashesEndpoint={crashesEndpoint} />
        </div>
      )}
    </Panel>
  );
}

function DisplayTool({
  chromeEnabled,
  onChromeEnabledChange,
}: {
  chromeEnabled: boolean;
  onChromeEnabledChange: (enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      summaryClassName="grid [grid-template-columns:auto_1fr_auto] items-center gap-2 text-left"
      summary={
        <>
          <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
            Display
          </span>
          <span />
        </>
      }
    >
      <div className="flex items-center gap-2.5 px-1">
        <Smartphone size={14} strokeWidth={1.75} className="text-white/50 shrink-0" />
        <span className="flex-1 text-[13px] text-white/80">Device frame</span>
        <SettingSwitch label="Device frame" checked={chromeEnabled} onChange={onChromeEnabledChange} />
      </div>
    </CollapsibleSection>
  );
}
