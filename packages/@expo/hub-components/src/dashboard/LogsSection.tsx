import { FeatureNotice } from './FeatureNotice';
import { useEffect, useState } from 'react';

import { type DeviceClient } from '@expo/hub-client';
import { CollapsibleSection } from './CollapsibleSection';
import { LogControls } from './LogControls';
import { LogList } from './LogList';

/** Device syslog/logcat output in its own collapsible inspector section. */
export function LogsSection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(false);
  const logs = client?.logs.data ?? [];
  const enabled = client?.logs.enabled ?? false;
  const attachLogs = client?.logs.attach;
  const detachLogs = client?.logs.detach;

  useEffect(() => {
    if (open) attachLogs?.();
    else detachLogs?.();

    return () => detachLogs?.();
  }, [attachLogs, detachLogs, open]);

  return (
    <CollapsibleSection title="Logs" open={open} onOpenChange={setOpen}>
      {client && <FeatureNotice feature={client.logs} />}
      <LogControls
        count={logs.length}
        running={enabled}
        onClear={() => client?.logs.clear()}
        onStart={() => client?.logs.attach()}
        onStop={() => client?.logs.detach()}
      />
      <LogList logs={logs} enabled={enabled} />
    </CollapsibleSection>
  );
}
