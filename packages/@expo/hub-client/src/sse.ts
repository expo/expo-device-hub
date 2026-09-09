export interface ParsedSseBlock {
  event: string;
  data: string;
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
