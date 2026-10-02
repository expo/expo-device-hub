export const EXEC_WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export type SseRequestHandler = (
  path: string,
  websocketRequest: Request,
) => Response | undefined | Promise<Response | undefined>;

export function messageToString(data: unknown): string {
  const textDecoder = new TextDecoder();
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

export function requestHost(req: Request): string {
  return req.headers.get("host") ?? new URL(req.url).host;
}
