import { useEffect, useRef } from "react";

import { createLadderBackoff } from "../webrtc-codec-fallback";

interface Timers {
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (id: number | undefined) => void;
}

export interface LadderRestart {
  noteFailure: (now: number) => void;
  schedule: () => void;
  cancel: () => void;
}

/**
 * Starting the codec list over for a session with no HTTP to fall back to.
 *
 * The timer outlives the failure that armed it, so every way out of that failure has to cancel
 * it: a stream that recovers, a codec the user picks, the component going away.
 */
export function createLadderRestart(run: () => void, timers: Timers): LadderRestart {
  const backoff = createLadderBackoff();
  let timer: number | undefined;
  return {
    noteFailure(now) {
      backoff.noteFailure(now);
    },
    /// One restart per walk of the ladder. A second screen failing the same way rides the
    /// pending one rather than re-arming it and taking another step of the backoff.
    schedule() {
      if (timer !== undefined) return;
      timer = timers.setTimeout(() => {
        timer = undefined;
        run();
      }, backoff.takeRestartDelayMs());
    },
    cancel() {
      timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function useLadderRestart(restart: () => void): LadderRestart {
  const latest = useRef(restart);
  latest.current = restart;
  const controller = useRef<LadderRestart | null>(null);
  controller.current ??= createLadderRestart(() => latest.current(), window);
  const ladder = controller.current;
  useEffect(() => ladder.cancel, [ladder]);
  return ladder;
}
