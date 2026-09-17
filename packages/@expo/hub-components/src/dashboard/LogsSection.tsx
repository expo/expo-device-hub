import { useEffect, useState } from 'react';

import { type DeviceClient } from '@expo/hub-client';
import { CollapsibleSection } from './CollapsibleSection';
import { LogControls } from './LogControls';
import { LogList } from './LogList';

/** Device syslog/logcat output in its own collapsible inspector section. */
export function LogsSection({
  client,
  available = true,
}: {
  client?: DeviceClient;
  available?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const logs = client?.logs ?? [];
  const enabled = available && (client?.logsEnabled ?? false);
  const attachLogs = client?.attachLogs;
  const detachLogs = client?.detachLogs;

  useEffect(() => {
    if (available && open) attachLogs?.();
    else detachLogs?.();

    return () => detachLogs?.();
  }, [attachLogs, available, detachLogs, open]);

  return (
    <CollapsibleSection title="Logs" open={open} onOpenChange={setOpen}>
      <LogControls
        count={logs.length}
        running={enabled}
        disabled={!available}
        onClear={() => client?.clearLogs()}
        onStart={() => client?.attachLogs()}
        onStop={() => client?.detachLogs()}
      />
      <LogList
        logs={logs}
        enabled={enabled}
        emptyMessage={
          available ? undefined : 'Device offline. Logs will be available when it reconnects.'
        }
      />
    </CollapsibleSection>
  );
}
