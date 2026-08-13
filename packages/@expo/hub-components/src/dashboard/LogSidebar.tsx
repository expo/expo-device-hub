import { type DeviceClient, type DeviceStreamMode } from '@expo/hub-client';
import { SidebarToggle } from '../primitives';
import { CurrentAppSection } from './CurrentAppSection';
import { KeyboardSection } from './KeyboardSection';
import { OutputSection } from './OutputSection';
import { SidebarSectionHeading } from './SidebarRow';
import { StreamSection, type StreamModeAvailability } from './StreamSection';

/**
 * Right column: a compact inspector for the selected device, rendered directly
 * on the dashboard canvas so it matches the existing sidebar treatment.
 */
export function LogSidebar({
  onToggle,
  client,
  streamMode,
  streamModeAvailability,
  onStreamModeChange,
  width = 400,
}: {
  /** When set, a sidebar toggle is shown to collapse this panel. */
  onToggle?: () => void;
  /** Active device connection — feeds the current-app and logs panels. */
  client?: DeviceClient;
  /** Viewer-selected simulator stream mode. */
  streamMode?: DeviceStreamMode;
  /** Which modes the current browser context can use. */
  streamModeAvailability?: StreamModeAvailability;
  /** Change the viewer-local stream mode. */
  onStreamModeChange?: (mode: DeviceStreamMode) => void;
  /** Column width in px, driven by the resize handle. Defaults to 400. */
  width?: number;
}) {
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
          overflow: 'hidden',
        }}>
        <CurrentAppSection client={client} />
        <div style={{ paddingBottom: 4 }}>
          <SidebarSectionHeading>Device options</SidebarSectionHeading>
        </div>
        {client?.platform === 'ios' && <KeyboardSection client={client} />}
        {streamMode &&
          streamModeAvailability &&
          onStreamModeChange &&
          client?.platform === 'ios' && (
            <StreamSection
              mode={streamMode}
              availability={streamModeAvailability}
              onChange={onStreamModeChange}
            />
          )}
        <OutputSection client={client} />
      </div>
    </aside>
  );
}
