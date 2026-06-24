'use dom';

import '../theme/theme.css';
import '../global.css';

import { useEffect, useState } from 'react';

import { SidebarToggle } from '../components/SidebarToggle';
import { bg, shadow, text } from '../theme/tokens';
import { useActiveDeviceClient } from './device';
import { allDevices, simulators } from './dashboard/data';
import { Sidebar } from './dashboard/Sidebar';
import { StreamPanel } from './dashboard/StreamPanel';
import { useColorScheme } from './dashboard/useColorScheme';
import { useIsNarrow } from './dashboard/useIsNarrow';

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
  const [selectedId, setSelectedId] = useState(simulators[0].id);
  const narrow = useIsNarrow(NARROW_MAX_WIDTH);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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

  const selected = allDevices.find((device) => device.id === selectedId) ?? simulators[0];

  // One shared connection to the selected device's serve-sim/serve-emu server.
  // The stream (PhoneFrame), Home control, and logs panel all read from it.
  const client = useActiveDeviceClient({ platform: selected.platform });

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
          selectedId={selectedId}
          onSelect={setSelectedId}
          onToggle={() => setSidebarOpen(false)}
          logs={client.logs}
        />
      )}

      <StreamPanel device={selected} client={client} scheme={scheme} onToggleTheme={toggle} />

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
              selectedId={selectedId}
              onSelect={setSelectedId}
              onToggle={() => setSidebarOpen(false)}
              logs={client.logs}
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
