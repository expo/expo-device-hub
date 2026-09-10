import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { NOOP_DEVICE_CLIENT } from '../../../@expo/hub-client/src/useNoopDeviceClient';
import { LogSidebar } from '../../../@expo/hub-components/src/dashboard/LogSidebar';
import { RightSidebar } from '../../src/dashboard/RightSidebar';

const entries = Array.from({ length: 100 }, (_, index) => ({
  id: String(index),
  source: 'test',
  message: `Entry ${index}`,
}));
const client = {
  ...NOOP_DEVICE_CLIENT,
  capabilities: { ...NOOP_DEVICE_CLIENT.capabilities, events: true },
  logs: entries,
  events: entries.map((entry) => ({ ...entry, timestamp: '2026-09-10T00:00:00Z', kind: 'test' })),
} satisfies typeof NOOP_DEVICE_CLIENT;

function Fixture() {
  const [open, setOpen] = useState(true);
  const [rows, setRows] = useState(entries);
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div>
        <button onClick={() => setOpen(!open)}>Toggle inspector</button>
        <button onClick={() => setRows([...rows, { id: String(rows.length), source: 'test', message: 'New entry' }])}>
          Append log
        </button>
      </div>
      <RightSidebar open={open} overlay={false} topmost width={400} resizing={false} onDismiss={() => setOpen(false)}>
        <LogSidebar client={{ ...client, logs: rows }} />
      </RightSidebar>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
