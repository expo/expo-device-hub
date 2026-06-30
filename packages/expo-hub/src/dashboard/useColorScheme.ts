import { useEffect, useState } from 'react';

import { type ColorScheme } from '@expo/hub-components';

/**
 * Tracks the system color scheme (`prefers-color-scheme`) for Hub's own UI.
 *
 * Hub follows the OS setting and is no longer flipped from within the app — the
 * stream's "Theme" control now drives the *device's* appearance (see
 * `@expo/hub-client`'s `setAppearance`), not Hub's.
 */
export function useColorScheme(): ColorScheme {
  const [scheme, setScheme] = useState<ColorScheme>('light');

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setScheme(mq.matches ? 'dark' : 'light');
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return scheme;
}
