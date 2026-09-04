import { usePrefersReducedMotion } from '@expo/hub-components';
import { useEffect, useRef, useState } from 'react';

export const SIDEBAR_TRANSITION_MS = 200;
export const SIDEBAR_TRANSITION_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** Keep a closing sidebar mounted long enough for its CSS transition to finish. */
export function useSidebarPresence(open: boolean, animateExit: boolean) {
  const reducedMotion = usePrefersReducedMotion();
  const [present, setPresent] = useState(open);
  const [visible, setVisible] = useState(open);
  const presentRef = useRef(open);

  useEffect(() => {
    if (open) {
      const alreadyPresent = presentRef.current;
      presentRef.current = true;
      setPresent(true);

      if (reducedMotion || alreadyPresent) {
        setVisible(true);
        return;
      }

      // Give a newly mounted sidebar one painted frame in its closed position
      // before enabling the transition to its open position.
      let transitionFrame = 0;
      const mountFrame = requestAnimationFrame(() => {
        transitionFrame = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(mountFrame);
        cancelAnimationFrame(transitionFrame);
      };
    }

    setVisible(false);
    if (!animateExit || reducedMotion) {
      presentRef.current = false;
      setPresent(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      presentRef.current = false;
      setPresent(false);
    }, SIDEBAR_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [animateExit, open, reducedMotion]);

  return {
    present,
    reducedMotion,
    visible: open && visible,
  };
}
