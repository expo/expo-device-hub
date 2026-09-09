import { appendFileSync } from "node:fs";

const SAMPLE_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;
const NO_SESSION = 404;

// One sender-stats sample a second, as NDJSON. A live panel cannot catch a stall that happens once
// in a few minutes; a file can be read afterwards and lines up with the browser recording by timestamp.
export function startStreamDebugLog({
  path,
  statsUrl,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  onError = (message: string) => console.error(message),
}: {
  path: string;
  statsUrl: (device: string) => string;
    fetchImpl?: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  now?: () => string;
  onError?: (message: string) => void;
}): { sample: (device: string) => Promise<void> } {
  let warned = false;
  const inFlight = new Set<string>();

  const sample = async (device: string): Promise<void> => {
    // Skip the tick rather than queue behind a stalled request: at one sample a second an
    // unbounded queue would outlive the stall it was meant to record.
    if (inFlight.has(device)) return;
    inFlight.add(device);
    let line: string | null;
    try {
      const response = await fetchImpl(statsUrl(device), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 404 means no session is streaming yet. Recording starts when a viewer connects, so writing
      // a line a second until then would bury the samples that matter.
      if (response.status === NO_SESSION) return;
      const body: unknown = response.ok ? await response.json() : null;
      line = JSON.stringify({ at: now(), device, status: response.status, stats: body });
    } catch (error) {
      line = JSON.stringify({
        at: now(),
        device,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight.delete(device);
    }
    try {
      appendFileSync(path, line + "\n");
    } catch (error) {
      // One warning only: a full disk would otherwise print once a second for the whole session.
      if (!warned) {
        warned = true;
        onError(`Could not write the stream debug log to ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
    }
  };

  return { sample };
}

export function runStreamDebugLog(
  devices: readonly string[],
  logger: { sample: (device: string) => Promise<void> },
  intervalMs = SAMPLE_MS,
): () => void {
  const timer = setInterval(() => {
    for (const device of devices) void logger.sample(device);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
