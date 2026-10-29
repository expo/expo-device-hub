import { type ReactNode } from "react";

import { Logo, SidebarToggle, bg } from "../primitives";
import { DeviceSection } from "./DeviceSection";
import {
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
  type NewDeviceOptions,
  type Platform,
} from "./data";

/** Horizontal inset of the header and the device lists. */
const SIDEBAR_PADDING = 24;

/**
 * Left column: simulators + emulators lists, then `children` below them. The
 * dashboard passes the device inspector as `children`, so it scrolls with the lists.
 */
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
  children,
}: {
  /** Simulators to list — real iOS devices from the plugin server. */
  simulators: Device[];
  /** Emulators to list. */
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
  /** Rendered below the device lists, edge to edge, in the same scrolling area. */
  children?: ReactNode;
}) {
  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        width: `min(${width}px, 100vw)`,
        flexShrink: 0,
        height: "var(--hub-viewport-height, 100vh)",
        boxSizing: "border-box",
        padding: "32px 0 0",
        backgroundColor: bg.default,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: `0 ${SIDEBAR_PADDING}px 32px`,
        }}
      >
        <Logo />
        {onToggle && <SidebarToggle onClick={onToggle} />}
      </div>
      <div
        style={{
          display: "flex",
          flex: 1,
          minHeight: 0,
          flexDirection: "column",
          overflowX: "hidden",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 32,
            padding: `0 ${SIDEBAR_PADDING}px ${SIDEBAR_PADDING}px`,
          }}
        >
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
              devices={simulators}
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
                  ? "No booted emulators or devices. Use the + button to add one."
                  : "No booted emulators or devices."
              }
              devices={emulators}
              recent={recentEmulators}
              options={emulatorOptions}
              agentDeviceIds={agentDeviceIds}
              selectedId={selectedId}
              onSelect={onSelect}
              onAdd={onAddDevice}
            />
          )}
        </div>
        {children}
      </div>
    </aside>
  );
}
