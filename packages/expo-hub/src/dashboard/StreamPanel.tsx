import { bg } from '../../theme/tokens';
import { type Device } from './data';
import { PhoneFrame } from './PhoneFrame';
import { StreamControls } from './StreamControls';
import { type ColorScheme } from './useColorScheme';

/** Right panel: the selected device's stream and its controls, full height. */
export function StreamPanel({
  device,
  scheme,
  onToggleTheme,
}: {
  device: Device;
  scheme: ColorScheme;
  onToggleTheme: () => void;
}) {
  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 40,
        padding: 40,
        boxSizing: 'border-box',
        backgroundColor: bg.subtle,
        overflow: 'hidden',
      }}>
      <PhoneFrame platform={device.platform} />
      <StreamControls scheme={scheme} onToggleTheme={onToggleTheme} />
    </section>
  );
}
