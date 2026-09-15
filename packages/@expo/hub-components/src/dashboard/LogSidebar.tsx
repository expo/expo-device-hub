import { memo, useEffect, useRef } from 'react';

import { type DeviceClient, type DeviceHttpCodec, type DeviceStreamMode } from '@expo/hub-client';
import { SidebarToggle, bg } from '../primitives';
import { CameraSection } from './CameraSection';
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
  /** Preserve inspector options while the selected device is offline. */
  available?: boolean;
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
 */
export const LogSidebar = memo(function LogSidebar({
  onToggle,
  client,
  device,
  available = true,
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
  const lastClient = useRef<{ deviceId: string; client: DeviceClient } | null>(null);
  useEffect(() => {
    if (available && device && client) {
      lastClient.current = { deviceId: device.id, client };
    } else if (lastClient.current?.deviceId !== device?.id) {
      lastClient.current = null;
    }
  }, [available, client, device]);
  // The connection hook resets on disconnect. Retain the selected device's
  // metadata and values so the same inspector sections and rows stay in place.
  const inspectorClient =
    !available && lastClient.current?.deviceId === device?.id
      ? (lastClient.current?.client ?? client)
      : client;
  const deviceFrame = device
    ? {
        available: isDeviceFrameProfileId(device.deviceFrame),
        visible: showDeviceFrame,
        onVisibleChange: onShowDeviceFrameChange ?? (() => {}),
      }
    : undefined;
  // Physical devices cannot be deleted from the host.
  const onRemoveDevice = device?.physical ? undefined : onRemove;

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
        <CurrentAppSection client={inspectorClient} />
        {(inspectorClient?.capabilities.deviceSettings ||
          inspectorClient?.platform === 'android' ||
          deviceFrame ||
          (inspectorClient && (onShutdown || onRemoveDevice))) && (
          <DeviceOptionsSection
            client={inspectorClient}
            available={available}
            deviceFrame={deviceFrame}
            showDeviceSettings={inspectorClient?.capabilities.deviceSettings ?? false}
            onShutdown={onShutdown}
            onRemove={onRemoveDevice}
          />
        )}
        {inspectorClient?.streamCapabilities && (
          <StreamOptionsSection
            client={inspectorClient}
            available={available}
            streamMode={streamMode}
            httpCodec={httpCodec}
            streamModeAvailability={streamModeAvailability}
            onStreamModeChange={onStreamModeChange}
            onHttpCodecChange={onHttpCodecChange}
          />
        )}
        {inspectorClient?.capabilities.camera && (
          <CameraSection client={inspectorClient} available={available} />
        )}
        {inspectorClient?.capabilities.events && (
          <EventsSection client={inspectorClient} available={available} />
        )}
        <LogsSection client={inspectorClient} available={available} />
      </div>
    </aside>
  );
});
