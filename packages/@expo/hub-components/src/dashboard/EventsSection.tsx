import { useEffect, useMemo, useState } from 'react';

import { type DeviceClient, type DeviceLog } from '@expo/hub-client';
import { CollapsibleSection } from './CollapsibleSection';
import { LogControls } from './LogControls';
import { LogList } from './LogList';

/** Touch, UI, and command events reported by the selected device backend. */
export function EventsSection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(false);
  const events = client?.events;
  const enabled = client?.eventsEnabled ?? false;
  const attachEvents = client?.attachEvents;
  const detachEvents = client?.detachEvents;
  const rows: ReadonlyArray<DeviceLog> = useMemo(
    () =>
      (events ?? []).map((event) => ({
        id: event.id,
        source: event.source,
        message: event.message,
      })),
    [events],
  );

  useEffect(() => {
    if (open) attachEvents?.();
    else detachEvents?.();

    return () => detachEvents?.();
  }, [attachEvents, detachEvents, open]);

  return (
    <CollapsibleSection title="Events" open={open} onOpenChange={setOpen}>
      <LogControls
        count={events?.length ?? 0}
        running={enabled}
        unit="event"
        onClear={() => client?.clearEvents()}
        onStart={() => client?.attachEvents()}
        onStop={() => client?.detachEvents()}
      />
      <LogList
        logs={rows}
        enabled={enabled}
        emptyMessage={
          enabled
            ? 'No events yet. Touch or interact with the device to see them here.'
            : 'Events are paused. Press Start to observe device events.'
        }
      />
    </CollapsibleSection>
  );
}
