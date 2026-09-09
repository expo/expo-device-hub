export interface ParsedSseBlock {
  event: string;
  data: string;
}

export type SseFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SseSnapshotOptions {
  fetchImpl?: SseFetch;
  signal: AbortSignal;
  settleMs: number;
}

/** Append raw SSE bytes and emit every complete block, retaining a partial tail. */
export function drainSseChunk(
  previous: string,
  chunk: string,
  emit: (block: ParsedSseBlock) => void,
): string {
  let buffer = `${previous}${chunk}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let boundary: number;
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
    const lines = buffer.slice(0, boundary).split('\n');
    buffer = buffer.slice(boundary + 2);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) emit({ event, data });
  }
  return buffer;
}

/** Read one snapshot off an SSE route: the newest block to arrive within `settleMs` of the first. */
export async function readSseSnapshot(
  url: string,
  { fetchImpl = fetch, signal, settleMs }: SseSnapshotOptions,
): Promise<string | null> {
  if (signal.aborted) return null;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const received: string[] = [];
    let buffer = '';
    try {
      while (received.length < 2) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = drainSseChunk(buffer, decoder.decode(value, { stream: true }), (block) => {
          received.push(block.data);
        });
        if (received.length > 0 && settleTimer === null) settleTimer = setTimeout(abort, settleMs);
      }
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      await reader.cancel().catch(() => {});
    }
    return received.at(-1) ?? null;
  } finally {
    if (settleTimer !== null) clearTimeout(settleTimer);
    controller.abort();
    signal.removeEventListener('abort', abort);
  }
}
