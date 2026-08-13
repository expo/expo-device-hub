import { bg, font, text, textSize } from '../primitives';
import { SidebarActionButton } from './SidebarActionButton';

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
      <SidebarActionButton onClick={running ? onStop : onStart}>
        {running ? 'Stop' : 'Start'}
      </SidebarActionButton>
      <SidebarActionButton disabled={count === 0} onClick={onClear}>
        Clear
      </SidebarActionButton>
    </div>
  );
}
