import { Logo, SidebarToggle, bg } from "../primitives";
import { DeviceSection } from "./DeviceSection";
import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
  type Platform,
} from "./data";

/** Virtual and physical devices in separate groups. Device output lives in {@link LogSidebar}. */
export function Sidebar({
  simulators,
  emulators,
  recentSimulators,
  recentEmulators,
  simulatorOptions,
  emulatorOptions,
  agentDeviceIds = [],
  selectedId,
  onSelect,
  onAddDevice,
  onToggle,
  platform,
  width = 400,
}: {
  /** Running iOS simulators and connected physical iOS devices. */
  simulators: Device[];
  /** Running Android emulators and connected physical Android devices. */
  emulators: Device[];
  /** Shut-down simulators offered in the add-simulator picker. */
  recentSimulators: Device[];
  /** Shut-down emulators offered in the add-emulator picker. */
  recentEmulators: Device[];
  /** Installed iOS runtimes and their compatible simulator models. */
  simulatorOptions: NewDeviceOptions;
  /** Installed Android system images and compatible emulator profiles. */
  emulatorOptions: NewDeviceOptions;
  /** Devices with an unexpired Argent interaction. */
  agentDeviceIds?: readonly string[];
  selectedId: string;
  onSelect: (id: string) => void;
  /** Starts the existing or new device chosen in either add-device picker. */
  onAddDevice?: (target: AddDeviceTarget) => Promise<AddDeviceOutcome>;
  /** When set, a sidebar toggle is shown right-aligned in the logo row. */
  onToggle?: () => void;
  /** Restrict the sidebar to one platform. Both sections render by default. */
  platform?: Platform;
  /** Column width in px, driven by the resize handle. Defaults to 400. */
  width?: number;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 32,
        width: `min(${width}px, 100vw)`,
        flexShrink: 0,
        height: "100vh",
        boxSizing: "border-box",
        padding: "32px 24px",
        backgroundColor: bg.default,
        overflowX: "hidden",
        overflowY: "auto",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <Logo />
        {onToggle && <SidebarToggle onClick={onToggle} />}
      </div>
      {platform !== "android" && (
        <DeviceSection
          title="Simulators"
          addLabel="Add simulator"
          kind="simulator"
          emptyLabel={
            onAddDevice
              ? "No booted simulators. Use the + button to add one."
              : "No booted simulators."
          }
          devices={simulators.filter((device) => !device.physical)}
          recent={recentSimulators}
          options={simulatorOptions}
          agentDeviceIds={agentDeviceIds}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAddDevice}
        />
      )}
      {platform !== "ios" && (
        <DeviceSection
          title="Emulators"
          addLabel="Add emulator"
          kind="emulator"
          emptyLabel={
            onAddDevice
              ? "No booted emulators. Use the + button to add one."
              : "No booted emulators."
          }
          devices={emulators.filter((device) => !device.physical)}
          recent={recentEmulators}
          options={emulatorOptions}
          agentDeviceIds={agentDeviceIds}
          selectedId={selectedId}
          onSelect={onSelect}
          onAdd={onAddDevice}
        />
      )}
      {platform !== "android" && (
        <DeviceSection
          title="iOS Devices"
          addLabel=""
          kind="simulator"
          emptyLabel="No connected iOS devices."
          devices={simulators.filter((device) => device.physical)}
          recent={[]}
          options={simulatorOptions}
          agentDeviceIds={agentDeviceIds}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
      {platform !== "ios" && (
        <DeviceSection
          title="Android Devices"
          addLabel=""
          kind="emulator"
          emptyLabel="No connected Android devices."
          devices={emulators.filter((device) => device.physical)}
          recent={[]}
          options={emulatorOptions}
          agentDeviceIds={agentDeviceIds}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </aside>
  );
}
