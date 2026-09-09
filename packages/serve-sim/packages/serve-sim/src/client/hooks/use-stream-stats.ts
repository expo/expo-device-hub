import { useEffect, useRef, useState } from "react";

import { startExclusivePoll } from "../utils/exclusive-poll";
import {
  describeStreamStats,
  readStreamStats,
  type StreamStats,
  type StreamStatsSample,
} from "../utils/webrtc-stats";

const POLL_MS = 1000;
// Well past a couple of missed polls, so a slow tick is not mistaken for a dead stream.
const STALE_AFTER_MS = 4_000;
/** ~10 minutes at one sample a second. */
const HISTORY_LIMIT = 600;

// Records while the tools panel is mounted. The first sample has no window behind it, so its rates
// and counts are null.
export function useStreamStats(
  peerConnection: RTCPeerConnection | null,
): { stats: StreamStats | null; history: StreamStats[]; stale: boolean } {
  const [stats, setStats] = useState<StreamStats | null>(null);
  const [history, setHistory] = useState<StreamStats[]>([]);
  const [stale, setStale] = useState(false);
  const previousRef = useRef<StreamStatsSample | null>(null);
  const lastSampleAt = useRef(0);

  useEffect(() => {
    // Reset unconditionally: a transport retry or codec change swaps the connection object without
    // ever passing through null, and diffing across that boundary reports a dead stream.
    previousRef.current = null;
    lastSampleAt.current = 0;
    setStale(false);
    if (peerConnection === null) {
      setStats(null);
      setHistory([]);
      return;
    }

    let stopped = false;
    const sample = async () => {
      // Stamped before the call, not after: getStats latency would otherwise land in the window
      // divisor and show false spikes under load, which is exactly when the panel gets opened.
      const at = Date.now();
      let report: RTCStatsReport;
      try {
        report = await peerConnection.getStats();
      } catch {
        // A closing connection rejects; the next tick either succeeds or the effect is torn down.
        return;
      }
      if (stopped) return;
      const next = readStreamStats(report, at);
      const described = describeStreamStats(previousRef.current, next);
      lastSampleAt.current = at;
      setStale(false);
      setStats(described);
      setHistory((entries) => [...entries, described].slice(-HISTORY_LIMIT));
      previousRef.current = next;
    };

    const stopPoll = startExclusivePoll(sample, POLL_MS);
    const watchdog = window.setInterval(() => {
      if (lastSampleAt.current > 0 && Date.now() - lastSampleAt.current > STALE_AFTER_MS) {
        setStale(true);
      }
    }, 1_000);
    return () => {
      stopped = true;
      stopPoll();
      window.clearInterval(watchdog);
    };
  }, [peerConnection]);

  return { stats, history, stale };
}
