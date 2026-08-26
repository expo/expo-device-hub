import { type DeviceEvent } from './types';

export const MAX_IOS_DEVICE_EVENTS = 500;

export type IosEventLogStatus = 'ok' | 'error';

/** The forward-compatible subset of a serve-sim event-log entry consumed by Hub. */
export interface IosEventLogEntry {
  id: number;
  timestamp: string;
  source: string;
  kind: string;
  msg?: string;
  summary?: string;
  device?: string;
  action?: string;
  status?: IosEventLogStatus;
  details?: Record<string, unknown>;
}

/** Initial SSE snapshots use `events`; subsequent frames use `event`. */
export interface IosEventLogPayload {
  events?: IosEventLogEntry[];
  event?: IosEventLogEntry;
}

/** DeviceEvent with the status reported by serve-sim retained for presentation. */
export interface IosDeviceEvent extends DeviceEvent {
  status?: IosEventLogStatus;
}

/**
 * Event history plus a numeric server-ID watermark. The watermark makes a
 * local Clear durable when EventSource/exec-ws reconnects with a snapshot of
 * the server's still-retained entries.
 */
export interface IosEventLogState {
  events: IosDeviceEvent[];
  clearedThroughId: number;
  latestId: number;
  hasSnapshot: boolean;
  clearPending: boolean;
}

const SENSITIVE_DETAIL_KEY =
  /^(?:command|credential|password|path|secret|stderr|stdout|text|token)$/i;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:/-]*$/i;
const MAX_TOKEN_LENGTH = 128;
const MAX_DETAIL_DEPTH = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function wireToken(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    SAFE_TOKEN.test(value)
    ? value
    : null;
}

function parseEntry(value: unknown): IosEventLogEntry | null {
  if (!isRecord(value)) return null;
  if (!Number.isSafeInteger(value.id) || (value.id as number) < 0) return null;
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) {
    return null;
  }

  const source = wireToken(value.source);
  const kind = wireToken(value.kind);
  if (!source || !kind) return null;

  const action = value.action === undefined ? undefined : wireToken(value.action);
  if (value.action !== undefined && !action) return null;
  const status = value.status === 'ok' || value.status === 'error' ? value.status : undefined;
  const details = isRecord(value.details) ? { ...value.details } : undefined;

  return {
    id: value.id as number,
    timestamp: value.timestamp,
    source,
    kind,
    ...(typeof value.msg === 'string' ? { msg: value.msg } : {}),
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(typeof value.device === 'string' ? { device: value.device } : {}),
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(details ? { details } : {}),
  };
}

/** Parse one raw event-log SSE frame. Invalid JSON and malformed shapes return null. */
export function parseIosEventLogPayload(input: unknown): IosEventLogPayload | null {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  const payload: IosEventLogPayload = {};
  let recognized = false;

  if (hasOwn(value, 'events')) {
    if (!Array.isArray(value.events)) return null;
    payload.events = value.events
      .map((entry) => parseEntry(entry))
      .filter((entry): entry is IosEventLogEntry => entry !== null);
    recognized = true;
  }

  if (hasOwn(value, 'event')) {
    const event = parseEntry(value.event);
    if (!event) return recognized ? payload : null;
    payload.event = event;
    recognized = true;
  }

  return recognized ? payload : null;
}

function stableId(deviceUdid: string, eventId: number): string {
  return `ios:${encodeURIComponent(deviceUdid)}:${eventId}`;
}

function numericId(event: DeviceEvent, deviceUdid: string): number | null {
  const prefix = `ios:${encodeURIComponent(deviceUdid)}:`;
  if (!event.id.startsWith(prefix)) return null;
  const value = Number(event.id.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, ' ');
}

function title(value: string): string {
  const humanized = humanize(value);
  return humanized.length > 0 ? `${humanized[0]!.toUpperCase()}${humanized.slice(1)}` : humanized;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pointFrom(
  details: Record<string, unknown> | undefined,
  key: 'start' | 'current',
): { x: number; y: number } | null {
  const point = details?.[key];
  if (!isRecord(point)) return null;
  const x = finiteNumber(point.x);
  const y = finiteNumber(point.y);
  return x === null || y === null ? null : { x, y };
}

function formatCoordinate(value: number): string {
  return Math.min(1, Math.max(0, value)).toFixed(2);
}

function formatPoint(value: { x: number; y: number }): string {
  return `${formatCoordinate(value.x)}, ${formatCoordinate(value.y)}`;
}

function safeKeyboardKey(value: unknown): string {
  if (typeof value !== 'string') return 'key';
  if (value === 'character') return value;
  if (
    /^(?:Arrow(?:Down|Left|Right|Up)|Backspace|CapsLock|Delete|End|Enter|Escape|F\d{1,2}|Home|Insert|Numpad[A-Za-z0-9]+|PageDown|PageUp|Pause|PrintScreen|ScrollLock|Space|Tab)$/.test(
      value,
    ) ||
    /^(?:Alt|Control|Meta|Shift)(?:Left|Right)$/.test(value)
  ) {
    return value;
  }
  return 'character';
}

function sanitizeDetailValue(value: unknown, depth: number): unknown {
  if (depth >= MAX_DETAIL_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeDetailValue(item, depth + 1));
  }
  if (!isRecord(value)) return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_DETAIL_KEY.test(key)
      ? '[redacted]'
      : sanitizeDetailValue(child, depth + 1);
  }
  return sanitized;
}

function safeDetails(entry: IosEventLogEntry): Record<string, unknown> | undefined {
  if (!entry.details) return undefined;
  const details = sanitizeDetailValue(entry.details, 0) as Record<string, unknown>;

  if (entry.kind === 'key') {
    const key = safeKeyboardKey(entry.details.key);
    details.key = key;
    if (key === 'character') {
      details.redacted = true;
      delete details.usage;
    }
  }
  return details;
}

function mappedKind(entry: IosEventLogEntry): string {
  switch (entry.kind) {
    case 'tap':
    case 'drag':
    case 'touch':
    case 'multi-touch':
    case 'scroll':
      return 'touch';
    case 'key':
    case 'software-keyboard':
      return 'keyboard';
    case 'ui-setting':
      return 'settings';
    default:
      return entry.kind;
  }
}

function mappedAction(entry: IosEventLogEntry): string | undefined {
  if (entry.kind === 'tap' || entry.kind === 'drag' || entry.kind === 'scroll') return entry.kind;
  if (entry.kind === 'software-keyboard') return 'toggle';
  if (entry.kind === 'multi-touch') {
    return entry.action ? `multi-touch-${entry.action}` : 'multi-touch';
  }
  return entry.action;
}

function eventMessage(
  entry: IosEventLogEntry,
  details: Record<string, unknown> | undefined,
): string {
  const action = mappedAction(entry);
  switch (entry.kind) {
    case 'tap': {
      const point = pointFrom(details, 'current') ?? pointFrom(details, 'start');
      return point ? `Tap at ${formatPoint(point)}` : 'Tap';
    }
    case 'drag': {
      const start = pointFrom(details, 'start');
      const current = pointFrom(details, 'current');
      return start && current
        ? `Drag from ${formatPoint(start)} to ${formatPoint(current)}`
        : 'Drag';
    }
    case 'touch':
      return action ? `Touch ${humanize(action)}` : 'Touch';
    case 'multi-touch':
      return entry.action ? `Multi-touch ${humanize(entry.action)}` : 'Multi-touch';
    case 'scroll':
      return 'Scroll';
    case 'key': {
      const key = safeKeyboardKey(details?.key);
      return action ? `Key ${humanize(action)} ${key}` : `Key ${key}`;
    }
    case 'software-keyboard':
      return 'Software keyboard';
    case 'button':
      return action ? `Button ${title(action)}` : 'Button';
    case 'rotate':
      return action ? `Rotate ${humanize(action)}` : 'Rotate';
    case 'memory-warning':
      return 'Memory warning';
    case 'ca-debug':
      return action ? `Core Animation ${humanize(action)}` : 'Core Animation setting';
    case 'digital-crown':
      return 'Digital Crown';
    case 'app':
      return action ? `${title(action)} app` : 'App event';
    case 'media':
      return 'Add media';
    case 'screenshot':
      return 'Screenshot';
    case 'camera':
      return action ? `Camera ${humanize(action)}` : 'Camera';
    case 'ui-setting': {
      const value = wireToken(details?.value);
      return action
        ? `Set ${title(action)}${value ? ` to ${title(value)}` : ''}`
        : 'Device setting changed';
    }
    default:
      return `Event ${humanize(entry.kind)}`;
  }
}

/** Map a validated serve-sim event to a stable, privacy-safe Hub row. */
export function mapIosEventLogEntry(entry: IosEventLogEntry, deviceUdid: string): IosDeviceEvent {
  const details = safeDetails(entry);
  const action = mappedAction(entry);
  return {
    id: stableId(deviceUdid, entry.id),
    timestamp: entry.timestamp,
    source: entry.source,
    kind: mappedKind(entry),
    ...(action ? { action } : {}),
    message: eventMessage(entry, details),
    ...(entry.status ? { status: entry.status } : {}),
    ...(details ? { details } : {}),
  };
}

export function createIosEventLogState(clearedThroughId = 0): IosEventLogState {
  const normalizedId = Math.max(0, Math.floor(clearedThroughId));
  return {
    events: [],
    clearedThroughId: normalizedId,
    latestId: normalizedId,
    hasSnapshot: false,
    clearPending: false,
  };
}

/**
 * Merge an initial snapshot or single SSE update by numeric ID. Updates replace
 * an existing row (serve-sim uses this for a completed drag), ordering remains
 * oldest-to-newest, and cleared IDs cannot reappear after a reconnect.
 */
export function mergeIosEventLogPayload(
  state: IosEventLogState,
  input: unknown,
  deviceUdid: string,
): IosEventLogState {
  const payload = parseIosEventLogPayload(input);
  if (!payload) return state;

  const receivedSnapshot = payload.events !== undefined;
  const snapshotLatestId = (payload.events ?? []).reduce(
    (latest, entry) => Math.max(latest, entry.id),
    0,
  );
  const restarted =
    receivedSnapshot &&
    state.hasSnapshot &&
    ((state.latestId > 0 && snapshotLatestId === 0) ||
      (snapshotLatestId > 0 && snapshotLatestId < state.latestId));
  let clearedThroughId = restarted ? 0 : state.clearedThroughId;
  if (receivedSnapshot && state.clearPending) {
    for (const entry of payload.events ?? []) {
      clearedThroughId = Math.max(clearedThroughId, entry.id);
    }
  }

  const byId = new Map<number, IosDeviceEvent>();
  if (!restarted) {
    for (const event of state.events) {
      const id = numericId(event, deviceUdid);
      if (id !== null && id > clearedThroughId) byId.set(id, event);
    }
  }

  const incoming = [...(payload.events ?? []), ...(payload.event ? [payload.event] : [])];
  for (const entry of incoming) {
    if (entry.id <= clearedThroughId) continue;
    byId.set(entry.id, mapIosEventLogEntry(entry, deviceUdid));
  }

  const events = [...byId.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-MAX_IOS_DEVICE_EVENTS)
    .map(([, event]) => event);

  return {
    events,
    clearedThroughId,
    latestId: receivedSnapshot
      ? Math.max(snapshotLatestId, payload.event?.id ?? 0)
      : Math.max(state.latestId, payload.event?.id ?? 0),
    hasSnapshot: state.hasSnapshot || receivedSnapshot,
    clearPending: receivedSnapshot ? false : state.clearPending,
  };
}

/** Clear visible rows and advance the reconnect filter through the newest seen server ID. */
export function clearIosEventLogState(
  state: IosEventLogState,
  deviceUdid: string,
): IosEventLogState {
  let clearedThroughId = state.clearedThroughId;
  for (const event of state.events) {
    const id = numericId(event, deviceUdid);
    if (id !== null) clearedThroughId = Math.max(clearedThroughId, id);
  }
  return {
    events: [],
    clearedThroughId,
    latestId: state.latestId,
    hasSnapshot: state.hasSnapshot,
    clearPending: !state.hasSnapshot,
  };
}
