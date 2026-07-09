import { type DeviceClient } from '@expo/hub-client';
import { text, textSize } from '../primitives';
import { LogControls } from './LogControls';
import { LogList } from './LogList';

/** The selected simulator's output. Currently only the logs. */
export function OutputSection({ client }: { client?: DeviceClient }) {
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
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Logs</span>
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
