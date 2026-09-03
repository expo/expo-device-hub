import { describe, expect, test } from 'bun:test';

import {
  appendStreamStatsSample,
  describeWebRtcClientCounters,
  describeWebRtcPublisherCounters,
  readWebRtcClientCounters,
  readWebRtcServerStats,
  type WebRtcClientCounters,
} from '../stream-stats';
import { type DeviceStreamStatsSample } from '../types';

function statsReport(...entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(
    entries.map((entry, index) => [`entry-${index}`, entry]),
  ) as unknown as RTCStatsReport;
}

function counters(overrides: Partial<WebRtcClientCounters> = {}): WebRtcClientCounters {
  return {
    atMs: 1_000,
    presentedFrames: 100,
    bytesReceived: 100_000,
    framesDropped: 2,
    freezeCount: 1,
    freezeDurationMs: 500,
    packetsReceived: 1_000,
    packetsLost: 10,
    jitterMs: 8,
    jitterBufferDelaySeconds: 4,
    jitterBufferEmittedCount: 100,
    roundTripMs: 20,
    icePath: 'direct',
    ...overrides,
  };
}

function sample(atMs: number): DeviceStreamStatsSample {
  return {
    atMs,
    serverFps: atMs,
    clientFps: atMs,
    clientBitrateBps: atMs,
    clientPacketLossRatio: null,
    clientJitterMs: null,
    clientJitterBufferMs: null,
    clientDroppedFrames: null,
    clientFreezeCount: null,
    clientFreezeDurationMs: null,
    clientRoundTripMs: null,
    clientIcePath: 'unknown',
  };
}

describe('readWebRtcClientCounters', () => {
  test('reads the active video receiver and converts browser seconds to milliseconds', () => {
    expect(
      readWebRtcClientCounters(
        statsReport(
          { type: 'inbound-rtp', kind: 'audio', framesDecoded: 900, bytesReceived: 9_000 },
          {
            type: 'inbound-rtp',
            kind: 'video',
            framesDecoded: 10,
            bytesReceived: 1_000,
          },
          {
            type: 'inbound-rtp',
            mediaType: 'video',
            framesDecoded: 20,
            bytesReceived: 2_000,
            framesDropped: 3,
            freezeCount: 2,
            totalFreezesDuration: 0.75,
            packetsReceived: 90,
            packetsLost: 10,
            jitter: 0.012,
            jitterBufferDelay: 4,
            jitterBufferEmittedCount: 100,
          },
        ),
        1_000,
        12,
      ),
    ).toEqual({
      atMs: 1_000,
      presentedFrames: 12,
      bytesReceived: 2_000,
      framesDropped: 3,
      freezeCount: 2,
      freezeDurationMs: 750,
      packetsReceived: 90,
      packetsLost: 10,
      jitterMs: 12,
      jitterBufferDelaySeconds: 4,
      jitterBufferEmittedCount: 100,
      roundTripMs: null,
      icePath: 'unknown',
    });
  });

  test('uses the transport-selected pair over a nominated relay pair', () => {
    const result = readWebRtcClientCounters(
      statsReport(
        { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 },
        { type: 'transport', selectedCandidatePairId: 'direct-pair' },
        {
          id: 'direct-pair',
          type: 'candidate-pair',
          state: 'succeeded',
          localCandidateId: 'local-host',
          remoteCandidateId: 'remote-srflx',
          currentRoundTripTime: 0.005,
        },
        {
          id: 'relay-pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local-relay',
          remoteCandidateId: 'remote-srflx',
          currentRoundTripTime: 0.18,
        },
        { id: 'local-host', type: 'local-candidate', candidateType: 'host' },
        { id: 'local-relay', type: 'local-candidate', candidateType: 'relay' },
        { id: 'remote-srflx', type: 'remote-candidate', candidateType: 'srflx' },
      ),
      1_000,
      1,
    );

    expect(result?.roundTripMs).toBe(5);
    expect(result?.icePath).toBe('direct');
  });

  test('falls back to the nominated pair and recognizes a TURN relay', () => {
    const result = readWebRtcClientCounters(
      statsReport(
        { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 },
        {
          id: 'relay-pair',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'local-relay',
          remoteCandidateId: 'remote-host',
        },
        { id: 'local-relay', type: 'local-candidate', candidateType: 'relay' },
        { id: 'remote-host', type: 'remote-candidate', candidateType: 'host' },
      ),
      1_000,
      1,
    );

    expect(result?.icePath).toBe('relay');
  });

  test('keeps the ICE path unknown when either candidate type is missing', () => {
    const result = readWebRtcClientCounters(
      statsReport(
        { type: 'inbound-rtp', kind: 'video', framesDecoded: 1 },
        {
          id: 'pair',
          type: 'candidate-pair',
          selected: true,
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
        },
        { id: 'local', type: 'local-candidate', candidateType: 'host' },
      ),
      1_000,
      1,
    );

    expect(result?.icePath).toBe('unknown');
  });

  test('does not invent a zero baseline when inbound video stats are absent', () => {
    expect(
      readWebRtcClientCounters(
        statsReport({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 9_000 }),
        1_000,
        30,
      ),
    ).toBeNull();
  });

  test('preserves missing optional receiver counters as unknown', () => {
    expect(
      readWebRtcClientCounters(
        statsReport({ type: 'inbound-rtp', kind: 'video', framesDecoded: 1, jitter: 0.003 }),
        1_000,
        1,
      ),
    ).toEqual({
      atMs: 1_000,
      presentedFrames: 1,
      bytesReceived: null,
      framesDropped: null,
      freezeCount: null,
      freezeDurationMs: null,
      packetsReceived: null,
      packetsLost: null,
      jitterMs: 3,
      jitterBufferDelaySeconds: null,
      jitterBufferEmittedCount: null,
      roundTripMs: null,
      icePath: 'unknown',
    });
  });
});

describe('describeWebRtcClientCounters', () => {
  test('derives receiver values from the real elapsed window', () => {
    const result = describeWebRtcClientCounters(
      counters(),
      counters({
        atMs: 3_000,
        presentedFrames: 160,
        bytesReceived: 350_000,
        framesDropped: 6,
        freezeCount: 2,
        freezeDurationMs: 2_000,
        packetsReceived: 1_180,
        packetsLost: 30,
        jitterMs: 12,
        jitterBufferDelaySeconds: 4.4,
        jitterBufferEmittedCount: 140,
        roundTripMs: 35,
        icePath: 'relay',
      }),
    );

    expect(result.clientFps).toBe(30);
    expect(result.clientBitrateBps).toBe(1_000_000);
    expect(result.clientPacketLossRatio).toBeCloseTo(0.1, 5);
    expect(result.clientJitterMs).toBe(12);
    expect(result.clientJitterBufferMs).toBeCloseTo(10, 5);
    expect(result.clientDroppedFrames).toBe(4);
    expect(result.clientFreezeCount).toBe(1);
    expect(result.clientFreezeDurationMs).toBe(1_500);
    expect(result.clientRoundTripMs).toBe(35);
    expect(result.clientIcePath).toBe('relay');
  });

  test('leaves window values unknown for the first, short, and backward-clock windows', () => {
    const current = counters({ jitterMs: 9, roundTripMs: 22, icePath: 'relay' });
    const cases: Array<[WebRtcClientCounters | null, WebRtcClientCounters]> = [
      [null, current],
      [current, counters({ atMs: 1_100 })],
      [counters({ atMs: 3_000 }), current],
    ];

    for (const [previous, next] of cases) {
      expect(describeWebRtcClientCounters(previous, next)).toEqual({
        clientFps: null,
        clientBitrateBps: null,
        clientPacketLossRatio: null,
        clientJitterMs: next.jitterMs,
        clientJitterBufferMs: null,
        clientDroppedFrames: null,
        clientFreezeCount: null,
        clientFreezeDurationMs: null,
        clientRoundTripMs: next.roundTripMs,
        clientIcePath: next.icePath,
      });
    }
  });

  test('invalidates reset counters independently', () => {
    const result = describeWebRtcClientCounters(
      counters(),
      counters({
        atMs: 2_000,
        presentedFrames: 1,
        bytesReceived: 200_000,
        framesDropped: 1,
        freezeCount: 2,
        freezeDurationMs: 100,
        packetsReceived: 900,
        packetsLost: 20,
        jitterBufferDelaySeconds: 3,
        jitterBufferEmittedCount: 120,
      }),
    );

    expect(result.clientFps).toBeNull();
    expect(result.clientBitrateBps).toBe(800_000);
    expect(result.clientDroppedFrames).toBeNull();
    expect(result.clientFreezeCount).toBe(1);
    expect(result.clientFreezeDurationMs).toBeNull();
    expect(result.clientPacketLossRatio).toBeNull();
    expect(result.clientJitterBufferMs).toBeNull();
  });

  test('keeps presented FPS when optional receiver counters are missing', () => {
    const result = describeWebRtcClientCounters(
      counters({
        bytesReceived: null,
        framesDropped: null,
        freezeCount: null,
        freezeDurationMs: null,
        packetsReceived: null,
        packetsLost: null,
      }),
      counters({
        atMs: 2_000,
        presentedFrames: 125,
        bytesReceived: null,
        framesDropped: null,
        freezeCount: null,
        freezeDurationMs: null,
        packetsReceived: null,
        packetsLost: null,
      }),
    );

    expect(result.clientFps).toBe(25);
    expect(result.clientBitrateBps).toBeNull();
    expect(result.clientPacketLossRatio).toBeNull();
    expect(result.clientDroppedFrames).toBeNull();
    expect(result.clientFreezeCount).toBeNull();
    expect(result.clientFreezeDurationMs).toBeNull();
  });

  test('keeps unavailable or reset loss independent from the other window values', () => {
    const previous = counters({ packetsLost: null });
    const current = counters({
      atMs: 2_000,
      presentedFrames: 125,
      bytesReceived: 200_000,
      packetsLost: null,
    });
    expect(describeWebRtcClientCounters(previous, current).clientPacketLossRatio).toBeNull();

    const reset = describeWebRtcClientCounters(
      counters({ packetsReceived: 1_000, packetsLost: 10 }),
      counters({ atMs: 2_000, packetsReceived: 900, packetsLost: 20 }),
    );
    expect(reset.clientPacketLossRatio).toBeNull();
    expect(reset.clientFps).toBe(0);
  });

  test('requires emitted frames to calculate the window jitter-buffer mean', () => {
    const result = describeWebRtcClientCounters(
      counters(),
      counters({ atMs: 2_000, jitterBufferDelaySeconds: 4, jitterBufferEmittedCount: 100 }),
    );
    expect(result.clientJitterBufferMs).toBeNull();
  });
});

describe('readWebRtcServerStats', () => {
  test('normalizes the matching serve-sim session and root capture counts', () => {
    expect(
      readWebRtcServerStats(
        {
          sessions: [
            { sessionId: 'other', sourceFps: 60, codec: 'VP8' },
            {
              sessionId: 'viewer',
              sourceFps: 30,
              reportedFps: 29.8,
              codec: 'H264',
              targetKbps: 4_000,
              encodeMsPerFrame: 2.5,
              framesEncoded: 600,
              framesSent: 598,
              sourceFramesDropped: 4,
              lossRatio: 0.01,
              qualityLimitationReason: 'cpu',
            },
          ],
          capture: {
            screenFrames: 900,
            idleFrames: 40,
            offeredFrames: 880,
            forwardedFrames: 830,
            pumpRestarts: 2,
          },
        },
        'viewer',
      ),
    ).toEqual({
      serverFps: 30,
      encoder: {
        codec: 'H264',
        encodeFps: 29.8,
        targetBitrateBps: 4_000_000,
        encodeMsPerFrame: 2.5,
        framesEncoded: 600,
        framesSent: 598,
        framesDropped: 4,
        packetLossRatio: 0.01,
        qualityLimitationReason: 'cpu',
        publisherFps: null,
        publisherSubmittedFrames: null,
        publisherDroppedFrames: null,
        payloadBitrateBps: null,
      },
      capture: {
        screenFrames: 900,
        idleFrames: 40,
        offeredFrames: 880,
        forwardedFrames: 830,
        pumpRestarts: 2,
      },
      publisherCounters: null,
    });
  });

  test('combines serve-emu source metrics with only the requested publisher session', () => {
    expect(
      readWebRtcServerStats(
        {
          sampledAt: 2_000,
          source: {
            codec: 'h264',
            fps: 23.5,
            configuredBitrateBps: 6_000_000,
            frames: 100,
          },
          sessions: [
            {
              sessionId: 'other',
              submittedFrames: 500,
              publisherDroppedFrames: 50,
              payloadBytesSubmitted: 5_000_000,
            },
            {
              sessionId: 'viewer',
              submittedFrames: 99,
              publisherDroppedFrames: 1,
              payloadBytesSubmitted: 750_000,
            },
          ],
          capture: { offeredFrames: 100, forwardedFrames: 98 },
        },
        'viewer',
      ),
    ).toEqual({
      serverFps: 23.5,
      encoder: {
        codec: 'h264',
        encodeFps: 23.5,
        targetBitrateBps: 6_000_000,
        encodeMsPerFrame: null,
        framesEncoded: 100,
        framesSent: null,
        framesDropped: null,
        packetLossRatio: null,
        qualityLimitationReason: null,
        publisherFps: null,
        publisherSubmittedFrames: 99,
        publisherDroppedFrames: 1,
        payloadBitrateBps: null,
      },
      capture: {
        screenFrames: null,
        idleFrames: null,
        offeredFrames: 100,
        forwardedFrames: 98,
        pumpRestarts: null,
      },
      publisherCounters: {
        atMs: 2_000,
        submittedFrames: 99,
        payloadBytesSubmitted: 750_000,
      },
    });
  });

  test('does not use another viewer session and preserves unknown values as null', () => {
    expect(
      readWebRtcServerStats(
        {
          sessions: [{ sessionId: 'other', sourceFps: 60 }],
          capture: { screenFrames: Number.NaN, idleFrames: -1 },
        },
        'viewer',
      ),
    ).toEqual({
      serverFps: null,
      encoder: null,
      capture: {
        screenFrames: null,
        idleFrames: null,
        offeredFrames: null,
        forwardedFrames: null,
        pumpRestarts: null,
      },
      publisherCounters: null,
    });
    expect(readWebRtcServerStats(null, 'viewer')).toEqual({
      serverFps: null,
      encoder: null,
      capture: null,
      publisherCounters: null,
    });
  });

  test('normalizes gRPC producer, transport, and host-copy diagnostics', () => {
    const result = readWebRtcServerStats(
      {
        sampledAt: 2_000,
        source: { codec: 'h264', fps: 58, frames: 500 },
        sessions: [
          {
            sessionId: 'viewer',
            submittedFrames: 490,
            publisherDroppedFrames: 0,
            payloadBytesSubmitted: 2_000_000,
          },
        ],
        capture: {
          offeredFrames: 500,
          forwardedFrames: 490,
          grpc: {
            imageMode: 'mmap',
            sourceTimestampFps: 60,
            rawMessageReceiveFps: 59.5,
            usableImageFps: 59,
            freshEncoderWriteFps: 58.5,
            rawGrpcMessagesReceived: 600,
            rawGrpcMessagesEmitted: 590,
            rawGrpcMessagesCoalesced: 10,
            sequenceGaps: 2,
            imagePayloadBytes: 552_960,
            transportBytes: 55_296_000,
            grpcMessageBytesReceived: 12_000,
            mmapFileBytesRead: 56_000_000,
            mmapReadRetries: 1,
            mmapTornFramesDropped: 0,
            productionToReceiveLatencyMs: { p50: 4.2, p95: 8.1 },
            productionToUsableLatencyMs: { p50: 4.7, p95: 9.2 },
            protobufDecodeTimeMs: { p50: 0.1, p95: 0.2 },
            sharedReadCopyTimeMs: { p50: 0.3, p95: 0.6 },
          },
        },
      },
      'viewer',
    );

    expect(result.capture).toMatchObject({
      grpcImageMode: 'mmap',
      grpcProducerFps: 60,
      grpcReceiveFps: 59.5,
      grpcUsableImageFps: 59,
      grpcEncoderInputFps: 58.5,
      grpcMessagesReceived: 600,
      grpcMessagesEmitted: 590,
      grpcMessagesCoalesced: 10,
      grpcSequenceGaps: 2,
      grpcImagePayloadBytes: 552_960,
      grpcTransportBytes: 55_296_000,
      grpcMessageBytesReceived: 12_000,
      mmapFileBytesRead: 56_000_000,
      mmapReadRetries: 1,
      mmapTornFramesDropped: 0,
      grpcProductionToReceiveP50Ms: 4.2,
      grpcProductionToReceiveP95Ms: 8.1,
      grpcProductionToUsableP50Ms: 4.7,
      grpcProductionToUsableP95Ms: 9.2,
      grpcProtobufDecodeP50Ms: 0.1,
      grpcProtobufDecodeP95Ms: 0.2,
      mmapReadCopyP50Ms: 0.3,
      mmapReadCopyP95Ms: 0.6,
    });
  });
});

describe('describeWebRtcPublisherCounters', () => {
  test('derives accepted frame and H.264 payload rates over the real server window', () => {
    expect(
      describeWebRtcPublisherCounters(
        { atMs: 1_000, submittedFrames: 100, payloadBytesSubmitted: 1_000_000 },
        { atMs: 2_250, submittedFrames: 130, payloadBytesSubmitted: 1_500_000 },
      ),
    ).toEqual({ publisherFps: 24, payloadBitrateBps: 3_200_000 });
  });

  test('keeps first, short, and independently reset counter windows unmeasured', () => {
    const current = { atMs: 1_000, submittedFrames: 100, payloadBytesSubmitted: 1_000_000 };
    expect(describeWebRtcPublisherCounters(null, current)).toEqual({
      publisherFps: null,
      payloadBitrateBps: null,
    });
    expect(
      describeWebRtcPublisherCounters(current, {
        atMs: 1_200,
        submittedFrames: 110,
        payloadBytesSubmitted: 1_100_000,
      }),
    ).toEqual({ publisherFps: null, payloadBitrateBps: null });
    expect(
      describeWebRtcPublisherCounters(current, {
        atMs: 2_000,
        submittedFrames: 90,
        payloadBytesSubmitted: 1_500_000,
      }),
    ).toEqual({ publisherFps: null, payloadBitrateBps: 4_000_000 });
    expect(
      describeWebRtcPublisherCounters(current, {
        atMs: 2_000,
        submittedFrames: 130,
        payloadBytesSubmitted: 900_000,
      }),
    ).toEqual({ publisherFps: 30, payloadBitrateBps: null });
  });
});

test('keeps a bounded chronological stream history', () => {
  const samples = Array.from({ length: 60 }, (_, index) => sample(index));
  const next = sample(60);

  expect(appendStreamStatsSample(samples, next)).toEqual([...samples.slice(1), next]);
});
