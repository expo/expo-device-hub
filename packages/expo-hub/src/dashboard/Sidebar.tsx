import { type DeviceClient } from '../device';
import { Logo } from '../../components/Logo';
import { SidebarToggle } from '../../components/SidebarToggle';
import { type Device } from './data';
import { DeviceSection } from './DeviceSection';
import { OutputSection } from './OutputSection';

/** Left column: simulators + emulators lists and the output tabs. */
export function Sidebar({
  simulators,
  emulators,
  selectedId,
  onSelect,
  onToggle,
  client,
}: {
  /** Simulators to list — real iOS devices from the plugin server. */
  simulators: Device[];
  /** Emulators to list. */
  emulators: Device[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** When set, a sidebar toggle is shown right-aligned in the logo row. */
  onToggle?: () => void;
  /** Active device connection — feeds the logs panel and its controls. */
  client?: DeviceClient;
}) {
  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 32,
        width: 'min(400px, 100vw)',
        flexShrink: 0,
        height: '100vh',
        boxSizing: 'border-box',
        padding: '32px 24px 32px 48px',
        overflow: 'hidden',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Logo />
        {onToggle && <SidebarToggle onClick={onToggle} />}
      </div>
      <DeviceSection
        title="Simulators"
        addLabel="Add simulator"
        emptyLabel="No booted simulators. Use the + button to add one."
        devices={simulators}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <DeviceSection
        title="Emulators"
        addLabel="Add emulator"
        emptyLabel="No booted emulators or devices. Use the + button to add one."
        devices={emulators}
        selectedId={selectedId}
        onSelect={onSelect}
      />
      <OutputSection client={client} />
    </aside>
  );
}
