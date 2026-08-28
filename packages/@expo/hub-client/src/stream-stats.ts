import { useEffect, useRef, useState } from 'react';

import { type DeviceStreamStats, type DeviceStreamStatsSample } from './types';

const MIN_WINDOW_MS = 250;
const POLL_MS = 1_000;
const STALE_AFTER_MS = 4_000;
const SERVER_REQUEST_TIMEOUT_MS = 3_000;
const HISTORY_LIMIT = 60;

export type WebRtcStatsConnection = {
  peerConnection: RTCPeerConnection;
  sessionId: string;
};

export type WebRtcClientCounters = {
  atMs: number;
  presentedFrames: number;
  bytesReceived: number;
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the cumulative counters for the live inbound video stream. */
export function readWebRtcClientCounters(
  report: RTCStatsReport,
  atMs: number,
  presentedFrames: number,
): WebRtcClientCounters | null {
  let foundVideo = false;
  let mostDecodedFrames = -1;
  let bytesReceived = 0;

  report.forEach((entry: Record<string, unknown>) => {
    if (entry.type !== 'inbound-rtp') return;
    if (entry.kind !== 'video' && entry.mediaType !== 'video') return;
    const frames = finiteNumber(entry.framesDecoded) ?? 0;
    if (frames < mostDecodedFrames) return;
    foundVideo = true;
    mostDecodedFrames = frames;
    bytesReceived = finiteNumber(entry.bytesReceived) ?? 0;
  });

  return foundVideo ? { atMs, presentedFrames, bytesReceived } : null;
}

/** Derive one receiver window. Unknown and reset windows stay null instead of looking idle. */
export function describeWebRtcClientCounters(
  previous: WebRtcClientCounters | null,
  current: WebRtcClientCounters,
): Pick<DeviceStreamStatsSample, 'clientFps' | 'clientBitrateBps'> {
  const unknown = { clientFps: null, clientBitrateBps: null };
  if (previous === null) return unknown;
  const elapsedMs = current.atMs - previous.atMs;
  if (elapsedMs < MIN_WINDOW_MS) return unknown;
  const frames = current.presentedFrames - previous.presentedFrames;
  const bytes = current.bytesReceived - previous.bytesReceived;
  if (frames < 0 || bytes < 0) return unknown;
  const seconds = elapsedMs / 1_000;
  return {
    clientFps: frames / seconds,
    clientBitrateBps: (bytes * 8) / seconds,
  };
}

/** Read the normalized Hub Android response or serve-sim's sender-session response. */
export function readWebRtcServerFps(value: unknown, sessionId: string): number | null {
  if (!isRecord(value)) return null;
  const direct = finiteNumber(value.serverFps);
  if (direct !== null) return direct;
  if (!Array.isArray(value.sessions)) return null;
  const session = value.sessions.find(
    (candidate) => isRecord(candidate) && candidate.sessionId === sessionId,
  );
  if (!isRecord(session)) return null;
  return finiteNumber(session.reportedFps) ?? finiteNumber(session.sourceFps);
}

export function appendStreamStatsSample(
  samples: readonly DeviceStreamStatsSample[],
  sample: DeviceStreamStatsSample,
): DeviceStreamStatsSample[] {
  return [...samples, sample].slice(-HISTORY_LIMIT);
}

async function readServerFps(
  statsUrl: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<number | null> {
  const url = new URL(statsUrl, window.location.href);
  url.searchParams.set('sessionId', sessionId);
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return readWebRtcServerFps(await response.json(), sessionId);
}

/** Own the single stats poll for a WebRTC peer so UI remounts do not reset history. */
export function useWebRtcStreamStats(
  connection: WebRtcStatsConnection | null,
  statsUrl: string,
  presentedFrames: Readonly<{ current: number }>,
): DeviceStreamStats | null {
  const [stats, setStats] = useState<DeviceStreamStats | null>(null);
  const previousRef = useRef<WebRtcClientCounters | null>(null);
  const lastSampleAtRef = useRef(0);

  useEffect(() => {
    previousRef.current = null;
    lastSampleAtRef.current = 0;
    if (connection === null || !statsUrl) {
      setStats(null);
      return;
    }

    setStats({ samples: [], stale: false });
    const pollingStartedAt = Date.now();
    let stopped = false;
    let clientPolling = false;
    let serverPolling = false;
    let serverFps: number | null = null;
    let serverController: AbortController | null = null;

    const sampleServer = async () => {
      if (serverPolling || stopped) return;
      serverPolling = true;
      serverController = new AbortController();
      const controller = serverController;
      const timeout = window.setTimeout(() => controller.abort(), SERVER_REQUEST_TIMEOUT_MS);
      try {
        const next = await readServerFps(statsUrl, connection.sessionId, controller.signal);
        if (!stopped) serverFps = next;
      } catch {
        if (!stopped) serverFps = null;
      } finally {
        window.clearTimeout(timeout);
        if (serverController === controller) serverController = null;
        serverPolling = false;
      }
    };

    const sampleClient = async () => {
      if (clientPolling || stopped) return;
      clientPolling = true;
      const atMs = Date.now();
      const presentedFrameCount = presentedFrames.current;
      try {
        const report = await connection.peerConnection.getStats();
        if (stopped) return;
        const counters = readWebRtcClientCounters(report, atMs, presentedFrameCount);
        if (counters === null) return;
        const client = describeWebRtcClientCounters(previousRef.current, counters);
        previousRef.current = counters;
        lastSampleAtRef.current = atMs;
        const next: DeviceStreamStatsSample = { atMs, serverFps, ...client };
        setStats((current) => ({
          samples: appendStreamStatsSample(current?.samples ?? [], next),
          stale: false,
        }));
      } catch {
        // Closing peer connections reject getStats. The watchdog marks retained data stale.
      } finally {
        clientPolling = false;
      }
    };

    void sampleServer();
    void sampleClient();
    const pollTimer = window.setInterval(() => {
      void sampleServer();
      void sampleClient();
    }, POLL_MS);
    const staleTimer = window.setInterval(() => {
      const lastSampleAt = lastSampleAtRef.current || pollingStartedAt;
      if (Date.now() - lastSampleAt > STALE_AFTER_MS) {
        setStats((current) => (current ? { ...current, stale: true } : current));
      }
    }, POLL_MS);

    return () => {
      stopped = true;
      serverController?.abort();
      window.clearInterval(pollTimer);
      window.clearInterval(staleTimer);
    };
  }, [connection, presentedFrames, statsUrl]);

  return stats;
}
