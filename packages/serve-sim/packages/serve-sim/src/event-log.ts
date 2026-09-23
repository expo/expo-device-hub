import { HINGE_POSITIONS, isHingeAngle } from "./hinge-angle";
import { HINGE_POSES, isHingeControlCommand } from "./hinge-control";

export type EventLogSource = "hid" | "exec" | "ui";
export type EventLogStatus = "ok" | "error";

export type EventLogEntry = {
  id: number;
  timestamp: string;
  source: EventLogSource;
  kind: string;
  msg: string;
  summary: string;
  device?: string;
  action?: string;
  status?: EventLogStatus;
  details?: Record<string, unknown>;
};

export type EventLogDraft = Omit<EventLogEntry, "id" | "timestamp" | "msg"> & {
  timestamp?: string;
  msg?: string;
};

export const EVENT_LOG_MAX_ENTRIES = 500;

const KEY_LABEL_BY_USAGE: Record<number, string> = {
  0x28: "Enter",
  0x29: "Escape",
  0x2a: "Backspace",
  0x2b: "Tab",
  0x2c: "Space",
  0x2d: "-",
  0x2e: "=",
  0x2f: "[",
  0x30: "]",
  0x31: "\\",
  0x32: "#",
  0x33: ";",
  0x34: "'",
  0x35: "`",
  0x36: ",",
  0x37: ".",
  0x38: "/",
  0x39: "CapsLock",
  0x3a: "F1",
  0x3b: "F2",
  0x3c: "F3",
  0x3d: "F4",
  0x3e: "F5",
  0x3f: "F6",
  0x40: "F7",
  0x41: "F8",
  0x42: "F9",
  0x43: "F10",
  0x44: "F11",
  0x45: "F12",
  0x46: "PrintScreen",
  0x47: "ScrollLock",
  0x48: "Pause",
  0x49: "Insert",
  0x4a: "Home",
  0x4b: "PageUp",
  0x4c: "Delete",
  0x4d: "End",
  0x4e: "PageDown",
  0x4f: "ArrowRight",
  0x50: "ArrowLeft",
  0x51: "ArrowDown",
  0x52: "ArrowUp",
  0x53: "NumLock",
  0x54: "NumpadDivide",
  0x55: "NumpadMultiply",
  0x56: "NumpadSubtract",
  0x57: "NumpadAdd",
  0x58: "NumpadEnter",
  0x59: "Numpad1",
  0x5a: "Numpad2",
  0x5b: "Numpad3",
  0x5c: "Numpad4",
  0x5d: "Numpad5",
  0x5e: "Numpad6",
  0x5f: "Numpad7",
  0x60: "Numpad8",
  0x61: "Numpad9",
  0x62: "Numpad0",
  0x63: "NumpadDecimal",
  0xe0: "ControlLeft",
  0xe1: "ShiftLeft",
  0xe2: "AltLeft",
  0xe3: "MetaLeft",
  0xe4: "ControlRight",
  0xe5: "ShiftRight",
  0xe6: "AltRight",
  0xe7: "MetaRight",
};

let nextEventId = 1;
let entries: EventLogEntry[] = [];
const subscribers = new Set<(entry: EventLogEntry) => void>();

function notifyEventLogSubscribers(entry: EventLogEntry): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch {
      // Event log observers are diagnostic side-channels. A broken stream must
      // not make the simulator input/command path fail.
    }
  }
}

/**
 * Values off the HID socket reach `summary` and `action` unvalidated, and `serve-sim event-log`
 * prints them to the operator's terminal, where an escape sequence would be interpreted. Bounded
 * here rather than at each print site so the stored entry is safe for every reader.
 */
function displaySafe(value: string): string {
  return value.replace(/[\p{C}]/gu, " ").slice(0, 256);
}

export function recordEventLogEvent(draft: EventLogDraft): EventLogEntry {
  const entry: EventLogEntry = {
    ...draft,
    id: nextEventId++,
    timestamp: draft.timestamp ?? new Date().toISOString(),
    summary: displaySafe(draft.summary),
    ...(draft.action === undefined ? {} : { action: displaySafe(draft.action) }),
    msg: displaySafe(draft.msg ?? draft.summary),
  };
  entries.push(entry);
  if (entries.length > EVENT_LOG_MAX_ENTRIES) {
    entries = entries.slice(entries.length - EVENT_LOG_MAX_ENTRIES);
  }
  notifyEventLogSubscribers(entry);
  return entry;
}

export function updateEventLogEvent(
  id: number,
  patch: Partial<Omit<EventLogEntry, "id">>,
  options: { notify?: boolean } = {},
): EventLogEntry | null {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const entry = {
    ...entries[index]!,
    ...patch,
    id,
    ...(patch.summary != null && patch.msg == null ? { msg: patch.summary } : {}),
  };
  entries[index] = entry;
  if (options.notify !== false) notifyEventLogSubscribers(entry);
  return entry;
}

export function readEventLog(options: {
  device?: string | null;
  sinceId?: number;
  limit?: number;
} = {}): EventLogEntry[] {
  const { device, sinceId } = options;
  const limit = clampLimit(options.limit);
  const filtered = entries.filter((entry) => {
    if (device && entry.device !== device) return false;
    if (sinceId != null && entry.id <= sinceId) return false;
    return true;
  });
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export function subscribeEventLog(
  subscriber: (entry: EventLogEntry) => void,
): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function clearEventLogForTests(): void {
  entries = [];
  nextEventId = 1;
}

export function eventLogEventForHidMessage(
  device: string,
  tag: number,
  payload: unknown,
  screen?: { width: number; height: number },
): EventLogDraft | null {
  const details = recordValue(payload);
  if (!details) return null;

  switch (tag) {
    case 0x03: {
      const type = stringValue(details.type);
      const x = numberValue(details.x);
      const y = numberValue(details.y);
      if (!type || x == null || y == null) return null;
      return {
        device,
        source: "hid",
        kind: "touch",
        action: type,
        summary: `Touch ${type} ${formatEventLogPoint(x, y)}`,
        details: withScreen({ ...details, x, y }, screen),
      };
    }
    case 0x04: {
      const button = stringValue(details.button);
      if (!button) return null;
      const phase = stringValue(details.phase) ?? "press";
      return {
        device,
        source: "hid",
        kind: "button",
        action: button,
        summary: phase === "press" ? `Button ${button}` : `Button ${button} ${phase}`,
        details: { ...details, phase },
      };
    }
    case 0x05: {
      const type = stringValue(details.type);
      if (!type) return null;
      return {
        device,
        source: "hid",
        kind: "multi-touch",
        action: type,
        summary: `Multi-touch ${type}`,
        details: withScreen(details, screen),
      };
    }
    case 0x06: {
      const type = stringValue(details.type);
      const usage = numberValue(details.usage);
      if (!type || usage == null) return null;
      const key = keyLabelForUsage(usage);
      const printable = isPrintableKeyUsage(usage);
      const eventDetails = { ...details };
      if (printable) {
        delete eventDetails.usage;
        eventDetails.key = "character";
        eventDetails.redacted = true;
      } else {
        eventDetails.usage = usage;
        eventDetails.key = key;
      }
      return {
        device,
        source: "hid",
        kind: "key",
        action: type,
        summary: printable ? `Key ${type} character` : `Key ${type} ${key}`,
        details: eventDetails,
      };
    }
    case 0x07: {
      const orientation = stringValue(details.orientation);
      if (!orientation) return null;
      return {
        device,
        source: "hid",
        kind: "rotate",
        action: orientation,
        summary: `Rotate ${orientation}`,
        details,
      };
    }
    case 0x08: {
      const option = stringValue(details.option);
      const enabled = booleanValue(details.enabled);
      if (!option || enabled == null) return null;
      return {
        device,
        source: "hid",
        kind: "ca-debug",
        action: option,
        summary: `CoreAnimation ${option} ${enabled ? "on" : "off"}`,
        details: { ...details, enabled },
      };
    }
    case 0x09:
      return {
        device,
        source: "hid",
        kind: "memory-warning",
        action: "trigger",
        summary: "Memory warning",
      };
    case 0x0a: {
      const delta = numberValue(details.delta);
      if (delta == null) return null;
      return {
        device,
        source: "hid",
        kind: "digital-crown",
        action: "rotate",
        summary: `Digital Crown ${delta > 0 ? "up" : "down"}`,
        details: { ...details, delta },
      };
    }
    case 0x0b: {
      const dx = numberValue(details.dx);
      const dy = numberValue(details.dy);
      if (dx == null || dy == null) return null;
      return {
        device,
        source: "hid",
        kind: "scroll",
        action: "wheel",
        summary: `Scroll ${formatDelta(dx, dy)}`,
        details: withScreen({ ...details, dx, dy }, screen),
      };
    }
    case 0x0c:
      return {
        device,
        source: "hid",
        kind: "software-keyboard",
        action: "toggle",
        summary: "Software keyboard",
      };
    case 0x0d: {
      const visible = booleanValue(details.visible);
      if (visible == null) return null;
      return {
        device,
        source: "hid",
        kind: "software-keyboard",
        action: visible ? "show" : "hide",
        summary: `Software keyboard ${visible ? "shown" : "hidden"}`,
      };
    }
    case 0x10: {
      if (!isHingeControlCommand(details)) return null;
      const summary = details.control === "pose" ? HINGE_POSES.find((pose) => pose.id === details.value)!.label
        : details.control === "table" ? `Table Mode ${details.value ? "on" : "off"}`
        : `Hinge ${details.value}°`;
      return { device, source: "hid", kind: "hinge", action: `set-${details.control}`, summary, details: { control: details.control, value: details.value } };
    }
    case 0x0f: {
      const angle = details.angle;
      if (!isHingeAngle(angle)) return null;
      return {
        device,
        source: "hid",
        kind: "hinge",
        action: "set-angle",
        summary: HINGE_POSITIONS.find((position) => position.angle === angle)?.label ?? `Hinge ${angle}°`,
        details: { angle },
      };
    }
    default:
      return null;
  }
}

/**
 * Session event for one typed host action. The preview used to send shell commands, which this
 * module parsed back into events; actions carry the same information without the round trip.
 */
export function eventLogEventForAction(
  action: string,
  params: Record<string, unknown> | undefined,
  result?: { exitCode?: number },
): EventLogDraft | null {
  const status = statusFromExitCode(result?.exitCode);
  const details = commandResultDetails(result);
  const device = typeof params?.udid === "string" ? params.udid : undefined;
  if (device === undefined) return null;

  switch (action) {
    case "app.install":
      return {
        device,
        source: "exec",
        kind: "app",
        action: "install",
        status,
        summary: "Install app",
        details,
      };
    case "media.add":
      return {
        device,
        source: "exec",
        kind: "media",
        action: "addmedia",
        status,
        summary: "Add media",
        details,
      };
    case "screenshot.capture":
      return {
        device,
        source: "exec",
        kind: "screenshot",
        action: "capture",
        status,
        summary: "Screenshot",
        details,
      };
    case "rotate":
      return {
        device,
        source: "exec",
        kind: "rotate",
        action: "rotate",
        status,
        summary: `Rotate ${String(params?.value ?? "")}`.trim(),
        details,
      };
    case "button":
      return {
        device,
        source: "exec",
        kind: "button",
        action: "trigger",
        status,
        summary: `Button ${String(params?.value ?? "")}`.trim(),
        details,
      };
    case "camera.switch":
    case "camera.inject":
    case "camera.mirror":
    case "camera.stopWebcam":
      return {
        device,
        source: "exec",
        kind: "camera",
        action: "toggle",
        status,
        summary: `Camera ${action.slice("camera.".length)}`,
        details,
      };
    case "home.watch":
    case "home.springboard":
      return {
        device,
        source: "exec",
        kind: "button",
        action: "home",
        status,
        summary: "Home",
        details: { ...details, bundleId: "com.apple.springboard" },
      };
    default:
      return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return EVENT_LOG_MAX_ENTRIES;
  return Math.min(EVENT_LOG_MAX_ENTRIES, Math.max(1, Math.floor(limit!)));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function keyLabelForUsage(usage: number): string {
  if (usage >= 0x04 && usage <= 0x1d) {
    return String.fromCharCode(0x61 + usage - 0x04);
  }
  if (usage >= 0x1e && usage <= 0x26) {
    return String(usage - 0x1d);
  }
  if (usage === 0x27) return "0";
  return KEY_LABEL_BY_USAGE[usage] ?? `usage ${usage}`;
}

function isPrintableKeyUsage(usage: number): boolean {
  return (
    (usage >= 0x04 && usage <= 0x27) ||
    (usage >= 0x2c && usage <= 0x38) ||
    (usage >= 0x54 && usage <= 0x57) ||
    (usage >= 0x59 && usage <= 0x63)
  );
}

function withScreen(
  details: Record<string, unknown>,
  screen: { width: number; height: number } | undefined,
): Record<string, unknown> {
  if (!screen || screen.width <= 0 || screen.height <= 0) return details;
  return { ...details, screen };
}

export function formatEventLogPoint(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
  return `${formatEventLogNumber(x)},${formatEventLogNumber(y)}`;
}

function formatDelta(dx: number, dy: number): string {
  return `${formatSigned(dx)},${formatSigned(dy)}`;
}

function formatEventLogNumber(value: number): string {
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSigned(value: number): string {
  const formatted = formatEventLogNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function statusFromExitCode(exitCode: number | undefined): EventLogStatus | undefined {
  if (exitCode == null) return undefined;
  return exitCode === 0 ? "ok" : "error";
}

function commandResultDetails(result: { exitCode?: number } | undefined): Record<string, unknown> {
  return statusFromExitCode(result?.exitCode) ? { exitCode: result?.exitCode } : {};
}
