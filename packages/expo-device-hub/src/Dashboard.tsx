'use dom';

import '@expo/hub-components/theme.css';
import '../global.css';

import { useEffect, useMemo, useRef, useState } from 'react';

import { DeviceScreen, displayScreen, useActiveDeviceClient } from '@expo/hub-client';
import {
  BootErrorModal,
  EmptyState,
  LogSidebar,
  ResizeHandle,
  Sidebar,
  SidebarToggle,
  StreamPanel,
  bg,
  shadow,
  text,
  type Device,
} from '@expo/hub-components';
import { bootDevice, removeDevice, shutdownDevice } from './dashboard/deviceActions';
import { basePath } from './dashboard/basePath';
import { useColorScheme } from './dashboard/useColorScheme';
import { useDevices, useRecentDevices } from './dashboard/useDevices';
import { useIsNarrow } from './dashboard/useIsNarrow';
import { useNewDeviceOptions } from './dashboard/useNewDeviceOptions';

/** Append `extra` devices not already present in `base` (deduped by id). */
function mergeById(base: Device[], extra: Device[]): Device[] {
  const ids = new Set(base.map((device) => device.id));
  return [...base, ...extra.filter((device) => !ids.has(device.id))];
}

// Below this width a single sidebar + the device stream no longer fit side by
// side, so the left (devices) sidebar collapses into a toggleable overlay.
const NARROW_MAX_WIDTH = 767;
// The logs sidebar is a second ~400px column, so two sidebars + the stream need
// roughly one more sidebar-width to fit. Between these thresholds the left
// sidebar stays inline while the logs sidebar collapses first; below
// NARROW_MAX_WIDTH both are overlays.
const LOGS_MAX_WIDTH = NARROW_MAX_WIDTH + 400;

// Resizable-sidebar bounds. Each column starts at DEFAULT_SIDEBAR_WIDTH (the
// original fixed width) and can be dragged between MIN and MAX — never so wide
// that the stream, alongside the other sidebar, is squeezed below MIN_STREAM.
const DEFAULT_SIDEBAR_WIDTH = 400;
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
 * As the viewport narrows the sidebars collapse in stages — the logs sidebar
 * first, then the left (devices) sidebar — each becoming a toggleable overlay
 * over the stream, with a floating toggle to reveal it and a header toggle to
 * hide it again.
 */
export default function Dashboard(_props: { dom?: import('expo/dom').DOMProps }) {
  const scheme = useColorScheme();
  const booted = useDevices();
  const recent = useRecentDevices();
  // Mocked OS versions + models for the add-device picker's "New device" form.
  const newDeviceOptions = useNewDeviceOptions();
  const [selectedId, setSelectedId] = useState('');
  // Devices the user added from a "recent devices" picker. UI-only for now: they
  // join the sidebar list but aren't booted on the host.
  const [added, setAdded] = useState<Device[]>([]);
  const narrow = useIsNarrow(NARROW_MAX_WIDTH);
  const logsNarrow = useIsNarrow(LOGS_MAX_WIDTH);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [logsOpen, setLogsOpen] = useState(true);
  // Draggable widths for each inline sidebar. The `*Start` refs snapshot the
  // width when a drag begins so each move re-derives width from the start point
  // (delta-from-start), which clamps cleanly without drifting.
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [logsWidth, setLogsWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const sidebarWidthStart = useRef(DEFAULT_SIDEBAR_WIDTH);
  const logsWidthStart = useRef(DEFAULT_SIDEBAR_WIDTH);
  // Set when booting a device on the host failed — drives the error dialog.
  const [bootError, setBootError] = useState<{ deviceName: string; message: string } | null>(null);

  // Merge booted devices (from the server) with any the user added, deduped by
  // id and split back into the two sections by platform.
  const simulators = useMemo(
    () => mergeById(booted.simulators, added.filter((device) => device.platform === 'ios')),
    [booted.simulators, added],
  );
  const emulators = useMemo(
    () => mergeById(booted.emulators, added.filter((device) => device.platform === 'android')),
    [booted.emulators, added],
  );

  // Add a device chosen in a picker and select it straight away.
  //
  // iOS: selecting attaches the serve-sim helper on demand, which boots a
  // shut-down sim (see useIosDeviceClient / startIosHelper).
  //
  // Android: serve-emu only streams already-running emulators, keyed by adb
  // serial, so a shut-down (recent) AVD must be booted on the host first. Boot
  // it, then re-key the added entry from the AVD name to the `emulator-<port>`
  // serial serve-emu streams, and select that.
  async function handleAddDevice(device: Device) {
    setAdded((prev) => (prev.some((item) => item.id === device.id) ? prev : [...prev, device]));
    setSelectedId(device.id);

    if (device.platform === 'android' && !device.booted) {
      const { serial, error } = await bootDevice(device);
      if (serial) {
        setAdded((prev) => [
          ...prev.filter((item) => item.id !== device.id && item.id !== serial),
          { ...device, id: serial, booted: true },
        ]);
        setSelectedId(serial);
      } else {
        // Boot failed — drop the placeholder (the device leaves the sidebar),
        // let the selection effect fall back, and surface the reason.
        setAdded((prev) => prev.filter((item) => item.id !== device.id));
        setSelectedId('');
        setBootError({ deviceName: device.name, message: error ?? 'Unknown error' });
      }
    }
  }

  // Shut down / remove the selected device on the host, then drop it from the
  // UI. The device leaves the polled booted list within a tick, and the
  // selection effect re-selects the next device (or falls back to EmptyState).
  async function handleShutdown(device: Device) {
    await shutdownDevice(device);
    setAdded((prev) => prev.filter((item) => item.id !== device.id));
    setSelectedId('');
  }

  async function handleRemove(device: Device) {
    await removeDevice(device);
    setAdded((prev) => prev.filter((item) => item.id !== device.id));
    setSelectedId('');
  }

  // Default each sidebar open when it fits inline, collapsed once its own
  // breakpoint is crossed — but the toggles let the user close/open either at any
  // width. Separate effects so resizing across one breakpoint never resets the
  // other sidebar's manually-toggled state.
  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow]);

  useEffect(() => {
    setLogsOpen(!logsNarrow);
  }, [logsNarrow]);

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
    if (!devices.some((device) => device.id === selectedId)) {
      setSelectedId(devices[0]?.id ?? '');
    }
  }, [simulators, emulators, selectedId]);

  const devices = [...simulators, ...emulators];
  const selected = devices.find((device) => device.id === selectedId) ?? devices[0];

  // One shared connection to the serve-sim/serve-emu server, wired to the
  // selected device. Null until the user picks one, so nothing connects (or
  // boots) on load.
  const client = useActiveDeviceClient(
    selected ? { platform: selected.platform, device: selected.id } : null,
    basePath(),
  );

  return (
    <div
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
      {/* Wide + open: the sidebar sits inline next to the stream. */}
      {sidebarOpen && !narrow && (
        <>
          <Sidebar
            simulators={simulators}
            emulators={emulators}
            recentSimulators={recent.simulators}
            recentEmulators={recent.emulators}
            simulatorOptions={newDeviceOptions.ios}
            emulatorOptions={newDeviceOptions.android}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAddDevice={handleAddDevice}
            onToggle={() => setSidebarOpen(false)}
            width={sidebarWidth}
          />
          {/* Drag the seam between the devices sidebar and the stream to resize. */}
          <ResizeHandle
            side="left"
            offset={sidebarWidth}
            onResizeStart={() => {
              sidebarWidthStart.current = sidebarWidth;
            }}
            onResize={(delta) =>
              setSidebarWidth(
                clampSidebarWidth(
                  sidebarWidthStart.current + delta,
                  logsOpen && !logsNarrow ? logsWidth : 0,
                ),
              )
            }
          />
        </>
      )}

      {selected ? (
        <StreamPanel
          device={selected}
          client={client}
          DeviceScreen={DeviceScreen}
          displayScreen={displayScreen}
          onShutdown={() => handleShutdown(selected)}
          onRemove={() => handleRemove(selected)}
        />
      ) : (
        <EmptyState />
      )}

      {/* Room for two sidebars + open: the logs sidebar sits inline to the right of the stream. */}
      {logsOpen && !logsNarrow && (
        <>
          {/* Drag the seam between the stream and the logs sidebar to resize. */}
          <ResizeHandle
            side="right"
            offset={logsWidth}
            onResizeStart={() => {
              logsWidthStart.current = logsWidth;
            }}
            onResize={(delta) =>
              setLogsWidth(
                clampSidebarWidth(
                  logsWidthStart.current + delta,
                  sidebarOpen && !narrow ? sidebarWidth : 0,
                ),
              )
            }
          />
          <LogSidebar client={client} onToggle={() => setLogsOpen(false)} width={logsWidth} />
        </>
      )}

      {/* Narrow + open: the sidebar overlays the stream with a backdrop. */}
      {sidebarOpen && narrow && (
        <>
          <div
            onClick={() => setSidebarOpen(false)}
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.35)', zIndex: 10 }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              zIndex: 11,
              backgroundColor: bg.subtle,
              boxShadow: shadow.lg,
            }}>
            <Sidebar
              simulators={simulators}
              emulators={emulators}
              recentSimulators={recent.simulators}
              recentEmulators={recent.emulators}
              simulatorOptions={newDeviceOptions.ios}
              emulatorOptions={newDeviceOptions.android}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddDevice={handleAddDevice}
              onToggle={() => setSidebarOpen(false)}
              width={sidebarWidth}
            />
          </div>
        </>
      )}

      {/* Cramped + open: the logs sidebar overlays the stream from the right. */}
      {logsOpen && logsNarrow && (
        <>
          <div
            onClick={() => setLogsOpen(false)}
            style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.35)', zIndex: 10 }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              zIndex: 11,
              backgroundColor: bg.subtle,
              boxShadow: shadow.lg,
            }}>
            <LogSidebar client={client} onToggle={() => setLogsOpen(false)} width={logsWidth} />
          </div>
        </>
      )}

      {/* Closed (either layout): a floating toggle to reopen the left sidebar. */}
      {!sidebarOpen && (
        <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 12 }}>
          <SidebarToggle floating onClick={() => setSidebarOpen(true)} />
        </div>
      )}

      {/* Closed (either layout): a floating toggle to reopen the logs sidebar. */}
      {!logsOpen && (
        <div style={{ position: 'absolute', top: 24, right: 24, zIndex: 12 }}>
          <SidebarToggle floating side="right" onClick={() => setLogsOpen(true)} />
        </div>
      )}

      <BootErrorModal
        open={bootError !== null}
        onClose={() => setBootError(null)}
        deviceName={bootError?.deviceName ?? ''}
        message={bootError?.message ?? ''}
      />
    </div>
  );
}
