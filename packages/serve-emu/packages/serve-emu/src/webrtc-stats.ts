import type {
  WebRtcFrameDelivery,
  WebRtcPublisher,
  WebRtcPublisherSessionStats,
} from "./webrtc-publisher.ts";
import type { FrameStatsSummary } from "./frame-stat-window.ts";
import type { StreamMode } from "./shared/api-contracts.ts";
import type { GrpcCaptureDiagnostics } from "./stream-session.ts";
import {
  corsHeadersForRequest,
  isAllowedBrowserOrigin,
  type BrowserOriginPolicy,
} from "./origin-policy.ts";
import {
  parseWebRtcStatsSessionId,
  WebRtcSignalingError,
} from "./webrtc-signaling.ts";

export type WebRtcSourceStats = {
  /** Active capture implementation producing the encoded stream. */
  streamMode: StreamMode;
  codec: string;
  width: number;
  height: number;
  /** Encoded, non-configuration H.264 access units received from the active source. */
  frames: number;
  /** Encoded access units received during the most recent one-second source window. */
  fps: number;
  /** Configured capture/encoder ceiling, which may exceed measured output FPS. */
  configuredFps: number;
  /** Android encoder setting, not an adaptive WebRTC target bitrate. */
  configuredBitrateBps: number;
  /** Rolling encoded-frame size and arrival-interval summary. */
  frameStats: FrameStatsSummary | null;
};

export type WebRtcStatsReport = {
  sampledAt: number;
  source: WebRtcSourceStats;
  sessions: WebRtcPublisherSessionStats[];
  capture: {
    /** Source frames offered while at least one viewer could receive them. */
    offeredFrames: number;
    /** Source frames accepted by at least one native media track. */
    forwardedFrames: number;
    /** Source-specific gRPC capture diagnostics; null for scrcpy sessions. */
    grpc: GrpcCaptureDiagnostics | null;
  };
};

export type WebRtcStatsReader = (
  sessionId: string,
  device: string | null,
) => WebRtcStatsReport | null;

const MAX_DEVICE_SERIAL_BYTES = 256;

export class WebRtcStatsRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "WebRtcStatsRequestError";
  }
}

/**
 * Own capture accounting and viewer-scoped report assembly for one source.
 * A missing or zero-peer delivery means no viewer was offered the source frame.
 */
export class WebRtcStatsCollector {
  #offeredFrames = 0;
  #forwardedFrames = 0;

  constructor(private readonly now: () => number = Date.now) {}

  recordDelivery(delivery: WebRtcFrameDelivery | null | undefined): void {
    if (!delivery || (!delivery.accepted && !delivery.awaitingKeyFrame)) return;
    this.#offeredFrames++;
    if (delivery.accepted) this.#forwardedFrames++;
  }

  /** Build a narrow report without exposing broad health/session diagnostics. */
  report(
    source: WebRtcSourceStats,
    publisher: Pick<WebRtcPublisher, "statsForSession">,
    sessionId: string,
    grpcCapture: GrpcCaptureDiagnostics | null = null,
  ): WebRtcStatsReport | null {
    const publisherSession = publisher.statsForSession(sessionId);
    if (!publisherSession) return null;
    return {
      sampledAt: this.now(),
      source: { ...source },
      sessions: [{ ...publisherSession }],
      capture: {
        offeredFrames: this.#offeredFrames,
        forwardedFrames: this.#forwardedFrames,
        grpc: grpcCapture,
      },
    };
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function statsFailure(
  code: string,
  status: number,
  headers: HeadersInit,
  message?: string,
): Response {
  return Response.json(
    {
      ok: false,
      error: code,
      ...(message ? { message } : {}),
    },
    { status, headers },
  );
}

function parseDevice(searchParams: URLSearchParams): string | null {
  const values = searchParams.getAll("device");
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new WebRtcStatsRequestError(
      "Specify exactly one device for WebRTC statistics.",
      "invalid_device",
    );
  }
  const device = values[0];
  if (
    device.length === 0 ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(device) ||
    new TextEncoder().encode(device).byteLength > MAX_DEVICE_SERIAL_BYTES
  ) {
    throw new WebRtcStatsRequestError(
      `Device must be a non-empty serial of at most ${MAX_DEVICE_SERIAL_BYTES} bytes without whitespace or control characters.`,
      "invalid_device",
    );
  }
  return device;
}

/** Serve the package-owned endpoint while keeping idle polling observational. */
export function handleWebRtcStatsRequest(
  request: Request,
  policy: BrowserOriginPolicy,
  readStats: WebRtcStatsReader,
  onError: (error: unknown) => void = (error) =>
    console.error(`serve-emu WebRTC stats unavailable: ${errorMessage(error)}`),
): Response {
  const corsHeaders = corsHeadersForRequest(request, policy, "GET, OPTIONS");
  const jsonHeaders = {
    ...corsHeaders,
    "Content-Type": "application/json; charset=utf-8",
  };
  if (!isAllowedBrowserOrigin(request, policy)) {
    return statsFailure(
      "forbidden_origin",
      403,
      jsonHeaders,
      "Request origin is not allowed for WebRTC statistics.",
    );
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (request.method !== "GET") {
    return statsFailure("method_not_allowed", 405, jsonHeaders);
  }

  let sessionId: string;
  let device: string | null;
  try {
    const searchParams = new URL(request.url).searchParams;
    const sessionIds = searchParams.getAll("sessionId");
    if (sessionIds.length > 1) {
      throw new WebRtcStatsRequestError(
        "Specify exactly one WebRTC session ID.",
        "invalid_session_id",
      );
    }
    sessionId = parseWebRtcStatsSessionId(sessionIds[0] ?? null);
    device = parseDevice(searchParams);
  } catch (error) {
    const expected =
      error instanceof WebRtcSignalingError ||
      error instanceof WebRtcStatsRequestError;
    const status = expected ? error.status : 400;
    const code = expected ? error.code : "invalid_session_id";
    return statsFailure(code, status, jsonHeaders, errorMessage(error));
  }

  try {
    const report = readStats(sessionId, device);
    if (!report) {
      return statsFailure("webrtc_stats_unavailable", 503, jsonHeaders);
    }
    return Response.json(report, { headers: jsonHeaders });
  } catch (error) {
    if (error instanceof WebRtcStatsRequestError) {
      return statsFailure(error.code, error.status, jsonHeaders, error.message);
    }
    onError(error);
    return statsFailure("webrtc_stats_unavailable", 503, jsonHeaders);
  }
}
