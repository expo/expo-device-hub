import { Button, bg, font, radius, text, textSize } from '../primitives';

/** Compact stream toolbar shown while device logs are attached. */
export function LogControls({
  count,
  onClear,
}: {
  count: number;
  onClear: () => void;
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
        disabled={count === 0}
        onClick={onClear}
        style={{ borderRadius: radius.full, paddingInline: 14 }}>
        Clear
      </Button>
    </div>
  );
}
