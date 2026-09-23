import { useEffect, useRef, useState } from "react";

import {
  describeStreamStats,
  readStreamStats,
  type StreamStats,
  type StreamStatsSample,
} from "../utils/webrtc-stats";

/// One `getStats` read per tick, owned by the stream hook. Returns an unsubscribe.
export type StatsSubscriber =
  (listener: (report: RTCStatsReport, at: number) => void) => () => void;

// Well past a couple of missed polls, so a slow tick is not mistaken for a dead stream.
const STALE_AFTER_MS = 4_000;
/** ~10 minutes at one sample a second. */
const HISTORY_LIMIT = 600;

// Records while the tools panel is mounted. The first sample has no window behind it, so its rates
// and counts are null.
export function useStreamStats(
  peerConnection: RTCPeerConnection | null,
  subscribeStats?: StatsSubscriber,
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
    if (peerConnection === null || !subscribeStats) {
      setStats(null);
      setHistory([]);
      return;
    }

    let stopped = false;
    const sample = (report: RTCStatsReport, at: number) => {
      if (stopped) return;
      const next = readStreamStats(report, at);
      const described = describeStreamStats(previousRef.current, next);
      lastSampleAt.current = at;
      setStale(false);
      setStats(described);
      setHistory((entries) => [...entries, described].slice(-HISTORY_LIMIT));
      previousRef.current = next;
    };

    const stopPoll = subscribeStats(sample);
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
  }, [peerConnection, subscribeStats]);

  return { stats, history, stale };
}
