import { describe, expect, test } from 'bun:test';

import {
  buildWebRtcOfferPayload,
  isRetryableWebRtcOfferStatus,
  preferredVideoCodecs,
  videoRtpArriving,
  shouldFallbackCodecAfterFirstFrameTimeout,
  type WebRtcIceServer,
  type WebRtcVideoCodecCapability,
} from '../useWebRtcStream';

describe('WebRTC stream options', () => {
  test('recognizes legacy mediaType-only video before first paint', async () => {
    const report = new Map([['video', {
      type: 'inbound-rtp', mediaType: 'video', framesReceived: 10,
    }]]) as unknown as RTCStatsReport;
    const peer = { getStats: async () => report } as RTCPeerConnection;
    expect(await videoRtpArriving(peer)).toBe(true);
  });

  test('first-frame diagnosis finishes even when the browser stats read hangs', async () => {
    const peer = { getStats: () => new Promise<RTCStatsReport>(() => {}) } as RTCPeerConnection;
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([videoRtpArriving(peer), new Promise(resolve => { timer = setTimeout(() => resolve('hung'), 2_100); })]);
    clearTimeout(timer!);
    expect(result).toBe(false);
  });
  test('a locked helper can retry a transient missing offer route', () => {
    expect(isRetryableWebRtcOfferStatus(404, true)).toBe(true);
    expect(isRetryableWebRtcOfferStatus(404, false)).toBe(false);
    expect(isRetryableWebRtcOfferStatus(401, true)).toBe(false);
  });
  test('prefers H.264 packetization-mode=1 before other H.264 formats', () => {
    const vp8 = { mimeType: 'video/VP8' };
    const h264Mode0 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'profile-level-id=42e01f;packetization-mode=0',
    };
    const h264Mode1 = {
      mimeType: 'video/H264',
      sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
    };
    const codecs: WebRtcVideoCodecCapability[] = [vp8, h264Mode0, h264Mode1];

    expect(preferredVideoCodecs(codecs, 'h264')).toEqual([h264Mode1, h264Mode0, vp8]);
  });

  test('keeps the requested non-H.264 codec first', () => {
    const h264 = { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1' };
    const vp8 = { mimeType: 'video/VP8' };
    const vp9 = { mimeType: 'video/VP9' };

    expect(preferredVideoCodecs([h264, vp8, vp9], 'vp9')).toEqual([vp9, h264, vp8]);
  });

  test('includes ICE servers in offers by default for serve-sim', () => {
    const iceServers: WebRtcIceServer[] = [{ urls: ['stun:example.test'] }];

    expect(
      buildWebRtcOfferPayload({
        description: { type: 'offer', sdp: 'v=0' },
        sessionId: 'session-1',
        codec: 'vp8',
        iceServers,
      }),
    ).toEqual({
      type: 'offer',
      sdp: 'v=0',
      sessionId: 'session-1',
      codec: 'vp8',
      iceServers,
    });
  });

  test('omits ICE servers from offers for host-configured serve-emu signaling', () => {
    expect(
      buildWebRtcOfferPayload({
        description: { type: 'offer', sdp: 'v=0' },
        sessionId: 'session-1',
        codec: 'h264',
        iceServers: [{ urls: ['stun:example.test'] }],
        sendIceServersInOffer: false,
      }),
    ).toEqual({
      type: 'offer',
      sdp: 'v=0',
      sessionId: 'session-1',
      codec: 'h264',
    });
  });

  test('retries transient offer responses but not permanent client errors', () => {
    for (const status of [408, 425, 429, 500, 503]) {
      expect(isRetryableWebRtcOfferStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isRetryableWebRtcOfferStatus(status)).toBe(false);
    }
  });

  test('can disable codec fallback for an established connection', () => {
    expect(shouldFallbackCodecAfterFirstFrameTimeout(true, 'connected')).toBe(true);
    expect(shouldFallbackCodecAfterFirstFrameTimeout(false, 'connected')).toBe(false);
    expect(shouldFallbackCodecAfterFirstFrameTimeout(true, 'failed')).toBe(false);
  });
});

 test('raises iOS asymmetric H.264 offers while preserving Android and other codecs', () => {
  const sdp = 'a=fmtp:102 level-asymmetry-allowed=1;profile-level-id=42e01f';
  const options = { description: {type: 'offer' as const, sdp}, sessionId: 'A', codec: 'h264' as const, iceServers: [] };
  expect(buildWebRtcOfferPayload(options).sdp).toBe(sdp);
  expect(buildWebRtcOfferPayload({...options, raiseH264Level: true}).sdp).toContain('42e034');
  expect(buildWebRtcOfferPayload({...options, codec: 'vp8', raiseH264Level: true}).sdp).toBe(sdp);
 });
