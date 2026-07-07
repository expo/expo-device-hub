import { useState } from 'react';

import { type DeviceClient } from '@expo/hub-client';
import { type TabKey } from './data';
import { LogControls } from './LogControls';
import { LogList } from './LogList';
import { TabBar } from './TabBar';

/** The selected simulator's output. Currently only the Logs tab. */
export function OutputSection({ client }: { client?: DeviceClient }) {
  const [active, setActive] = useState<TabKey>('logs');

  const logs = client?.logs;
  const logsEnabled = client?.logsEnabled ?? false;

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
      <LogControls
        enabled={logsEnabled}
        hasLogs={(logs?.length ?? 0) > 0}
        onAttach={() => client?.attachLogs()}
        onDetach={() => client?.detachLogs()}
        onClear={() => client?.clearLogs()}
      />
      <LogList logs={logs} enabled={logsEnabled} />
    </section>
  );
}
