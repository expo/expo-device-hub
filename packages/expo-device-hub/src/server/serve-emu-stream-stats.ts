const WEBRTC_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const JSON_HEADERS = {
  'Cache-Control': 'no-store',
} as const;

export const SERVE_EMU_STREAM_STATS_PATH = '/webrtc/stats';
export const DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS = 8_000_000;

export interface ServeEmuStreamHealth {
  codec?: string;
  frames: number;
  sourceFps: number;
  targetBitrateBps?: number;
  webRtcEnabled?: boolean;
}

export interface ServeEmuEncoderStats {
  codec: string | null;
  encodeFps: number;
  targetBitrateBps: number;
  encodeMsPerFrame: null;
  framesEncoded: number;
  framesSent: null;
  framesDropped: null;
  packetLossRatio: null;
  qualityLimitationReason: null;
}

export interface ServeEmuCaptureStats {
  screenFrames: null;
  idleFrames: null;
  offeredFrames: number | null;
  forwardedFrames: null;
  pumpRestarts: null;
}

export interface ServeEmuStreamStats {
  sampledAt: number;
  serverFps: number;
  frames: number;
  encoder: ServeEmuEncoderStats;
  capture: ServeEmuCaptureStats;
}

/**
 * Keep the browser-facing polling response independent of serve-emu's broad
 * health snapshot, which also contains session events and device diagnostics.
 */
export function readServeEmuStreamStats(
  health: ServeEmuStreamHealth,
  sampledAt = Date.now(),
): ServeEmuStreamStats {
  return {
    sampledAt,
    serverFps: health.sourceFps,
    frames: health.frames,
    encoder: {
      codec: typeof health.codec === 'string' && health.codec.length > 0 ? health.codec : null,
      encodeFps: health.sourceFps,
      targetBitrateBps:
        health.targetBitrateBps ?? DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS,
      encodeMsPerFrame: null,
      framesEncoded: health.frames,
      // serve-emu's broad health detail does not identify peers by WebRTC
      // session ID. Do not guess from the first (or only) peer.
      framesSent: null,
      framesDropped: null,
      packetLossRatio: null,
      qualityLimitationReason: null,
    },
    capture: {
      // Android's scrcpy stream begins after screen capture and encoding, so it
      // cannot distinguish screen frames from an idle-frame floor.
      screenFrames: null,
      idleFrames: null,
      // Every counted non-config access unit is offered when the WebRTC
      // publisher is enabled. A WebSocket stream has no such delivery.
      offeredFrames: health.webRtcEnabled === true ? health.frames : null,
      forwardedFrames: null,
      pumpRestarts: null,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function serveEmuStreamStatsUnavailable(): Response {
  return jsonResponse({ error: 'webrtc_stats_unavailable' }, 503);
}

/** Handle the serve-sim-compatible stats URL without exposing serve-emu health. */
export async function handleServeEmuStreamStatsRequest(
  request: Request,
  readHealth: () => ServeEmuStreamHealth | Promise<ServeEmuStreamHealth>,
  now: () => number = Date.now,
  onError: (error: unknown) => void = (error) =>
    console.error(
      `serve-emu WebRTC stats unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ),
): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }

  const sessionId = new URL(request.url).searchParams.get('sessionId');
  if (sessionId && !WEBRTC_SESSION_ID_PATTERN.test(sessionId)) {
    return jsonResponse(
      { error: 'invalid_session_id', message: 'Invalid WebRTC session ID' },
      400,
    );
  }

  try {
    return jsonResponse(readServeEmuStreamStats(await readHealth(), now()));
  } catch (error) {
    onError(error);
    return serveEmuStreamStatsUnavailable();
  }
}
