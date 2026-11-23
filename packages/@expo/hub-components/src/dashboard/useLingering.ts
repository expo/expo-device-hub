import { useEffect, useState } from "react";

/**
 * Whether a layer is on screen: while `active`, and for `lingerMs` after
 * `active` ends, so that the layer can play its exit before it unmounts.
 */
export function useLingering(active: boolean, lingerMs: number): boolean {
  const [wasActive, setWasActive] = useState(active);
  const [lingering, setLingering] = useState(false);
  if (active !== wasActive) {
    setWasActive(active);
    setLingering(!active && lingerMs > 0);
  }
  useEffect(() => {
    if (!lingering) return;
    const timer = setTimeout(() => setLingering(false), lingerMs);
    return () => clearTimeout(timer);
  }, [lingering, lingerMs]);
  return active || lingering;
}
