import { useEffect, useState } from 'react';

/**
 * True when the viewport is at most `maxWidth` px wide — i.e. too narrow to fit
 * the sidebar alongside the device stream. Tracks `matchMedia` so it updates on
 * resize / orientation changes.
 */
export function useIsNarrow(maxWidth: number): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [maxWidth]);

  return narrow;
}
