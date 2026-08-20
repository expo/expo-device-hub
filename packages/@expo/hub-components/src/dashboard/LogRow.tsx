import { bg, border, font, radius, text, textSize } from '../primitives';
import { type LogEntry } from './data';

/** A single log line: a monospace source chip followed by the message. */
export function LogRow({ entry }: { entry: LogEntry }) {
  const message = entry.message.length > 68 ? `${entry.message.slice(0, 68)}…` : entry.message;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 0',
        borderBottom: `1px solid ${border.secondary}`,
      }}>
      <span
        style={{
          ...textSize['2xs'],
          padding: '1px 5px',
          borderRadius: radius.sm,
          backgroundColor: bg.element,
          fontFamily: font.mono,
          color: text.tertiary,
          flexShrink: 0,
          marginTop: 1,
        }}>
        {entry.source}
      </span>
      <span
        title={entry.message}
        style={{
          ...textSize.xs,
          flex: 1,
          minWidth: 0,
          color: text.secondary,
          overflowWrap: 'anywhere',
        }}>
        {message}
      </span>
    </div>
  );
}
