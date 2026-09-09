import { useEffect, useRef, useState } from "react";

import {
  senderSessionForViewer,
  type CaptureCounts,
  type SenderStats,
  type SenderStreamStats,
} from "../../webrtc-sender-stats";
import { startExclusivePoll } from "../utils/exclusive-poll";
import { webrtcSessionStatsUrl } from "../utils/sim-endpoint";

const POLL_MS = 1000;
const STALE_AFTER_MS = 4_000;

export interface SenderView {
  session: SenderStreamStats | null;
  capture: CaptureCounts | null;
  stale: boolean;
}

export function useSenderStats(
  statsUrl: string,
  sessionId: string | null,
  enabled: boolean,
): SenderView {
  const [stats, setStats] = useState<SenderView>({ session: null, capture: null, stale: false });
  const lastSampleAt = useRef(0);

  useEffect(() => {
    // Reset unconditionally so a device switch drops the previous device's samples.
    lastSampleAt.current = 0;
    setStats({ session: null, capture: null, stale: false });
    if (!enabled || sessionId === null) return;

    let stopped = false;
    const requestUrl = webrtcSessionStatsUrl(statsUrl, sessionId);
    const sample = async () => {
      let body: SenderStats | null = null;
      try {
        const response = await fetch(requestUrl, { signal: AbortSignal.timeout(POLL_MS * 3) });
        // A non-ok answer means no session is streaming, which is definite: clear rather than keep
        // numbers from a session that has gone. A throw is a dropped tick, handled below.
        if (!response.ok) {
          if (!stopped) setStats({ session: null, capture: null, stale: false });
          return;
        }
        // The route already returns display units: `native.ts` runs `readSenderStats` server-side.
        // Shaping again here looks for the raw libwebrtc keys and nulls every derived field.
        body = (await response.json()) as SenderStats;
      } catch {
        // A dropped tick; keeping the last sample beats blanking the column, and the watchdog
        // will mark it stale if they keep failing.
        return;
      }
      if (stopped || body === null) return;
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      lastSampleAt.current = Date.now();
      setStats({
        session: senderSessionForViewer(sessions, sessionId),
        capture: body.capture ?? null,
        stale: false,
      });
    };

    const stopPoll = startExclusivePoll(sample, POLL_MS);
    const watchdog = window.setInterval(() => {
      if (lastSampleAt.current > 0 && Date.now() - lastSampleAt.current > STALE_AFTER_MS) {
        setStats((previous) => (previous.stale ? previous : { ...previous, stale: true }));
      }
    }, 1_000);
    return () => {
      stopped = true;
      stopPoll();
      window.clearInterval(watchdog);
    };
  }, [statsUrl, sessionId, enabled]);

  return stats;
}
