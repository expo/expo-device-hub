import { Button, bg, font, radius, text, textSize } from '../primitives';

/** Compact stream toolbar for pausing, resuming, and clearing device logs. */
export function LogControls({
  count,
  running,
  onClear,
  onStart,
  onStop,
}: {
  count: number;
  running: boolean;
  onClear: () => void;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 20px',
        backgroundColor: bg.subtle,
      }}>
      <span
        style={{
          ...textSize['2xs'],
          flex: 1,
          fontFamily: font.mono,
          fontWeight: 400,
          color: text.tertiary,
        }}>
        {count} {count === 1 ? 'line' : 'lines'}
      </span>
      <Button
        size="2xs"
        theme="secondary"
        onClick={running ? onStop : onStart}
        style={{ borderRadius: radius.full, paddingInline: 14 }}>
        {running ? 'Stop' : 'Start'}
      </Button>
      <Button
        size="2xs"
        theme="secondary"
        disabled={count === 0}
        onClick={onClear}
        style={{ borderRadius: radius.full, paddingInline: 14 }}>
        Clear
      </Button>
    </div>
  );
}
