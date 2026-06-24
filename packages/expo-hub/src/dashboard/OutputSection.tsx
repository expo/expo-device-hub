import { useState } from 'react';

import { type DeviceLog } from '../device';
import { text, textSize } from '../../theme/tokens';
import { type TabKey } from './data';
import { LogList } from './LogList';
import { TabBar } from './TabBar';

/** The selected simulator's output: Logs / Network / Settings tabs. */
export function OutputSection({ logs }: { logs?: DeviceLog[] }) {
  const [active, setActive] = useState<TabKey>('logs');

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        flex: 1,
        minHeight: 0,
      }}>
      <TabBar active={active} onChange={setActive} />
      {active === 'logs' ? (
        <LogList logs={logs} />
      ) : (
        <span style={{ ...textSize.xs, fontWeight: 500, color: text.tertiary, paddingLeft: 16 }}>
          No {active} data for this simulator.
        </span>
      )}
    </section>
  );
}
