import { type CSSProperties } from 'react';

import { logs } from './data';
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
};

/** Scrollable log output with an always-visible styled scrollbar. */
export function LogList() {
  return (
    <div className="hub-log-scroll" style={scrollStyle}>
      <style>{SCROLLBAR_CSS}</style>
      {logs.map((entry) => (
        <LogRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
