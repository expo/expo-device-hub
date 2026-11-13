import { type DeviceEvent } from "./types";

export const MAX_ANDROID_DEVICE_EVENTS = 500;

export interface AndroidEventCursor {
  latestId: number;
  clearedThroughId: number;
  hasSnapshot: boolean;
  clearPending: boolean;
}

export function createAndroidEventCursor(): AndroidEventCursor {
  return {
    latestId: 0,
    clearedThroughId: 0,
    hasSnapshot: false,
    clearPending: false,
  };
}

/**
 * Make Clear durable even when it races the first full session snapshot. The
 * backend retains its replay history, so an early Clear is applied as a
 * watermark once that first snapshot arrives.
 */
export function clearAndroidEventCursor(cursor: AndroidEventCursor): AndroidEventCursor {
  if (!cursor.hasSnapshot) return { ...cursor, clearPending: true };
  return {
    ...cursor,
    clearedThroughId: Math.max(cursor.clearedThroughId, cursor.latestId),
    clearPending: false,
  };
}

/** Advance the viewer-local cursor for one complete serve-emu session snapshot. */
export function mergeAndroidEventSnapshotCursor(
  cursor: AndroidEventCursor,
  events: readonly AndroidSessionEvent[],
): AndroidEventCursor {
  const latestId = events.reduce(
    (latest, event) =>
      Number.isSafeInteger(event.id) && event.id > 0 ? Math.max(latest, event.id) : latest,
    0,
  );
  const restarted =
    cursor.hasSnapshot &&
    ((cursor.latestId > 0 && latestId === 0) || (latestId > 0 && latestId < cursor.latestId));
  let clearedThroughId = restarted ? 0 : cursor.clearedThroughId;
  if (cursor.clearPending) clearedThroughId = Math.max(clearedThroughId, latestId);

  return {
    latestId,
    clearedThroughId,
    hasSnapshot: true,
    clearPending: false,
  };
}

/** The forward-compatible subset of a serve-emu `/api/session` event we consume. */
export interface AndroidSessionEvent {
  id: number;
  at: string;
  delayMs: number;
  source: string;
  kind: string;
  gesture?: {
    type?: string;
    [key: string]: unknown;
  };
  location?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
    satellites?: number;
    velocity?: number;
    [key: string]: unknown;
  };
  /** A device action that is not input, such as a screenshot or a rotation. */
  action?: {
    type?: string;
    [key: string]: unknown;
  };
  /** `false` on an entry that serve-emu's replay skips. */
  replay?: boolean;
  [key: string]: unknown;
}

function stableId(deviceSerial: string, eventId: number): string {
  return `android:${encodeURIComponent(deviceSerial)}:${eventId}`;
}

function percentage(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "?";
}

function point(x: unknown, y: unknown): string {
  return `${percentage(x)}, ${percentage(y)}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function textLength(value: unknown): number {
  return typeof value === "string" ? Array.from(value).length : 0;
}

function redactedGesture(gesture: AndroidSessionEvent["gesture"]): Record<string, unknown> {
  if (!gesture) return {};
  if (gesture.type !== "text") return { ...gesture };

  return {
    type: "text",
    textLength: textLength(gesture.text),
    redacted: true,
  };
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function settingValue(value: unknown): string {
  if (value === true) return "on";
  if (value === false) return "off";
  return typeof value === "string" || typeof value === "number" ? String(value) : "?";
}

/** The Hub kind, action, and message for one serve-emu action entry. */
function describeAction(action: NonNullable<AndroidSessionEvent["action"]>): {
  kind: string;
  action?: string;
  message: string;
} {
  const type = stringField(action.type) ?? "unknown";
  const verb = stringField(action.action);
  switch (type) {
    case "screenshot":
      return { kind: "screenshot", message: "Screenshot" };
    case "orientation": {
      const orientation = stringField(action.orientation);
      return {
        kind: "rotate",
        ...(orientation ? { action: orientation } : {}),
        message: orientation ? `Rotate to ${humanize(orientation)}` : "Rotate",
      };
    }
    case "fold": {
      const posture = stringField(action.posture);
      const angle = finiteNumber(action.hingeAngle);
      return {
        kind: "fold",
        message: posture
          ? `Fold ${posture}`
          : angle === null
            ? "Fold"
            : `Fold hinge to ${Math.round(angle)}°`,
      };
    }
    case "setting": {
      const setting = stringField(action.setting);
      return {
        kind: "settings",
        ...(setting ? { action: setting } : {}),
        message: setting
          ? `Set ${humanize(setting)} to ${settingValue(action.value)}`
          : "Device setting changed",
      };
    }
    case "app": {
      const packageName = stringField(action.packageName);
      const permission = stringField(action.permission);
      return {
        kind: "app",
        ...(verb ? { action: verb } : {}),
        message: `${titleCase(verb ? humanize(verb) : "app")} app${packageName ? ` ${packageName}` : ""}${
          permission ? ` (${permission})` : ""
        }`,
      };
    }
    case "file-import":
      return { kind: "media", action: "import", message: "Import file" };
    case "route":
      return {
        kind: "location",
        action: verb ? `route-${verb}` : "route",
        message: verb ? `Route ${verb}` : "Route",
      };
    case "camera": {
      const facing = stringField(action.facing);
      return {
        kind: "camera",
        ...(verb ? { action: verb } : {}),
        message: `Camera ${verb ? humanize(verb) : "change"}${facing ? ` (${facing})` : ""}`,
      };
    }
    default:
      return { kind: "action", action: type, message: `Action ${humanize(type)}` };
  }
}

function mapGesture(event: AndroidSessionEvent, deviceSerial: string): DeviceEvent {
  const gesture = event.gesture;
  const type = typeof gesture?.type === "string" ? gesture.type : "unknown";
  const base = {
    id: stableId(deviceSerial, event.id),
    timestamp: event.at,
    source: event.source,
    details: {
      delayMs: event.delayMs,
      gesture: redactedGesture(gesture),
      ...(event.replay === false ? { replay: false } : {}),
    },
  };

  switch (type) {
    case "touch": {
      const action = typeof gesture?.action === "string" ? gesture.action : "unknown";
      return {
        ...base,
        kind: "touch",
        action,
        message: `Touch ${action} at ${point(gesture?.x, gesture?.y)}`,
      };
    }
    case "tap":
      return {
        ...base,
        kind: "touch",
        action: "tap",
        message: `Tap at ${point(gesture?.x, gesture?.y)}`,
      };
    case "swipe": {
      const durationMs = finiteNumber(gesture?.durationMs);
      return {
        ...base,
        kind: "touch",
        action: "swipe",
        message: `Swipe ${point(gesture?.x1, gesture?.y1)} → ${point(gesture?.x2, gesture?.y2)}${
          durationMs === null ? "" : ` (${Math.round(durationMs)} ms)`
        }`,
      };
    }
    case "key": {
      const keycode = finiteNumber(gesture?.keycode);
      return {
        ...base,
        kind: "keyboard",
        action: "key",
        message: keycode === null ? "Key input" : `Keycode ${keycode}`,
      };
    }
    case "text": {
      const length = textLength(gesture?.text);
      return {
        ...base,
        kind: "keyboard",
        action: "text",
        message: `Text input (${length} ${length === 1 ? "character" : "characters"}, redacted)`,
      };
    }
    case "back":
    case "home":
    case "recents":
    case "power":
      return {
        ...base,
        kind: "button",
        action: type,
        message: `Button ${titleCase(type)}`,
      };
    default:
      return {
        ...base,
        kind: "gesture",
        action: type,
        message: `Gesture ${type}`,
      };
  }
}

/** Map one serve-emu session event into the Hub's canonical event shape. */
export function mapAndroidSessionEvent(
  event: AndroidSessionEvent,
  deviceSerial: string,
): DeviceEvent {
  if (event.kind === "gesture") return mapGesture(event, deviceSerial);

  if (event.kind === "location") {
    const latitude = finiteNumber(event.location?.latitude);
    const longitude = finiteNumber(event.location?.longitude);
    const coordinates =
      latitude === null || longitude === null
        ? "unknown coordinates"
        : `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    return {
      id: stableId(deviceSerial, event.id),
      timestamp: event.at,
      source: event.source,
      kind: "location",
      action: "set",
      message: `Location ${coordinates}`,
      details: {
        delayMs: event.delayMs,
        location: { ...event.location },
      },
    };
  }

  if (event.kind === "action" && event.action) {
    return {
      id: stableId(deviceSerial, event.id),
      timestamp: event.at,
      source: event.source,
      ...describeAction(event.action),
      details: { delayMs: event.delayMs, action: { ...event.action } },
    };
  }

  return {
    id: stableId(deviceSerial, event.id),
    timestamp: event.at,
    source: event.source,
    kind: event.kind || "event",
    message: `Event ${event.kind || "unknown"}`,
    details: { delayMs: event.delayMs },
  };
}

/** Map an oldest-to-newest serve-emu snapshot, retaining only its latest rows. */
export function mapAndroidSessionEvents(
  events: readonly AndroidSessionEvent[],
  deviceSerial: string,
): DeviceEvent[] {
  return events
    .slice(-MAX_ANDROID_DEVICE_EVENTS)
    .map((event) => mapAndroidSessionEvent(event, deviceSerial));
}

/** Preserve array identity when a one-second session poll contains no changes. */
export function reconcileAndroidSessionEvents(
  previous: DeviceEvent[],
  events: readonly AndroidSessionEvent[],
  deviceSerial: string,
): DeviceEvent[] {
  const next = mapAndroidSessionEvents(events, deviceSerial);
  const unchanged =
    previous.length === next.length &&
    previous.every((event, index) => {
      const candidate = next[index];
      return (
        candidate !== undefined &&
        event.id === candidate.id &&
        event.timestamp === candidate.timestamp &&
        event.source === candidate.source &&
        event.kind === candidate.kind &&
        event.action === candidate.action &&
        event.status === candidate.status &&
        event.message === candidate.message &&
        JSON.stringify(event.details) === JSON.stringify(candidate.details)
      );
    });
  return unchanged ? previous : next;
}
