type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
      reject(
        signal ? abortError(signal) : new DOMException("The operation was aborted", "AbortError"),
      );
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

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
  const beacon =
    sendBeacon ??
    (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon.bind(navigator)
      : undefined);
  if (keepalive && beacon) {
    try {
      if (beacon(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
    } catch {}
  }
  await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive,
  }).then(
    () => undefined,
    () => undefined,
  );
}

/** Post an SDP offer, retrying while native offer setup is busy. */
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
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: requestController.signal,
        body,
      });
    } catch (error) {
      if (timedOut && !signal?.aborted) throw new WebRtcSignalingTimeoutError();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortRequest);
    }

    if (response.status !== 409) return response;
    await response.body?.cancel();
    if (attempt === busyRetryCount) throw new WebRtcSignalingBusyError();
    await waitForRetry(busyRetryIntervalMs, signal);
  }

  throw new WebRtcSignalingBusyError();
}
