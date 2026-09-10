import { type SseFetch, readSseSnapshot } from './sse';
import {
  type AccessibilityFrame,
  type AccessibilityNode,
  type AccessibilitySnapshot,
} from './types';

/** serve-sim replays a cached snapshot on connect and writes the fresh poll ~1.3 s later. */
export const IOS_AX_SETTLE_MS = 2000;

export const IOS_CLICKABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'cell',
  'switch',
  'tab',
  'toggle',
  'checkbox',
  'menu item',
  'slider',
  'stepper',
  'text field',
  'search field',
  'search text field',
]);

const MALFORMED = 'Malformed accessibility response';

export type AccessibilityRead =
  | { ok: true; snapshot: AccessibilitySnapshot }
  | { ok: false; error: string };

export type AccessibilityLoader = (signal: AbortSignal) => Promise<AccessibilityRead>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function failureText(value: unknown): string {
  const detail = asRecord(value);
  return str(detail?.message) || str(value);
}

function unit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** The visible part of a rectangle as screen fractions, or null when nothing of it is on screen. */
function normalizedFrame(
  left: number,
  top: number,
  right: number,
  bottom: number,
  extentX: number,
  extentY: number,
): AccessibilityFrame | null {
  const x = unit(left / extentX);
  const y = unit(top / extentY);
  const width = unit(right / extentX) - x;
  const height = unit(bottom / extentY) - y;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function tailAfter(value: string, separator: string): string {
  const index = value.lastIndexOf(separator);
  return index === -1 ? value : value.slice(index + separator.length);
}

interface AndroidBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function androidBounds(value: unknown): AndroidBounds | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const left = finiteNumber(raw.left);
  const top = finiteNumber(raw.top);
  const right = finiteNumber(raw.right);
  const bottom = finiteNumber(raw.bottom);
  if (left === null || top === null || right === null || bottom === null) return null;
  return { left, top, right, bottom };
}

/**
 * Parse serve-emu `GET /api/accessibility`: `{ok, capturedAt, nodes[{id, text,
 * contentDescription, resourceId, className, clickable, enabled, bounds{left, top,
 * right, bottom}}]}` in device pixels, or `{ok: false, error}`.
 */
export function parseAndroidAccessibility(value: unknown): AccessibilityRead {
  const body = asRecord(value);
  if (!body) return { ok: false, error: MALFORMED };
  if (body.ok === false) return { ok: false, error: failureText(body.error) || MALFORMED };

  const capturedAt = Date.parse(str(body.capturedAt));
  if (body.ok !== true || !Array.isArray(body.nodes) || !Number.isFinite(capturedAt)) {
    return { ok: false, error: MALFORMED };
  }

  const entries: { raw: Record<string, unknown>; bounds: AndroidBounds }[] = [];
  // The snapshot carries no screen size, but uiautomator's root node spans the
  // display, so the widest bounds are the extent to normalize against.
  let width = 0;
  let height = 0;
  for (const node of body.nodes) {
    const raw = asRecord(node);
    const bounds = raw ? androidBounds(raw.bounds) : null;
    if (!raw || !bounds) continue;
    entries.push({ raw, bounds });
    width = Math.max(width, bounds.right);
    height = Math.max(height, bounds.bottom);
  }
  if (width <= 0 || height <= 0) return { ok: true, snapshot: { capturedAt, nodes: [] } };

  const nodes: AccessibilityNode[] = [];
  for (const { raw, bounds } of entries) {
    const label =
      str(raw.contentDescription) || str(raw.text) || tailAfter(str(raw.resourceId), '/');
    const frame = normalizedFrame(bounds.left, bounds.top, bounds.right, bounds.bottom, width, height);
    if (!label || !frame) continue;
    nodes.push({
      id: str(raw.id),
      label,
      role: tailAfter(str(raw.className), '.'),
      enabled: raw.enabled !== false,
      clickable: raw.clickable === true,
      frame,
    });
  }
  return { ok: true, snapshot: { capturedAt, nodes } };
}

/**
 * Parse a serve-sim `/ax` payload: `{screen{width, height}, elements[{id, label,
 * value, role, type, enabled, frame{x, y, width, height}}], errors?}` in points.
 */
export function parseIosAccessibility(value: unknown, capturedAt: number): AccessibilityRead {
  const body = asRecord(value);
  if (!body) return { ok: false, error: MALFORMED };

  if (Array.isArray(body.errors)) {
    const errors = body.errors.filter((entry): entry is string => typeof entry === 'string');
    if (errors.length > 0) return { ok: false, error: errors.join(' ') };
  }

  const screen = asRecord(body.screen);
  const width = screen ? finiteNumber(screen.width) : null;
  const height = screen ? finiteNumber(screen.height) : null;
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { ok: false, error: MALFORMED };
  }
  if (!Array.isArray(body.elements)) return { ok: false, error: MALFORMED };

  const nodes: AccessibilityNode[] = [];
  for (const element of body.elements) {
    const raw = asRecord(element);
    const frame = raw ? asRecord(raw.frame) : null;
    if (!raw || !frame) continue;
    const x = finiteNumber(frame.x);
    const y = finiteNumber(frame.y);
    const frameWidth = finiteNumber(frame.width);
    const frameHeight = finiteNumber(frame.height);
    if (x === null || y === null || frameWidth === null || frameHeight === null) continue;
    const label = str(raw.label) || str(raw.value);
    const nodeFrame = normalizedFrame(x, y, x + frameWidth, y + frameHeight, width, height);
    if (!label || !nodeFrame) continue;
    const role = str(raw.role) || str(raw.type);
    nodes.push({
      id: str(raw.id),
      label,
      role,
      enabled: raw.enabled !== false,
      clickable: IOS_CLICKABLE_ROLES.has(role.toLowerCase()),
      frame: nodeFrame,
    });
  }
  return { ok: true, snapshot: { capturedAt, nodes } };
}

export async function loadAndroidAccessibility(
  url: string,
  signal: AbortSignal,
  fetchImpl: SseFetch = fetch,
): Promise<AccessibilityRead> {
  const response = await fetchImpl(url, { cache: 'no-store', signal });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: `Accessibility read failed (HTTP ${response.status})` };
  }
  return parseAndroidAccessibility(body);
}

export async function loadIosAccessibility(
  url: string,
  signal: AbortSignal,
  fetchImpl: SseFetch = fetch,
  now: () => number = Date.now,
): Promise<AccessibilityRead> {
  const data = await readSseSnapshot(url, { fetchImpl, signal, settleMs: IOS_AX_SETTLE_MS });
  if (data === null) return { ok: false, error: 'No accessibility snapshot received' };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return { ok: false, error: MALFORMED };
  }
  return parseIosAccessibility(payload, now());
}
