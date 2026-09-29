/** Minimal accepted WebSocket surface supported by the Node and embedded hosts. */
export interface UpgradeHandlerWebSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  terminate?(): void;
  on(event: "message", listener: (data: Buffer<ArrayBufferLike>) => void): void;
  on(event: "error", listener: (error?: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "pong", listener: () => void): void;
}
