import { useState } from 'react';

import { type DeviceClient } from '@expo/hub-client';
import { LogControls } from './LogControls';
import { LogList } from './LogList';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

/** The selected simulator's output. Currently only the logs. */
export function OutputSection({ client }: { client?: DeviceClient }) {
  const logs = client?.logs ?? [];
  const logsEnabled = client?.logsEnabled ?? false;
  const [logsOpen, setLogsOpen] = useState(logsEnabled);

  function setLogsVisibility(next: boolean) {
    setLogsOpen(next);
    if (next) client?.attachLogs();
    else client?.detachLogs();
  }

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}>
      <div>
        <SidebarRow
          label="Logs"
          borderBottom={false}
          flushTop={client?.platform !== 'ios'}>
          <SidebarSwitch
            checked={logsOpen}
            disabled={!client}
            label="Logs"
            onChange={setLogsVisibility}
          />
        </SidebarRow>
      </div>
      {logsOpen && (
        <div style={{ marginInline: -24 }}>
          <LogControls
            count={logs.length}
            running={logsEnabled}
            onClear={() => client?.clearLogs()}
            onStart={() => client?.attachLogs()}
            onStop={() => client?.detachLogs()}
          />
          <LogList logs={logs} enabled={logsEnabled} />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }} />
    </section>
  );
}
