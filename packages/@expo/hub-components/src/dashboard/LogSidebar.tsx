import { type DeviceClient } from '@expo/hub-client';
import { SidebarToggle } from '../primitives';
import { OutputSection } from './OutputSection';

/**
 * Right column: the selected device's output (currently Logs). Mirrors the
 * left {@link Sidebar} — same width, transparent over the `bg.subtle` canvas —
 * with its padding flipped so the wider gutter sits on the outer (right) edge.
 * The header holds a {@link SidebarToggle} on the inner edge to collapse it.
 */
export function LogSidebar({
  onToggle,
  client,
  width = 400,
}: {
  /** When set, a sidebar toggle is shown to collapse this panel. */
  onToggle?: () => void;
  /** Active device connection — feeds the logs panel and its controls. */
  client?: DeviceClient;
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
      <OutputSection client={client} />
    </aside>
  );
}
