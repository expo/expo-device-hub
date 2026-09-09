import { parseGesture, type Gesture } from "./control-contracts.ts";
import type { DeviceSize } from "./api-contracts.ts";

export type WsMessageOptions = {
  /** Set false when the sender does not need a JSON acknowledgement. */
  ack?: boolean;
  /** Set false to keep an action out of session recording. */
  record?: boolean;
};

export type WsGestureMessage = Gesture & WsMessageOptions;
export type WsResetVideoMessage = { type: "reset-video"; ack?: boolean };
export type WsClientMessage = WsGestureMessage | WsResetVideoMessage;

export type WsAckMessage = { ok: true };
/** Kept as a string for compatibility with the existing WebSocket wire format. */
export type WsFailureMessage = { ok: false; error: string };
export type WsVideoSessionMessage = { type: "video-session"; size: DeviceSize };
export type WsServerMessage = WsAckMessage | WsFailureMessage | WsVideoSessionMessage;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function parseWsClientMessage(value: unknown): WsClientMessage {
  const source = record(value, "WebSocket client message");
  const ack = optionalBoolean(source.ack, "ack");
  if (source.type === "reset-video") {
    return { type: "reset-video", ...(ack === undefined ? {} : { ack }) };
  }

  const recordAction = optionalBoolean(source.record, "record");
  const gesture = parseGesture(source);
  return {
    ...gesture,
    ...(ack === undefined ? {} : { ack }),
    ...(recordAction === undefined ? {} : { record: recordAction }),
  } as WsGestureMessage;
}

export function parseWsClientJson(raw: string): WsClientMessage {
  try {
    return parseWsClientMessage(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("WebSocket client message must be valid JSON");
    throw error;
  }
}

export function isWsClientMessage(value: unknown): value is WsClientMessage {
  try {
    parseWsClientMessage(value);
    return true;
  } catch {
    return false;
  }
}

export function parseWsServerMessage(value: unknown): WsServerMessage {
  const source = record(value, "WebSocket server message");
  if (source.type === "video-session") {
    const size = record(source.size, "video session size");
    if (
      typeof size.width !== "number" ||
      !Number.isFinite(size.width) ||
      size.width <= 0 ||
      typeof size.height !== "number" ||
      !Number.isFinite(size.height) ||
      size.height <= 0
    ) {
      throw new TypeError("video session dimensions must be positive finite numbers");
    }
    return { type: "video-session", size: { width: size.width, height: size.height } };
  }
  if (source.ok === true) return { ok: true };
  if (source.ok === false && typeof source.error === "string") {
    return { ok: false, error: source.error };
  }
  throw new TypeError("unsupported WebSocket server message");
}

export function parseWsServerJson(raw: string): WsServerMessage {
  try {
    return parseWsServerMessage(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new TypeError("WebSocket server message must be valid JSON");
    throw error;
  }
}

export function isWsServerMessage(value: unknown): value is WsServerMessage {
  try {
    parseWsServerMessage(value);
    return true;
  } catch {
    return false;
  }
}
