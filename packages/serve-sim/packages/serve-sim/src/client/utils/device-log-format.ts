export type DeviceLogLevel = "debug" | "info" | "default" | "error" | "fault";

export const DEVICE_LOG_LEVELS: DeviceLogLevel[] = [
  "debug",
  "info",
  "default",
  "error",
  "fault",
];

export type DeviceLogFields = {
  process: string;
  library: string;
  subsystem: string;
  category: string;
  message: string;
  level: DeviceLogLevel;
  pid: number | null;
  timestamp: string;
};

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeDeviceLogLevel(raw: unknown): DeviceLogLevel {
  if (typeof raw === "number") {
    if (raw === 2) return "debug";
    if (raw === 1) return "info";
    if (raw === 16) return "error";
    if (raw === 17) return "fault";
    return "default";
  }
  const value = String(raw).toLowerCase();
  if (value === "debug" || value === "info" || value === "error" || value === "fault") {
    return value;
  }
  return "default";
}

export function parseDeviceLogEntry(entry: unknown): DeviceLogFields | null {
  if (entry === null || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const message = asString(record.eventMessage);
  if (!message) return null;
  const processPath = asString(record.processImagePath);
  const senderPath = asString(record.senderImagePath);
  return {
    process: basename(processPath || senderPath),
    library: basename(senderPath),
    subsystem: asString(record.subsystem),
    category: asString(record.category),
    message,
    level: normalizeDeviceLogLevel(record.messageType),
    pid: typeof record.processID === "number" && Number.isFinite(record.processID)
      ? record.processID
      : null,
    timestamp: asString(record.timestamp),
  };
}

export function parseDeviceLogJson(raw: string): DeviceLogFields | null {
  try {
    return parseDeviceLogEntry(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function deviceLogMatches(line: DeviceLogFields, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    line.process.toLowerCase().includes(needle) ||
    line.library.toLowerCase().includes(needle) ||
    line.subsystem.toLowerCase().includes(needle) ||
    line.category.toLowerCase().includes(needle) ||
    line.message.toLowerCase().includes(needle) ||
    (line.pid !== null && String(line.pid).includes(needle))
  );
}

function parseLogTimestamp(timestamp: string): number | null {
  if (!timestamp) return null;
  const trimmed = timestamp
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

export function formatLogClock(timestamp: string): string {
  const ms = parseLogTimestamp(timestamp);
  if (ms === null) return "";
  const date = new Date(ms);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatLogLine(line: DeviceLogFields): string {
  const time = formatLogClock(line.timestamp);
  const pid = line.pid === null ? "" : ` [${line.pid}]`;
  const meta = [line.subsystem, line.category].filter(Boolean).join(":");
  return [time, line.level, `${line.process}${pid}`, meta, line.message].filter(Boolean).join("  ");
}
