import {
  type DeviceClient,
  type DeviceHttpCodec,
  type DeviceStreamMode,
} from '@expo/hub-client';
import { SidebarToggle, bg } from '../primitives';
import { SIDEBAR_SECTION_INSET } from './CollapsibleSection';
import { CurrentAppSection } from './CurrentAppSection';
import { DeviceOptionsSection } from './DeviceOptionsSection';
import { EventsSection } from './EventsSection';
import { LogsSection } from './LogsSection';
import { StreamOptionsSection } from './StreamOptionsSection';
import { type Device, isDeviceFrameProfileId } from './data';
import { type StreamModeAvailability } from './StreamSection';

export type LogSidebarProps = {
  /** When set, a sidebar toggle is shown to collapse this panel. */
  onToggle?: () => void;
  /** Active device connection — feeds the inspector sections. */
  client?: DeviceClient;
  /** Selected device metadata used by viewer-local options. */
  device?: Device;
  /** Viewer-local preference for supported device-frame artwork. */
  showDeviceFrame?: boolean;
  /** Change the viewer-local device-frame preference. */
  onShowDeviceFrameChange?: (show: boolean) => void;
  /** Viewer-selected simulator stream mode. */
  streamMode?: DeviceStreamMode;
  /** Viewer-selected HTTP codec. */
  httpCodec?: DeviceHttpCodec;
  /** Which modes the current browser context can use. */
  streamModeAvailability?: StreamModeAvailability;
  /** Change the viewer-local stream mode. */
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
  /** Change the viewer-local HTTP codec. */
  onHttpCodecChange?: (codec: DeviceHttpCodec) => void;
  /** Shut the selected device down on the host. */
  onShutdown?: () => void;
  /** Remove/delete the selected device on the host. Ignored for physical devices. */
  onRemove?: () => void;
  /** Column width in px, driven by the resize handle. Defaults to 400. */
  width?: number;
};

/**
 * Right column: a compact inspector for the selected device, rendered directly
 * on the dashboard canvas so it matches the existing sidebar treatment.
 *
 * Section order: Current app (with its activity charts), Device options,
 * Stream options, Events, Logs. The first two start open.
 */
export function LogSidebar({
  onToggle,
  client,
  device,
  showDeviceFrame = true,
  onShowDeviceFrameChange,
  streamMode,
  httpCodec,
  streamModeAvailability,
  onStreamModeChange,
  onHttpCodecChange,
  onShutdown,
  onRemove,
  width = 400,
}: LogSidebarProps) {
  const deviceFrame = device
    ? {
        available: isDeviceFrameProfileId(device.deviceFrame),
        visible: showDeviceFrame,
        onVisibleChange: onShowDeviceFrameChange ?? (() => {}),
      }
    : undefined;

  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: `min(${width}px, 100vw)`,
        flexShrink: 0,
        height: '100vh',
        boxSizing: 'border-box',
        padding: '32px 0 0',
        backgroundColor: bg.default,
        overflow: 'hidden',
      }}>
      {onToggle && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            padding: `0 ${SIDEBAR_SECTION_INSET}px 12px`,
          }}>
          <SidebarToggle side="right" onClick={onToggle} />
        </div>
      )}
      <div
        style={{
          display: 'flex',
          flex: 1,
          minHeight: 0,
          flexDirection: 'column',
          overflowX: 'hidden',
          overflowY: 'auto',
        }}>
        <CurrentAppSection client={client} />
        {(client?.capabilities.deviceSettings ||
          client?.platform === 'android' ||
          deviceFrame ||
          (client && (onShutdown || onRemove))) && (
          <DeviceOptionsSection
            client={client}
            deviceFrame={deviceFrame}
            showDeviceSettings={client?.capabilities.deviceSettings ?? false}
            onShutdown={onShutdown}
            onRemove={device?.physical ? undefined : onRemove}
          />
        )}
        {client?.streamCapabilities && (
          <StreamOptionsSection
            client={client}
            streamMode={streamMode}
            httpCodec={httpCodec}
            streamModeAvailability={streamModeAvailability}
            onStreamModeChange={onStreamModeChange}
            onHttpCodecChange={onHttpCodecChange}
          />
        )}
        {client?.capabilities.events && <EventsSection client={client} />}
        <LogsSection client={client} />
      </div>
    </aside>
  );
}
