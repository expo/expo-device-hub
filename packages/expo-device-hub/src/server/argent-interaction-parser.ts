import {
  type AgentInteraction,
  type AgentInteractionFrame,
  type AgentInteractionPoint,
  type AgentInteractionSegment,
} from '@expo/hub-client';

const DEFAULT_GESTURE_DURATION_MS = 300;
const DEFAULT_CUSTOM_EVENT_DELAY_MS = 16;
const DEFAULT_SEQUENCE_DELAY_MS = 100;

type JsonObject = Record<string, unknown>;

export function parseArgentInteractionLogLine(line: string): AgentInteraction | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(record) || record.event !== 'tool_called') return null;
  if (typeof record.name !== 'string' || typeof record.ts !== 'string' || !isObject(record.args)) {
    return null;
  }

  const deviceId = stringValue(record.args.udid);
  if (!deviceId) return null;
  const segments = segmentsForTool(record.name, record.args);
  if (segments.length === 0) return null;

  return {
    id: `${record.ts}:${record.name}`,
    deviceId,
    timestamp: record.ts,
    segments,
  };
}

function segmentsForTool(name: string, args: JsonObject): AgentInteractionSegment[] {
  switch (name) {
    case 'gesture-tap':
      return tapSegment(args);
    case 'gesture-swipe':
      return swipeSegment(args);
    case 'gesture-custom':
      return customSegment(args);
    case 'gesture-pinch':
      return pinchSegment(args);
    case 'gesture-rotate':
      return rotateSegment(args);
    case 'run-sequence':
      return sequenceSegments(args);
    default:
      return [];
  }
}

function tapSegment(args: JsonObject): AgentInteractionSegment[] {
  const point = pointFrom(args, 'x', 'y');
  return point ? [{ startMs: 0, frames: [{ atMs: 0, points: [point] }] }] : [];
}

function swipeSegment(args: JsonObject): AgentInteractionSegment[] {
  const from = pointFrom(args, 'fromX', 'fromY');
  const to = pointFrom(args, 'toX', 'toY');
  if (!from || !to) return [];
  const duration = durationValue(args.durationMs, DEFAULT_GESTURE_DURATION_MS);
  return [
    {
      startMs: 0,
      frames: [
        { atMs: 0, points: [from] },
        { atMs: duration, points: [to] },
      ],
      easing: args.settle === true ? 'ease-out' : 'linear',
    },
  ];
}

function customSegment(args: JsonObject): AgentInteractionSegment[] {
  if (!Array.isArray(args.events) || args.events.length === 0) return [];
  const frames: AgentInteractionFrame[] = [];
  let atMs = 0;
  for (const [index, event] of args.events.entries()) {
    if (!isObject(event)) return [];
    const primary = pointFrom(event, 'x', 'y');
    if (!primary) return [];
    const secondary = pointFrom(event, 'x2', 'y2', true);
    if ((event.x2 === undefined) !== (event.y2 === undefined)) return [];
    if (index > 0) atMs += durationValue(event.delayMs, DEFAULT_CUSTOM_EVENT_DELAY_MS);
    frames.push({ atMs, points: secondary ? [primary, secondary] : [primary] });
  }
  return [{ startMs: 0, frames }];
}

function pinchSegment(args: JsonObject): AgentInteractionSegment[] {
  const center = pointFrom(args, 'centerX', 'centerY');
  const startDistance = finiteNumber(args.startDistance);
  const endDistance = finiteNumber(args.endDistance);
  if (!center || startDistance === null || endDistance === null) return [];
  const angle = finiteNumber(args.angle) ?? 0;
  const duration = durationValue(args.durationMs, DEFAULT_GESTURE_DURATION_MS);
  return [
    {
      startMs: 0,
      frames: [
        { atMs: 0, points: pinchPoints(center, startDistance, angle) },
        { atMs: duration, points: pinchPoints(center, endDistance, angle) },
      ],
    },
  ];
}

function rotateSegment(args: JsonObject): AgentInteractionSegment[] {
  const center = pointFrom(args, 'centerX', 'centerY');
  const radius = finiteNumber(args.radius);
  const startAngle = finiteNumber(args.startAngle);
  const endAngle = finiteNumber(args.endAngle);
  if (!center || radius === null || startAngle === null || endAngle === null) return [];
  const duration = durationValue(args.durationMs, DEFAULT_GESTURE_DURATION_MS);
  const frameCount = Math.max(1, Math.round(duration / DEFAULT_CUSTOM_EVENT_DELAY_MS));
  const frames = Array.from({ length: frameCount + 1 }, (_, index) => {
    const progress = index / frameCount;
    const angle = startAngle + (endAngle - startAngle) * progress;
    return {
      atMs: duration * progress,
      points: rotatePoints(center, radius, angle),
    };
  });
  return [{ startMs: 0, frames }];
}

function sequenceSegments(args: JsonObject): AgentInteractionSegment[] {
  if (!Array.isArray(args.steps)) return [];
  const segments: AgentInteractionSegment[] = [];
  let cursorMs = 0;

  for (const step of args.steps) {
    if (!isObject(step) || typeof step.tool !== 'string' || !isObject(step.args)) continue;
    const nested = segmentsForTool(step.tool, { ...step.args, udid: args.udid });
    for (const segment of nested) {
      segments.push({ ...segment, startMs: cursorMs + segment.startMs });
    }
    cursorMs += interactionDuration(nested);
    cursorMs += durationValue(step.delayMs, DEFAULT_SEQUENCE_DELAY_MS);
  }
  return segments;
}

function interactionDuration(segments: AgentInteractionSegment[]): number {
  return segments.reduce((max, segment) => {
    const last = segment.frames.at(-1)?.atMs ?? 0;
    return Math.max(max, segment.startMs + last);
  }, 0);
}

function pinchPoints(center: AgentInteractionPoint, distance: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  const dx = (distance / 2) * Math.cos(radians);
  const dy = (distance / 2) * Math.sin(radians);
  return [clampedPoint(center.x - dx, center.y - dy), clampedPoint(center.x + dx, center.y + dy)];
}

function rotatePoints(center: AgentInteractionPoint, radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  const dx = radius * Math.cos(radians);
  const dy = radius * Math.sin(radians);
  return [clampedPoint(center.x + dx, center.y + dy), clampedPoint(center.x - dx, center.y - dy)];
}

function pointFrom(
  object: JsonObject,
  xKey: string,
  yKey: string,
  optional = false
): AgentInteractionPoint | null {
  if (optional && object[xKey] === undefined && object[yKey] === undefined) return null;
  const x = finiteNumber(object[xKey]);
  const y = finiteNumber(object[yKey]);
  return x === null || y === null ? null : clampedPoint(x, y);
}

function clampedPoint(x: number, y: number): AgentInteractionPoint {
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function durationValue(value: unknown, fallback: number): number {
  const number = finiteNumber(value);
  return number === null ? fallback : Math.max(0, number);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
