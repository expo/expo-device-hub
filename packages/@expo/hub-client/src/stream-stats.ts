import { useEffect, useRef, useState } from 'react';

import {
  type DeviceStreamCaptureStats,
  type DeviceStreamEncoderStats,
  type DeviceStreamStats,
  type DeviceStreamStatsSample,
} from './types';

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
  bytesReceived: number | null;
  framesDropped: number | null;
  freezeCount: number | null;
  freezeDurationMs: number | null;
  packetsReceived: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  jitterBufferDelaySeconds: number | null;
  jitterBufferEmittedCount: number | null;
  roundTripMs: number | null;
  icePath: DeviceStreamStatsSample['clientIcePath'];
};

export type WebRtcServerStats = {
  serverFps: number | null;
  encoder: DeviceStreamEncoderStats | null;
  capture: DeviceStreamCaptureStats | null;
  publisherCounters: WebRtcPublisherCounters | null;
};

export type WebRtcPublisherCounters = {
  atMs: number;
  submittedFrames: number;
  payloadBytesSubmitted: number;
};

export type WebRtcPublisherDescription = Pick<
  DeviceStreamEncoderStats,
  'publisherFps' | 'payloadBitrateBps'
>;

type WebRtcClientDescription = Pick<
  DeviceStreamStatsSample,
  | 'clientFps'
  | 'clientBitrateBps'
  | 'clientPacketLossRatio'
  | 'clientJitterMs'
  | 'clientJitterBufferMs'
  | 'clientDroppedFrames'
  | 'clientFreezeCount'
  | 'clientFreezeDurationMs'
  | 'clientRoundTripMs'
  | 'clientIcePath'
>;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read cumulative receiver counters and point-in-time path health for the live video stream. */
export function readWebRtcClientCounters(
  report: RTCStatsReport,
  atMs: number,
  presentedFrames: number,
): WebRtcClientCounters | null {
  const pairsById = new Map<string, Record<string, unknown>>();
  const candidatesById = new Map<string, Record<string, unknown>>();
  let selectedPairId: string | null = null;
  let selectedPair: Record<string, unknown> | null = null;
  let nominatedPair: Record<string, unknown> | null = null;
  let succeededPair: Record<string, unknown> | null = null;
  let video: Record<string, unknown> | null = null;
  let mostDecodedFrames = -1;

  for (const rawEntry of report.values()) {
    const entry = rawEntry as unknown as Record<string, unknown>;
    switch (entry.type) {
      case 'inbound-rtp': {
        if (entry.kind !== 'video' && entry.mediaType !== 'video') break;
        const framesDecoded = finiteNumber(entry.framesDecoded) ?? 0;
        if (framesDecoded < mostDecodedFrames) break;
        mostDecodedFrames = framesDecoded;
        video = entry;
        break;
      }
      case 'transport':
        if (typeof entry.selectedCandidatePairId === 'string') {
          selectedPairId = entry.selectedCandidatePairId;
        }
        break;
      case 'candidate-pair':
        if (typeof entry.id === 'string') pairsById.set(entry.id, entry);
        if (entry.selected === true) selectedPair = entry;
        else if (entry.nominated === true && entry.state === 'succeeded') nominatedPair ??= entry;
        else if (entry.state === 'succeeded') succeededPair ??= entry;
        break;
      case 'local-candidate':
      case 'remote-candidate':
        if (typeof entry.id === 'string') candidatesById.set(entry.id, entry);
        break;
    }
  }

  if (video === null) return null;

  let pair = selectedPair ?? nominatedPair ?? succeededPair;
  if (selectedPairId !== null) pair = pairsById.get(selectedPairId) ?? pair;
  const roundTripSeconds = pair === null ? null : finiteNumber(pair.currentRoundTripTime);
  let icePath: WebRtcClientCounters['icePath'] = 'unknown';
  if (pair !== null) {
    const candidateTypes = [pair.localCandidateId, pair.remoteCandidateId].map((id) =>
      typeof id === 'string' ? nonEmptyString(candidatesById.get(id)?.candidateType) : null,
    );
    if (candidateTypes.every((type) => type !== null)) {
      icePath = candidateTypes.includes('relay') ? 'relay' : 'direct';
    }
  }

  const freezeDurationSeconds = finiteNumber(video.totalFreezesDuration);
  const jitterSeconds = finiteNumber(video.jitter);
  return {
    atMs,
    presentedFrames,
    bytesReceived: finiteNumber(video.bytesReceived),
    framesDropped: finiteNumber(video.framesDropped),
    freezeCount: finiteNumber(video.freezeCount),
    freezeDurationMs: freezeDurationSeconds === null ? null : freezeDurationSeconds * 1_000,
    packetsReceived: finiteNumber(video.packetsReceived),
    packetsLost: finiteNumber(video.packetsLost),
    jitterMs: jitterSeconds === null ? null : jitterSeconds * 1_000,
    jitterBufferDelaySeconds: finiteNumber(video.jitterBufferDelay),
    jitterBufferEmittedCount: finiteNumber(video.jitterBufferEmittedCount),
    roundTripMs: roundTripSeconds === null ? null : roundTripSeconds * 1_000,
    icePath,
  };
}

function unmeasuredClient(current: WebRtcClientCounters): WebRtcClientDescription {
  return {
    clientFps: null,
    clientBitrateBps: null,
    clientPacketLossRatio: null,
    clientJitterMs: current.jitterMs,
    clientJitterBufferMs: null,
    clientDroppedFrames: null,
    clientFreezeCount: null,
    clientFreezeDurationMs: null,
    clientRoundTripMs: current.roundTripMs,
    clientIcePath: current.icePath,
  };
}

function windowPacketLossRatio(
  previous: WebRtcClientCounters,
  current: WebRtcClientCounters,
): number | null {
  if (
    previous.packetsReceived === null ||
    current.packetsReceived === null ||
    previous.packetsLost === null ||
    current.packetsLost === null
  ) {
    return null;
  }
  const lost = current.packetsLost - previous.packetsLost;
  const received = current.packetsReceived - previous.packetsReceived;
  if (lost < 0 || received < 0) return null;
  const expected = received + lost;
  return expected > 0 ? lost / expected : null;
}

function windowJitterBufferMs(
  previous: WebRtcClientCounters,
  current: WebRtcClientCounters,
): number | null {
  if (
    previous.jitterBufferDelaySeconds === null ||
    current.jitterBufferDelaySeconds === null ||
    previous.jitterBufferEmittedCount === null ||
    current.jitterBufferEmittedCount === null
  ) {
    return null;
  }
  const delaySeconds = current.jitterBufferDelaySeconds - previous.jitterBufferDelaySeconds;
  const emittedFrames = current.jitterBufferEmittedCount - previous.jitterBufferEmittedCount;
  if (delaySeconds < 0 || emittedFrames <= 0) return null;
  return (delaySeconds / emittedFrames) * 1_000;
}

function windowCounterDelta(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  const delta = current - previous;
  return delta < 0 ? null : delta;
}

/** Derive one receiver window. Unknown and reset windows stay null instead of looking idle. */
export function describeWebRtcClientCounters(
  previous: WebRtcClientCounters | null,
  current: WebRtcClientCounters,
): WebRtcClientDescription {
  const unmeasured = unmeasuredClient(current);
  if (previous === null) return unmeasured;
  const elapsedMs = current.atMs - previous.atMs;
  if (elapsedMs < MIN_WINDOW_MS) return unmeasured;

  const presentedFrames = windowCounterDelta(previous.presentedFrames, current.presentedFrames);
  const bytesReceived = windowCounterDelta(previous.bytesReceived, current.bytesReceived);
  const droppedFrames = windowCounterDelta(previous.framesDropped, current.framesDropped);
  const freezes = windowCounterDelta(previous.freezeCount, current.freezeCount);
  const freezeDurationMs = windowCounterDelta(previous.freezeDurationMs, current.freezeDurationMs);

  const elapsedSeconds = elapsedMs / 1_000;
  return {
    clientFps: presentedFrames === null ? null : presentedFrames / elapsedSeconds,
    clientBitrateBps: bytesReceived === null ? null : (bytesReceived * 8) / elapsedSeconds,
    clientPacketLossRatio: windowPacketLossRatio(previous, current),
    clientJitterMs: current.jitterMs,
    clientJitterBufferMs: windowJitterBufferMs(previous, current),
    clientDroppedFrames: droppedFrames,
    clientFreezeCount: freezes,
    clientFreezeDurationMs: freezeDurationMs,
    clientRoundTripMs: current.roundTripMs,
    clientIcePath: current.icePath,
  };
}

function readWebRtcEncoderStats(value: unknown): DeviceStreamEncoderStats | null {
  if (!isRecord(value)) return null;
  const targetBitrateBps = finiteNumber(value.targetBitrateBps);
  const targetKbps = finiteNumber(value.targetKbps);
  return {
    codec: nonEmptyString(value.codec),
    encodeFps: finiteNumber(value.encodeFps) ?? finiteNumber(value.reportedFps),
    targetBitrateBps: targetBitrateBps ?? (targetKbps === null ? null : targetKbps * 1_000),
    encodeMsPerFrame: finiteNumber(value.encodeMsPerFrame),
    framesEncoded: finiteNumber(value.framesEncoded),
    framesSent: finiteNumber(value.framesSent),
    framesDropped: finiteNumber(value.framesDropped) ?? finiteNumber(value.sourceFramesDropped),
    packetLossRatio: finiteNumber(value.packetLossRatio) ?? finiteNumber(value.lossRatio),
    qualityLimitationReason: nonEmptyString(value.qualityLimitationReason),
    publisherFps: finiteNumber(value.publisherFps),
    publisherSubmittedFrames:
      finiteNumber(value.publisherSubmittedFrames) ?? finiteNumber(value.submittedFrames),
    publisherDroppedFrames: finiteNumber(value.publisherDroppedFrames),
    payloadBitrateBps: finiteNumber(value.payloadBitrateBps),
  };
}

function readWebRtcCaptureStats(value: unknown): DeviceStreamCaptureStats | null {
  if (!isRecord(value)) return null;
  const grpc = isRecord(value.grpc) ? value.grpc : null;
  const timing = (name: string, quantile: 'p50' | 'p95'): number | null => {
    if (grpc === null || !isRecord(grpc[name])) return null;
    return finiteNumber(grpc[name][quantile]);
  };
  const grpcImageMode = grpc?.imageMode === 'png' || grpc?.imageMode === 'mmap'
    ? grpc.imageMode
    : null;
  return {
    screenFrames: finiteNumber(value.screenFrames),
    idleFrames: finiteNumber(value.idleFrames),
    offeredFrames: finiteNumber(value.offeredFrames),
    forwardedFrames: finiteNumber(value.forwardedFrames),
    pumpRestarts: finiteNumber(value.pumpRestarts),
    ...(grpc === null
      ? {}
      : {
          grpcImageMode,
          grpcProducerFps: finiteNumber(grpc.sourceTimestampFps),
          grpcReceiveFps: finiteNumber(grpc.rawMessageReceiveFps),
          grpcUsableImageFps: finiteNumber(grpc.usableImageFps),
          grpcEncoderInputFps: finiteNumber(grpc.freshEncoderWriteFps),
          grpcMessagesReceived: finiteNumber(grpc.rawGrpcMessagesReceived),
          grpcMessagesEmitted: finiteNumber(grpc.rawGrpcMessagesEmitted),
          grpcMessagesCoalesced: finiteNumber(grpc.rawGrpcMessagesCoalesced),
          grpcSequenceGaps: finiteNumber(grpc.sequenceGaps),
          grpcImagePayloadBytes: finiteNumber(grpc.imagePayloadBytes),
          grpcTransportBytes: finiteNumber(grpc.transportBytes),
          grpcMessageBytesReceived: finiteNumber(grpc.grpcMessageBytesReceived),
          mmapFileBytesRead: finiteNumber(grpc.mmapFileBytesRead),
          mmapReadRetries: finiteNumber(grpc.mmapReadRetries),
          mmapTornFramesDropped: finiteNumber(grpc.mmapTornFramesDropped),
          grpcProductionToReceiveP50Ms: timing('productionToReceiveLatencyMs', 'p50'),
          grpcProductionToReceiveP95Ms: timing('productionToReceiveLatencyMs', 'p95'),
          grpcProductionToUsableP50Ms: timing('productionToUsableLatencyMs', 'p50'),
          grpcProductionToUsableP95Ms: timing('productionToUsableLatencyMs', 'p95'),
          grpcProtobufDecodeP50Ms: timing('protobufDecodeTimeMs', 'p50'),
          grpcProtobufDecodeP95Ms: timing('protobufDecodeTimeMs', 'p95'),
          mmapReadCopyP50Ms: timing('sharedReadCopyTimeMs', 'p50'),
          mmapReadCopyP95Ms: timing('sharedReadCopyTimeMs', 'p95'),
        }),
  };
}

function readServeEmuEncoderStats(
  source: Record<string, unknown>,
  session: Record<string, unknown> | null,
): DeviceStreamEncoderStats {
  return {
    codec: nonEmptyString(source.codec),
    encodeFps: finiteNumber(source.fps),
    targetBitrateBps: finiteNumber(source.configuredBitrateBps),
    encodeMsPerFrame: null,
    framesEncoded: finiteNumber(source.frames),
    framesSent: null,
    framesDropped: null,
    packetLossRatio: null,
    qualityLimitationReason: null,
    publisherFps: null,
    publisherSubmittedFrames: finiteNumber(session?.submittedFrames),
    publisherDroppedFrames: finiteNumber(session?.publisherDroppedFrames),
    payloadBitrateBps: null,
  };
}

function readWebRtcPublisherCounters(
  value: Record<string, unknown>,
  session: Record<string, unknown> | null,
): WebRtcPublisherCounters | null {
  if (session === null) return null;
  const atMs = finiteNumber(value.sampledAt);
  const submittedFrames = finiteNumber(session.submittedFrames);
  const payloadBytesSubmitted = finiteNumber(session.payloadBytesSubmitted);
  if (atMs === null || submittedFrames === null || payloadBytesSubmitted === null) return null;
  return { atMs, submittedFrames, payloadBytesSubmitted };
}

/** Normalize serve-emu's source/viewer response or serve-sim's sender-session response. */
export function readWebRtcServerStats(value: unknown, sessionId: string): WebRtcServerStats {
  if (!isRecord(value)) {
    return { serverFps: null, encoder: null, capture: null, publisherCounters: null };
  }

  const session = Array.isArray(value.sessions)
    ? value.sessions.find((candidate) => isRecord(candidate) && candidate.sessionId === sessionId)
    : null;
  const matchingSession = isRecord(session) ? session : null;
  const source = isRecord(value.source) ? value.source : null;
  if (source !== null) {
    return {
      serverFps: finiteNumber(source.fps),
      encoder: readServeEmuEncoderStats(source, matchingSession),
      capture: readWebRtcCaptureStats(value.capture),
      publisherCounters: readWebRtcPublisherCounters(value, matchingSession),
    };
  }

  const directServerFps = finiteNumber(value.serverFps);
  const serverFps =
    matchingSession === null
      ? directServerFps
      : (finiteNumber(matchingSession.sourceFps) ??
        finiteNumber(matchingSession.reportedFps) ??
        directServerFps);

  return {
    serverFps,
    encoder: readWebRtcEncoderStats(matchingSession ?? value.encoder),
    capture: readWebRtcCaptureStats(value.capture),
    publisherCounters: null,
  };
}

/** Derive per-viewer publisher rates from cumulative package-owned serve-emu counters. */
export function describeWebRtcPublisherCounters(
  previous: WebRtcPublisherCounters | null,
  current: WebRtcPublisherCounters,
): WebRtcPublisherDescription {
  if (previous === null) return { publisherFps: null, payloadBitrateBps: null };
  const elapsedMs = current.atMs - previous.atMs;
  if (elapsedMs < MIN_WINDOW_MS) return { publisherFps: null, payloadBitrateBps: null };

  const submittedFrames = current.submittedFrames - previous.submittedFrames;
  const payloadBytes = current.payloadBytesSubmitted - previous.payloadBytesSubmitted;
  const elapsedSeconds = elapsedMs / 1_000;
  return {
    publisherFps: submittedFrames < 0 ? null : submittedFrames / elapsedSeconds,
    payloadBitrateBps: payloadBytes < 0 ? null : (payloadBytes * 8) / elapsedSeconds,
  };
}

export function appendStreamStatsSample(
  samples: readonly DeviceStreamStatsSample[],
  sample: DeviceStreamStatsSample,
): DeviceStreamStatsSample[] {
  return [...samples, sample].slice(-HISTORY_LIMIT);
}

async function requestWebRtcServerStats(
  statsUrl: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<WebRtcServerStats> {
  const url = new URL(statsUrl, window.location.href);
  url.searchParams.set('sessionId', sessionId);
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`WebRTC server statistics unavailable (${response.status})`);
  }
  return readWebRtcServerStats(await response.json(), sessionId);
}

function emptyStats(): DeviceStreamStats {
  return {
    samples: [],
    encoder: null,
    capture: null,
    stale: false,
    serverStale: false,
  };
}

/** Own the single stats poll for a WebRTC peer so UI remounts do not reset history. */
export function useWebRtcStreamStats(
  connection: WebRtcStatsConnection | null,
  statsUrl: string,
  presentedFrames: Readonly<{ current: number }>,
): DeviceStreamStats | null {
  const [stats, setStats] = useState<DeviceStreamStats | null>(null);
  const previousRef = useRef<WebRtcClientCounters | null>(null);
  const lastClientSampleAtRef = useRef(0);

  useEffect(() => {
    previousRef.current = null;
    lastClientSampleAtRef.current = 0;
    if (connection === null || !statsUrl) {
      setStats(null);
      return;
    }

    setStats(emptyStats());
    const pollingStartedAt = Date.now();
    let stopped = false;
    let clientPolling = false;
    let serverPolling = false;
    let serverStats: WebRtcServerStats = {
      serverFps: null,
      encoder: null,
      capture: null,
      publisherCounters: null,
    };
    let previousPublisherCounters: WebRtcPublisherCounters | null = null;
    let lastServerSampleAt = 0;
    let serverController: AbortController | null = null;

    const sampleServer = async () => {
      if (serverPolling || stopped) return;
      serverPolling = true;
      serverController = new AbortController();
      const controller = serverController;
      const timeout = window.setTimeout(() => controller.abort(), SERVER_REQUEST_TIMEOUT_MS);
      try {
        const next = await requestWebRtcServerStats(
          statsUrl,
          connection.sessionId,
          controller.signal,
        );
        if (stopped) return;
        const publisher = next.publisherCounters
          ? describeWebRtcPublisherCounters(previousPublisherCounters, next.publisherCounters)
          : { publisherFps: null, payloadBitrateBps: null };
        if (next.publisherCounters) previousPublisherCounters = next.publisherCounters;
        const encoder = next.encoder ? { ...next.encoder, ...publisher } : null;
        serverStats = { ...next, encoder };
        lastServerSampleAt = Date.now();
        setStats((current) =>
          current
            ? {
                ...current,
                encoder,
                capture: next.capture,
                serverStale: false,
              }
            : current,
        );
      } catch {
        // Retain the last successful payload; the server watchdog marks it stale.
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
        lastClientSampleAtRef.current = atMs;
        const next: DeviceStreamStatsSample = {
          atMs,
          serverFps: serverStats.serverFps,
          ...client,
        };
        setStats((current) => {
          const retained = current ?? emptyStats();
          return {
            ...retained,
            samples: appendStreamStatsSample(retained.samples, next),
            stale: false,
          };
        });
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
      const now = Date.now();
      const lastClientSampleAt = lastClientSampleAtRef.current || pollingStartedAt;
      const lastServerSample = lastServerSampleAt || pollingStartedAt;
      const stale = now - lastClientSampleAt > STALE_AFTER_MS;
      const serverStale = now - lastServerSample > STALE_AFTER_MS;
      setStats((current) => {
        if (current === null || (current.stale === stale && current.serverStale === serverStale)) {
          return current;
        }
        return { ...current, stale, serverStale };
      });
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
