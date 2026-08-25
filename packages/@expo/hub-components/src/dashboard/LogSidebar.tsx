import {
  type DeviceClient,
  type DeviceHttpCodec,
  type DeviceStreamMode,
} from '@expo/hub-client';
import { SidebarToggle } from '../primitives';
import { ActivitySection } from './ActivitySection';
import { CurrentAppSection } from './CurrentAppSection';
import { DeviceOptionsSection } from './DeviceOptionsSection';
import { EventsSection } from './EventsSection';
import { LogsSection } from './LogsSection';
import { StreamOptionsSection } from './StreamOptionsSection';
import { type StreamModeAvailability } from './StreamSection';

export type LogSidebarProps = {
  /** When set, a sidebar toggle is shown to collapse this panel. */
  onToggle?: () => void;
  /** Active device connection — feeds the inspector sections. */
  client?: DeviceClient;
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
  /** Column width in px, driven by the resize handle. Defaults to 400. */
  width?: number;
};

/**
 * Right column: a compact inspector for the selected device, rendered directly
 * on the dashboard canvas so it matches the existing sidebar treatment.
 */
export function LogSidebar({
  onToggle,
  client,
  streamMode,
  httpCodec,
  streamModeAvailability,
  onStreamModeChange,
  onHttpCodecChange,
  width = 400,
}: LogSidebarProps) {
  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: `min(${width}px, 100vw)`,
        flexShrink: 0,
        height: '100vh',
        boxSizing: 'border-box',
        gap: 12,
        padding: '32px 24px',
        overflow: 'hidden',
      }}>
      {onToggle && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
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
        {client?.capabilities.deviceSettings && <DeviceOptionsSection client={client} />}
        {client?.capabilities.activity && <ActivitySection client={client} />}
        {client?.capabilities.events && <EventsSection client={client} />}
        {client?.capabilities.streamSettings && (
          <StreamOptionsSection
            client={client}
            streamMode={streamMode}
            httpCodec={httpCodec}
            streamModeAvailability={streamModeAvailability}
            onStreamModeChange={onStreamModeChange}
            onHttpCodecChange={onHttpCodecChange}
          />
        )}
        <LogsSection client={client} />
      </div>
    </aside>
  );
}
