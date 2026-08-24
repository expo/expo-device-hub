'use dom';

import '@expo/hub-components/theme.css';
import '../global.css';
import {
  DeviceScreen,
  displayScreen,
  useActiveDeviceClient,
  type DeviceStreamMode,
} from '@expo/hub-client';
import {
  EmptyState,
  LogSidebar,
  ResizeHandle,
  Sidebar,
  StreamPanel,
  type StreamModeAvailability,
  bg,
  text,
  type AddDeviceOutcome,
  type AddDeviceTarget,
  type Device,
} from '@expo/hub-components';
import { useEffect, useMemo, useRef } from 'react';

import { AnimatedDockedSidebar } from './dashboard/AnimatedDockedSidebar';
import { basePath } from './dashboard/basePath';
import { bootDevice, createDevice, removeDevice, shutdownDevice } from './dashboard/deviceActions';
import { DEFAULT_SIDEBAR_WIDTH, useDashboardStore } from './dashboard/dashboardStore';
import {
  useHideUnsupportedDevices,
  visibleDevices,
  visibleNewDeviceOptions,
} from './dashboard/deviceVisibility';
import { useColorScheme } from './dashboard/useColorScheme';
import { useDeviceLists } from './dashboard/useDevices';
import {
  FloatingSidebarToggle,
  floatingSidebarToggleInset,
} from './dashboard/FloatingSidebarToggle';
import { useNewDeviceOptions } from './dashboard/useNewDeviceOptions';
import { SidebarOverlay } from './dashboard/SidebarOverlay';
import { useSidebarLayout } from './dashboard/useSidebarLayout';
import { browserStreamModeAvailability } from './dashboard/streamMode';
import { dashboardPlatformFilter } from './platform-filter';

/** Append `extra` devices not already present in `base` (deduped by id). */
function mergeById(base: Device[], extra: Device[]): Device[] {
  const ids = new Set(base.map((device) => device.id));
  return [...base, ...extra.filter((device) => !ids.has(device.id))];
}

// Resizable-sidebar bounds. Each column starts at the original fixed width and
// can be dragged between MIN and MAX — never so wide that the stream, alongside
// the other sidebar, is squeezed below MIN_STREAM.
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 560;
const MIN_STREAM_WIDTH = 320;

/**
 * Clamp a dragged sidebar width to `[MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH]`, and
 * also cap it so the stream keeps at least `MIN_STREAM_WIDTH` next to the other
 * sidebar (`otherWidth` is 0 when that sidebar is collapsed/overlaid).
 */
function clampSidebarWidth(width: number, otherWidth: number): number {
  const viewport = typeof window === 'undefined' ? Infinity : window.innerWidth;
  const roomCap = viewport - otherWidth - MIN_STREAM_WIDTH;
  const upper = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, roomCap));
  return Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), upper);
}

/**
 * The single Expo Hub screen, authored as an Expo DOM component (`'use dom'`) so
 * it renders with web primitives and real CSS. Left: simulators + emulators.
 * Center: the stream of the selected device. Right: the output (logs) for
 * that device. Hub's own dark mode follows the system setting via `dark-theme`;
 * the stream's Theme control flips the *device's* appearance, not Hub's.
 *
 * Sidebars dock whenever their measured widths leave enough room for the stream
 * and become toggleable overlays otherwise.
 */
export default function Dashboard(_props: { dom?: import('expo/dom').DOMProps }) {
  const scheme = useColorScheme();
  const platform = dashboardPlatformFilter();
  const { booted, recent } = useDeviceLists();
  // Installed runtimes/system images and models for the new-device forms.
  const newDeviceOptions = useNewDeviceOptions();
  const hideUnsupportedDevices = useHideUnsupportedDevices();
  const selectedId = useDashboardStore((state) => state.selectedDeviceId);
  const selectDevice = useDashboardStore((state) => state.selectDevice);
  const reconcileSelectedDevice = useDashboardStore(
    (state) => state.reconcileSelectedDevice
  );
  // Devices started through the picker are retained until host discovery catches up.
  const added = useDashboardStore((state) => state.addedDevices);
  const trackAddedDevice = useDashboardStore((state) => state.trackAddedDevice);
  const dismissDevice = useDashboardStore((state) => state.dismissDevice);
  const streamModeAvailability = useMemo<StreamModeAvailability>(
    browserStreamModeAvailability,
    []
  );
  const streamMode = useDashboardStore((state) => state.streamMode);
  const chooseStreamMode = useDashboardStore((state) => state.chooseStreamMode);
  const handleStreamModeChange = (mode: DeviceStreamMode) => {
    chooseStreamMode(mode, streamModeAvailability);
  };
  // Draggable widths for each inline sidebar. The `*Start` refs snapshot the
  // width when a drag begins so each move re-derives width from the start point
  // (delta-from-start), which clamps cleanly without drifting.
  const sidebarWidth = useDashboardStore((state) => state.sidebarWidths.left);
  const logsWidth = useDashboardStore((state) => state.sidebarWidths.right);
  const resizeSidebar = useDashboardStore((state) => state.resizeSidebar);
  const sidebarWidthStart = useRef(DEFAULT_SIDEBAR_WIDTH);
  const logsWidthStart = useRef(DEFAULT_SIDEBAR_WIDTH);
  const sidebars = useSidebarLayout({
    leftWidth: sidebarWidth,
    rightWidth: logsWidth,
    minStreamWidth: MIN_STREAM_WIDTH,
  });

  // Merge booted devices (from the server) with any the user added, deduped by
  // id and split back into the two sections by platform.
  const simulators = useMemo(
    () =>
      platform === 'android'
        ? []
        : mergeById(
            booted.simulators,
            added.filter((device) => device.platform === 'ios')
          ),
    [booted.simulators, added, platform]
  );
  const emulators = useMemo(
    () =>
      platform === 'ios'
        ? []
        : mergeById(
            booted.emulators,
            added.filter((device) => device.platform === 'android')
          ),
    [booted.emulators, added, platform]
  );
  // The browser flag affects only shut-down recents and creation choices. Every
  // running device remains visible in the sidebar, including untested models.
  const recentSimulators = useMemo(
    () => visibleDevices(recent.simulators, hideUnsupportedDevices),
    [recent.simulators, hideUnsupportedDevices]
  );
  const recentEmulators = useMemo(
    () => visibleDevices(recent.emulators, hideUnsupportedDevices),
    [recent.emulators, hideUnsupportedDevices]
  );
  const simulatorOptions = useMemo(
    () => visibleNewDeviceOptions(newDeviceOptions.ios, hideUnsupportedDevices),
    [newDeviceOptions.ios, hideUnsupportedDevices]
  );
  const emulatorOptions = useMemo(
    () => visibleNewDeviceOptions(newDeviceOptions.android, hideUnsupportedDevices),
    [newDeviceOptions.android, hideUnsupportedDevices]
  );

  // Create/boot the chosen target on the host. The modal awaits this result, so
  // it stays open during slow Android boots and can show failures in context.
  async function handleAddDevice(target: AddDeviceTarget): Promise<AddDeviceOutcome> {
    const result =
      target.kind === 'new'
        ? await createDevice(target.device)
        : target.device.booted
          ? { id: target.device.id, error: null }
          : await bootDevice(target.device);

    if (!result.id) {
      return { ok: false, error: result.error ?? 'The device did not come online.' };
    }

    const device: Device =
      target.kind === 'new'
        ? {
            id: result.id,
            name: target.device.name,
            version: target.device.version,
            platform: target.device.platform,
            physical: false,
            booted: true,
            supported: target.device.supported,
            lastUsedAt: Date.now(),
          }
        : { ...target.device, id: result.id, booted: true, lastUsedAt: Date.now() };

    const replacedIds =
      target.kind === 'new'
        ? [target.device.name, result.id]
        : [target.device.name, target.device.id, result.id];
    trackAddedDevice(device, replacedIds);
    return { ok: true };
  }

  // Shut down / remove the selected device on the host, then drop it from the
  // UI. The device leaves the polled booted list within a tick, and the
  // selection effect re-selects the next device (or falls back to EmptyState).
  async function handleShutdown(device: Device) {
    await shutdownDevice(device);
    dismissDevice(device.id);
  }

  async function handleRemove(device: Device) {
    await removeDevice(device);
    dismissDevice(device.id);
  }

  // Mirror the theme onto the document root so Radix portals (e.g. the dropdown
  // menu), which mount on document.body outside the wrapper below, still pick up
  // the dark `--expo-theme-*` variables.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark-theme', scheme === 'dark');
    return () => root.classList.remove('dark-theme');
  }, [scheme]);

  // Keep a valid selection — default to the first device once the list loads.
  // Selecting a device streams it (its helper is attached on demand); the
  // sidebar lists only booted devices, so the default selection streams an
  // already-running sim and never boots anything.
  useEffect(() => {
    const devices = [...simulators, ...emulators];
    reconcileSelectedDevice(devices.map((device) => device.id));
  }, [simulators, emulators, reconcileSelectedDevice]);

  const devices = [...simulators, ...emulators];
  const selected = devices.find((device) => device.id === selectedId) ?? devices[0];

  // One shared connection to the serve-sim/serve-emu server, wired to the
  // selected device. Null until the user picks one, so nothing connects (or
  // boots) on load.
  const client = useActiveDeviceClient(
    selected ? { platform: selected.platform, device: selected.id, streamMode } : null,
    basePath()
  );

  return (
    <div
      ref={sidebars.containerRef}
      className={scheme === 'dark' ? 'dark-theme' : undefined}
      style={{
        display: 'flex',
        position: 'relative',
        flex: 1,
        width: '100%',
        minWidth: 0,
        height: '100vh',
        boxSizing: 'border-box',
        backgroundColor: bg.subtle,
        color: text.default,
        fontFamily: 'var(--expo-font-sans)',
        overflow: 'hidden',
      }}>
      <AnimatedDockedSidebar
        side="left"
        width={sidebarWidth}
        open={sidebars.leftDocked}
        sidebarOpen={sidebars.leftOpen}>
        <Sidebar
          simulators={simulators}
          emulators={emulators}
          recentSimulators={recentSimulators}
          recentEmulators={recentEmulators}
          simulatorOptions={simulatorOptions}
          emulatorOptions={emulatorOptions}
          selectedId={selectedId}
          onSelect={selectDevice}
          onAddDevice={handleAddDevice}
          onToggle={sidebars.closeLeft}
          platform={platform}
          width={sidebarWidth}
        />
      </AnimatedDockedSidebar>
      {sidebars.leftDocked && (
        <ResizeHandle
          side="left"
          offset={sidebarWidth}
          onResizeStart={() => {
            sidebarWidthStart.current = sidebarWidth;
          }}
          onResize={(delta) =>
            resizeSidebar(
              'left',
              clampSidebarWidth(
                sidebarWidthStart.current + delta,
                sidebars.rightDocked ? logsWidth : 0
              )
            )
          }
        />
      )}

      {selected ? (
        <StreamPanel
          device={selected}
          client={client}
          DeviceScreen={DeviceScreen}
          displayScreen={displayScreen}
          onShutdown={() => handleShutdown(selected)}
          onRemove={() => handleRemove(selected)}
          framed={sidebars.containerWidth >= MIN_SIDEBAR_WIDTH + MIN_STREAM_WIDTH}
        />
      ) : (
        <EmptyState platform={platform} />
      )}

      {sidebars.rightDocked && (
        <ResizeHandle
          side="right"
          offset={logsWidth}
          onResizeStart={() => {
            logsWidthStart.current = logsWidth;
          }}
          onResize={(delta) =>
            resizeSidebar(
              'right',
              clampSidebarWidth(
                logsWidthStart.current + delta,
                sidebars.leftDocked ? sidebarWidth : 0
              )
            )
          }
        />
      )}
      <AnimatedDockedSidebar
        side="right"
        width={logsWidth}
        open={sidebars.rightDocked}
        sidebarOpen={sidebars.rightOpen}>
        <LogSidebar
          client={client}
          streamMode={streamMode}
          streamModeAvailability={streamModeAvailability}
          onStreamModeChange={handleStreamModeChange}
          onToggle={sidebars.closeRight}
          width={logsWidth}
        />
      </AnimatedDockedSidebar>

      <SidebarOverlay
        side="left"
        open={sidebars.leftOverlay}
        sidebarOpen={sidebars.leftOpen}
        topmost={sidebars.lastOpened === 'left' || !sidebars.rightOverlay}
        onDismiss={sidebars.closeLeft}>
        <Sidebar
          simulators={simulators}
          emulators={emulators}
          recentSimulators={recentSimulators}
          recentEmulators={recentEmulators}
          simulatorOptions={simulatorOptions}
          emulatorOptions={emulatorOptions}
          selectedId={selectedId}
          onSelect={selectDevice}
          onAddDevice={handleAddDevice}
          onToggle={sidebars.closeLeft}
          platform={platform}
          width={sidebarWidth}
        />
      </SidebarOverlay>

      <SidebarOverlay
        side="right"
        open={sidebars.rightOverlay}
        sidebarOpen={sidebars.rightOpen}
        topmost={sidebars.lastOpened === 'right' || !sidebars.leftOverlay}
        onDismiss={sidebars.closeRight}>
        <LogSidebar
          client={client}
          streamMode={streamMode}
          streamModeAvailability={streamModeAvailability}
          onStreamModeChange={handleStreamModeChange}
          onToggle={sidebars.closeRight}
          width={logsWidth}
        />
      </SidebarOverlay>

      {!sidebars.leftOpen && (
        <FloatingSidebarToggle
          side="left"
          inset={floatingSidebarToggleInset(
            sidebars.rightOverlay,
            sidebars.containerWidth,
            logsWidth
          )}
          onClick={sidebars.openLeft}
        />
      )}

      {!sidebars.rightOpen && (
        <FloatingSidebarToggle
          side="right"
          inset={floatingSidebarToggleInset(
            sidebars.leftOverlay,
            sidebars.containerWidth,
            sidebarWidth
          )}
          onClick={sidebars.openRight}
        />
      )}
    </div>
  );
}
