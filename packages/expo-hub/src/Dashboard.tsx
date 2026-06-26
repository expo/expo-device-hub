'use dom';

import '../theme/theme.css';
import '../global.css';

import { useEffect, useMemo, useState } from 'react';

import { SidebarToggle } from '../components/SidebarToggle';
import { bg, shadow, text } from '../theme/tokens';
import { useActiveDeviceClient } from './device';
import { type Device } from './dashboard/data';
import { EmptyState } from './dashboard/EmptyState';
import { Sidebar } from './dashboard/Sidebar';
import { StreamPanel } from './dashboard/StreamPanel';
import { useColorScheme } from './dashboard/useColorScheme';
import { useDevices, useRecentDevices } from './dashboard/useDevices';
import { useIsNarrow } from './dashboard/useIsNarrow';

/** Append `extra` devices not already present in `base` (deduped by id). */
function mergeById(base: Device[], extra: Device[]): Device[] {
  const ids = new Set(base.map((device) => device.id));
  return [...base, ...extra.filter((device) => !ids.has(device.id))];
}

// Below this width the sidebar + device stream no longer fit side by side, so
// the sidebar collapses and becomes a toggleable overlay.
const NARROW_MAX_WIDTH = 767;

/**
 * The single Expo Hub screen, authored as an Expo DOM component (`'use dom'`) so
 * it renders with web primitives and real CSS. Left: simulators + emulators +
 * output tabs. Right: the stream of the selected device. Dark mode follows the
 * system setting (and can be flipped with the Theme switch) via `dark-theme`.
 *
 * On narrow viewports the sidebar collapses: a floating toggle reveals it as an
 * overlay over the stream, and a matching toggle in its header hides it again.
 */
export default function Dashboard(_props: { dom?: import('expo/dom').DOMProps }) {
  const { scheme, toggle } = useColorScheme();
  const booted = useDevices();
  const recent = useRecentDevices();
  const [selectedId, setSelectedId] = useState('');
  // Devices the user added from a "recent devices" picker. UI-only for now: they
  // join the sidebar list but aren't booted on the host.
  const [added, setAdded] = useState<Device[]>([]);
  const narrow = useIsNarrow(NARROW_MAX_WIDTH);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  // Add a device chosen in a picker and select it straight away. Selecting a
  // device attaches its serve-sim helper on demand (see useIosDeviceClient):
  // a booted sim just gets a stream daemon, while a shut-down one picked here is
  // booted. This picker is the only path that boots a sim — the middleware never
  // does so on its own.
  function handleAddDevice(device: Device) {
    setAdded((prev) => (prev.some((item) => item.id === device.id) ? prev : [...prev, device]));
    setSelectedId(device.id);
  }

  // Default to open on the wide layout, collapsed on the narrow one — but the
  // toggle lets the user close/open it at any width.
  useEffect(() => {
    setSidebarOpen(!narrow);
  }, [narrow]);

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
        backgroundColor: bg.default,
        color: text.default,
        fontFamily: 'var(--expo-font-sans)',
        overflow: 'hidden',
      }}>
      {/* Wide + open: the sidebar sits inline next to the stream. */}
      {sidebarOpen && !narrow && (
        <Sidebar
          simulators={simulators}
          emulators={emulators}
          recentSimulators={recent.simulators}
          recentEmulators={recent.emulators}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onAddDevice={handleAddDevice}
          onToggle={() => setSidebarOpen(false)}
          client={client}
        />
      )}

      {selected ? (
        <StreamPanel device={selected} client={client} scheme={scheme} onToggleTheme={toggle} />
      ) : (
        <EmptyState />
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
              backgroundColor: bg.default,
              boxShadow: shadow.lg,
            }}>
            <Sidebar
              simulators={simulators}
              emulators={emulators}
              recentSimulators={recent.simulators}
              recentEmulators={recent.emulators}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAddDevice={handleAddDevice}
              onToggle={() => setSidebarOpen(false)}
              client={client}
            />
          </div>
        </>
      )}

      {/* Closed (either layout): a floating toggle to reopen the sidebar. */}
      {!sidebarOpen && (
        <div style={{ position: 'absolute', top: 24, left: 24, zIndex: 12 }}>
          <SidebarToggle floating onClick={() => setSidebarOpen(true)} />
        </div>
      )}
    </div>
  );
}
