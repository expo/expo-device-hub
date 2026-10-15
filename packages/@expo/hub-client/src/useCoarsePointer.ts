import { useEffect, useState } from 'react';

const QUERY = '(pointer: coarse)';

export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(QUERY).matches === true;
}

/**
 * True on touch-first clients (phones, tablets), where a phone keyboard is the
 * only way to type into the simulator. Ported from serve-sim's
 * `hooks/use-coarse-pointer.ts`.
 */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    const mql = window.matchMedia?.(QUERY);
    if (!mql) return;
    const onChange = () => setCoarse(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return coarse;
}
