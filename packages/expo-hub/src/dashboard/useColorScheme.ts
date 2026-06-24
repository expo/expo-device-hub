import { useEffect, useState } from 'react';

export type ColorScheme = 'light' | 'dark';

/**
 * Tracks the system color scheme (`prefers-color-scheme`) and lets the UI
 * override it (e.g. via the Theme switch). Returns the active scheme plus a
 * toggle that flips light/dark on top of the system default.
 */
export function useColorScheme(): { scheme: ColorScheme; toggle: () => void } {
  const [override, setOverride] = useState<ColorScheme | null>(null);
  const [system, setSystem] = useState<ColorScheme>('light');

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystem(mq.matches ? 'dark' : 'light');
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const scheme = override ?? system;
  const toggle = () => setOverride(scheme === 'dark' ? 'light' : 'dark');

  return { scheme, toggle };
}
