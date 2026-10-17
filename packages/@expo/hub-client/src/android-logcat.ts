/** SSE event names that carry logcat lines from serve-emu's `/api/logcat`. */
export const ANDROID_LOGCAT_LINE_EVENTS = ["logs", "log"] as const;

function lineOf(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const line = (value as { line?: unknown }).line;
  return typeof line === "string" ? line : null;
}

/**
 * serve-emu sends batched `logs` events (`{ lines: [{ line, at }] }`). Servers
 * from before the batching sent one `log` event (`{ line, at }`) per line.
 */
export function parseAndroidLogcatLines(eventType: string, data: string): string[] {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return [];
  }
  if (eventType === "log") {
    const line = lineOf(payload);
    return line === null ? [] : [line];
  }
  if (eventType !== "logs" || !payload || typeof payload !== "object") return [];
  const lines = (payload as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) return [];
  return lines.map(lineOf).filter((line): line is string => line !== null);
}
