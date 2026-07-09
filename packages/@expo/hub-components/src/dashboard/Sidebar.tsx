import { Logo, SidebarToggle } from '../primitives';
import { type Device, type NewDeviceOptions } from './data';
import { DeviceSection } from './DeviceSection';

/** Left column: simulators + emulators lists. The device output (logs) lives in {@link LogSidebar}. */
export function Sidebar({
  simulators,
  emulators,
  recentSimulators,
  recentEmulators,
  simulatorOptions,
  emulatorOptions,
  selectedId,
  onSelect,
  onAddDevice,
  onToggle,
}: {
  /** Simulators to list — real iOS devices from the plugin server. */
  simulators: Device[];
  /** Emulators to list. */
  emulators: Device[];
  /** Shut-down simulators offered in the add-simulator picker. */
  recentSimulators: Device[];
  /** Shut-down emulators offered in the add-emulator picker. */
  recentEmulators: Device[];
  /** Mocked OS versions + models for the "New simulator" form. */
  simulatorOptions: NewDeviceOptions;
  /** Mocked OS versions + models for the "New emulator" form. */
  emulatorOptions: NewDeviceOptions;
  selectedId: string;
  onSelect: (id: string) => void;
  /** Called with the device chosen in either add-device picker. */
  onAddDevice: (device: Device) => void;
  /** When set, a sidebar toggle is shown right-aligned in the logo row. */
  onToggle?: () => void;
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
        kind="simulator"
        emptyLabel="No booted simulators. Use the + button to add one."
        devices={simulators}
        recent={recentSimulators}
        options={simulatorOptions}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={onAddDevice}
      />
      <DeviceSection
        title="Emulators"
        addLabel="Add emulator"
        kind="emulator"
        emptyLabel="No booted emulators or devices. Use the + button to add one."
        devices={emulators}
        recent={recentEmulators}
        options={emulatorOptions}
        selectedId={selectedId}
        onSelect={onSelect}
        onAdd={onAddDevice}
      />
    </aside>
  );
}
