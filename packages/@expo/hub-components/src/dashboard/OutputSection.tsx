import { type DeviceClient } from '@expo/hub-client';
import { border } from '../primitives';
import { LogControls } from './LogControls';
import { LogList } from './LogList';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

/** The selected simulator's output. Currently only the logs. */
export function OutputSection({ client }: { client?: DeviceClient }) {
  const logs = client?.logs ?? [];
  const logsEnabled = client?.logsEnabled ?? false;

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
      }}>
      <div style={{ padding: '0 20px' }}>
        <SidebarRow label="Logs" borderBottom={logsEnabled}>
          <SidebarSwitch
            checked={logsEnabled}
            disabled={!client}
            label="Logs"
            onChange={(next) => (next ? client?.attachLogs() : client?.detachLogs())}
          />
        </SidebarRow>
      </div>
      {logsEnabled && (
        <>
          <LogControls count={logs.length} onClear={() => client?.clearLogs()} />
          <LogList logs={logs} enabled />
        </>
      )}
      <div style={{ flex: 1, minHeight: 0, borderTop: `1px solid ${border.secondary}` }} />
    </section>
  );
}
