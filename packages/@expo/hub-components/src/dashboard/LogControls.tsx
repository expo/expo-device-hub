import { bg, font, text, textSize } from '../primitives';
import { SidebarActionButton } from './SidebarActionButton';

/** Compact stream toolbar for pausing, resuming, and clearing device logs. */
export function LogControls({
  count,
  running,
  unit = 'line',
  onClear,
  onStart,
  onStop,
}: {
  count: number;
  running: boolean;
  unit?: string;
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
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        backgroundColor: bg.subtle,
      }}>
      <span
        style={{
          ...textSize['2xs'],
          flex: 1,
          minWidth: 0,
          fontFamily: font.mono,
          fontWeight: 400,
          color: text.tertiary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
        {count} {count === 1 ? unit : `${unit}s`}
      </span>
      <SidebarActionButton onClick={running ? onStop : onStart}>
        {running ? 'Stop' : 'Start'}
      </SidebarActionButton>
      <SidebarActionButton disabled={count === 0} onClick={onClear}>
        Clear
      </SidebarActionButton>
    </div>
  );
}
