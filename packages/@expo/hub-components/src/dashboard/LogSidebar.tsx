import { type DeviceClient, type DeviceStreamMode } from '@expo/hub-client';
import { SidebarToggle } from '../primitives';
import { CurrentAppSection } from './CurrentAppSection';
import { KeyboardSection } from './KeyboardSection';
import { OutputSection } from './OutputSection';
import { StreamSection, type StreamModeAvailability } from './StreamSection';

/**
 * Right column: the selected device's details (Current app + Stream + Logs).
 * Mirrors the left {@link Sidebar} — same width, transparent over the
 * `bg.subtle` canvas — with its padding flipped so the wider gutter sits on the outer (right) edge.
 * The header holds a {@link SidebarToggle} on the inner edge to collapse it.
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
        gap: 32,
        width: `min(${width}px, 100vw)`,
        flexShrink: 0,
        height: '100vh',
        boxSizing: 'border-box',
        // Mirror of the left sidebar's padding — wider gutter on the outer edge.
        padding: '32px 48px 32px 24px',
        overflow: 'hidden',
      }}>
      {onToggle && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start' }}>
          <SidebarToggle side="right" onClick={onToggle} />
        </div>
      )}
      <CurrentAppSection client={client} />
      {client?.platform === 'ios' && <KeyboardSection client={client} />}
      {streamMode && streamModeAvailability && onStreamModeChange && client?.platform === 'ios' && (
        <StreamSection
          mode={streamMode}
          availability={streamModeAvailability}
          onChange={onStreamModeChange}
        />
      )}
      <OutputSection client={client} />
    </aside>
  );
}
