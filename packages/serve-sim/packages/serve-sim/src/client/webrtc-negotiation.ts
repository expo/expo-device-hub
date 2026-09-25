type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type SendBeaconLike = (url: string | URL, data?: BodyInit | null) => boolean;

export class WebRtcSignalingBusyError extends Error {
  constructor() {
    super("WebRTC signaling stayed busy for too long. Reload to try again.");
    this.name = "WebRtcSignalingBusyError";
  }
}

export class WebRtcSignalingTimeoutError extends Error {
  constructor() {
    super("WebRTC signaling timed out.");
    this.name = "WebRtcSignalingTimeoutError";
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new DOMException("The operation was aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/// Callers arm a reconnect behind this close, so it cannot be allowed to hang.
const CLOSE_TIMEOUT_MS = 2_000;

export async function closeWebRtcSession({
  url,
  sessionId,
  keepalive = false,
  sendBeacon,
  fetchImpl = fetch,
}: {
  url: string;
  sessionId: string;
  keepalive?: boolean;
  sendBeacon?: SendBeaconLike;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const body = JSON.stringify({ sessionId });
  const beacon = sendBeacon ?? (
    typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : undefined
  );
  if (keepalive && beacon) {
    try {
      // text/plain is CORS-safelisted, so direct helper ports do not need an
      // unload-time preflight that the browser may never finish.
      if (beacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
    } catch {}
  }
  // A helper that accepts the socket and never answers would otherwise hold the reconnect that
  // follows this. An unload close is left alone: the page is going away regardless.
  await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive,
    signal: keepalive ? undefined : AbortSignal.timeout(CLOSE_TIMEOUT_MS),
  }).then(() => undefined, () => undefined);
}

/// Only contention clears by itself. A 409 naming another reason, such as a device with no
/// panel streams, is final. One with no readable reason keeps the old treatment as busy.
/// A body read that is aborted rejects, so the caller's deadline still applies to it.
async function isSignalingBusy(response: Response): Promise<boolean> {
  const text = await response.clone().text();
  let error: unknown;
  try {
    error = (JSON.parse(text) as { error?: unknown } | null)?.error;
  } catch {}
  return error === undefined || error === "webrtc_session_busy";
}

/**
 * Post an SDP offer, retrying while the native publisher negotiates another
 * peer. Active peers can coexist; only offer setup is serialized.
 * Every HTTP attempt receives its own timeout so time spent waiting on 409s
 * cannot consume the accepted offer's native signaling window.
 */
export async function postWebRtcOffer({
  url,
  body,
  signal,
  requestTimeoutMs,
  busyRetryIntervalMs,
  busyRetryCount,
  fetchImpl = fetch,
}: {
  url: string;
  body: string;
  signal?: AbortSignal;
  requestTimeoutMs: number;
  busyRetryIntervalMs: number;
  busyRetryCount: number;
  fetchImpl?: FetchLike;
}): Promise<Response> {
  for (let attempt = 0; attempt <= busyRetryCount; attempt++) {
    if (signal?.aborted) throw abortError(signal);

    const requestController = new AbortController();
    let timedOut = false;
    const abortRequest = () => requestController.abort(signal ? abortError(signal) : undefined);
    signal?.addEventListener("abort", abortRequest, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
    }, requestTimeoutMs);

    let response: Response;
    let busy: boolean;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body,
      });
      // Headers come before the body, so a 409 is read under the same deadline and abort.
      busy = response.status === 409 && (await isSignalingBusy(response));
    } catch (error) {
      if (timedOut && !signal?.aborted) throw new WebRtcSignalingTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortRequest);
    }

    if (!busy) return response;
    await response.body?.cancel();
    if (attempt === busyRetryCount) throw new WebRtcSignalingBusyError();
    await waitForRetry(busyRetryIntervalMs, signal);
  }

  throw new WebRtcSignalingBusyError();
}
