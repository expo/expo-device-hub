import { type CSSProperties } from 'react';

import { logs } from './data';
import { LogRow } from './LogRow';

// A real, draggable native scrollbar styled to look like the macOS overlay
// scrollbar: a rounded thumb with a small gutter, no visible track.
const SCROLLBAR_CSS = `
.hub-log-scroll::-webkit-scrollbar { width: 12px; }
.hub-log-scroll::-webkit-scrollbar-track { background: transparent; }
.hub-log-scroll::-webkit-scrollbar-thumb {
  background-color: var(--expo-theme-background-selected);
  border-radius: 8px;
  border: 3px solid transparent;
  background-clip: padding-box;
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
  // Firefox
  scrollbarWidth: 'thin',
  scrollbarColor: 'var(--expo-theme-background-selected) transparent',
};

/** Scrollable log output with a styled native scrollbar. */
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
