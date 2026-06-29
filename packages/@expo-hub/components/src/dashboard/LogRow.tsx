import { useState } from 'react';

import { bg, font, radius, text } from '../primitives';
import { type LogEntry } from './data';

/** A single log line: a monospace source chip followed by the message. */
export function LogRow({ entry }: { entry: LogEntry }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '4px 8px',
        margin: '0 -8px',
        borderRadius: radius.md,
        backgroundColor: hovered ? bg.element : 'transparent',
        transition: 'background-color 150ms ease',
      }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 4,
          borderRadius: radius.sm,
          backgroundColor: bg.element,
          fontFamily: font.mono,
          fontSize: 10,
          lineHeight: 1,
          letterSpacing: '-0.02em',
          color: text.tertiary,
          flexShrink: 0,
        }}>
        {entry.source}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 500,
          lineHeight: 1.6,
          color: text.tertiary,
          overflowWrap: 'anywhere',
        }}>
        {entry.message}
      </span>
    </div>
  );
}
