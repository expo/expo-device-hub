import { type CSSProperties, useEffect, useRef } from 'react';

import { type DeviceLog } from '@expo/hub-client';
import { text, textSize } from '../primitives';
import { LogRow } from './LogRow';

// An always-visible, styled scrollbar. Styling `::-webkit-scrollbar` opts out of
// the macOS overlay (auto-hiding) scrollbar in Chromium. We intentionally do NOT
// set the standard `scrollbar-width` / `scrollbar-color` props: setting either
// makes Chromium fall back to the standard auto-hiding overlay scrollbar.
const SCROLLBAR_CSS = `
.hub-log-scroll::-webkit-scrollbar { width: 12px; }
.hub-log-scroll::-webkit-scrollbar-track { background: transparent; }
.hub-log-scroll::-webkit-scrollbar-thumb {
  background-color: var(--expo-theme-background-selected);
  border-radius: 8px;
  border: 3px solid transparent;
  background-clip: padding-box;
  min-height: 24px;
}
.hub-log-scroll::-webkit-scrollbar-thumb:hover {
  background-color: var(--expo-theme-border-default);
}
`;

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  // Gutters so the row hover highlight can bleed without shifting content or
  // adding a horizontal scrollbar.
  margin: '0 -8px',
  padding: '0 8px',
  // The rolling buffer trims lines off the top; without this the browser's
  // scroll anchoring fights our tail-follow by nudging scrollTop on each trim.
  overflowAnchor: 'none',
};

/**
 * Scrollable log output with an always-visible styled scrollbar. Lines run
 * oldest → newest (top → bottom); the view sticks to the tail as new lines
 * arrive while the user is at the bottom.
 */
export function LogList({ logs = [], enabled = false }: { logs?: DeviceLog[]; enabled?: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // New lines arrive at the bottom; while attached we follow the tail so the
  // newest line stays in view. The stream stops on Detach (lines are kept), so
  // detaching is how you pause to scroll back through history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const emptyMessage = enabled
    ? 'Waiting for device logs…'
    : 'Logs are paused. Press Attach to stream device logs.';

  return (
    <div ref={scrollRef} className="hub-log-scroll" style={scrollStyle}>
      <style>{SCROLLBAR_CSS}</style>
      {logs.length === 0 ? (
        <span style={{ ...textSize.xs, fontWeight: 500, color: text.tertiary, paddingLeft: 8 }}>
          {emptyMessage}
        </span>
      ) : (
        logs.map((entry) => <LogRow key={entry.id} entry={entry} />)
      )}
    </div>
  );
}
