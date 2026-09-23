// An `.ips` is two documents concatenated: a one-line JSON header, then a JSON body.

const IPS_SIMULATOR_PLATFORM = 7;
const IPS_CRASH_BUG_TYPE = "309";
const MAX_FRAMES = 24;

export interface CrashHeader {
  appName: string | null;
  bundleId: string | null;
  appVersion: string | null;
  buildVersion: string | null;
  timestamp: string | null;
  platform: number | null;
  bugType: string | null;
  incidentId: string | null;
}

export interface CrashFrame {
  image: string;
  symbol: string | null;
  imageOffset: number | null;
  imageUuid: string | null;
  appOwned: boolean;
}

export interface CrashReport {
  incidentId: string | null;
  deviceUdid: string | null;
  bundleId: string | null;
  appName: string | null;
  procName: string | null;
  appVersion: string | null;
  buildVersion: string | null;
  pid: number | null;
  capturedAt: string | null;
  capturedAtMs: number | null;
  exceptionType: string | null;
  signal: string | null;
  terminationIndicator: string | null;
  faultingQueue: string | null;
  culpritFrame: string | null;
  frames: CrashFrame[];
  signature: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function splitIps(raw: string): { headerLine: string; bodyText: string } | null {
  const newline = raw.indexOf("\n");
  if (newline === -1) return null;
  return { headerLine: raw.slice(0, newline), bodyText: raw.slice(newline + 1) };
}

function parseHeaderLine(headerLine: string): CrashHeader | null {
  let raw: Record<string, unknown> | null;
  try {
    raw = asObject(JSON.parse(headerLine));
  } catch {
    return null;
  }
  if (!raw) return null;
  return {
    appName: readString(raw, "app_name"),
    bundleId: readString(raw, "bundleID"),
    appVersion: readString(raw, "app_version"),
    buildVersion: readString(raw, "build_version"),
    timestamp: readString(raw, "timestamp"),
    platform: readNumber(raw, "platform"),
    bugType: readString(raw, "bug_type"),
    incidentId: readString(raw, "incident_id"),
  };
}

export function parseIpsHeader(raw: string): CrashHeader | null {
  const split = splitIps(raw);
  return split ? parseHeaderLine(split.headerLine) : null;
}

export function isSimulatorAppCrash(header: CrashHeader | null): boolean {
  return (
    header?.platform === IPS_SIMULATOR_PLATFORM &&
    header.bugType === IPS_CRASH_BUG_TYPE &&
    header.bundleId !== null &&
    header.bundleId.length > 0
  );
}

function bundleRootOf(procPath: string | null): string | null {
  if (!procPath) return null;
  const marker = ".app/";
  const index = procPath.lastIndexOf(marker);
  return index === -1 ? null : procPath.slice(0, index + marker.length);
}

function deviceUdidOf(procPath: string | null): string | null {
  if (!procPath) return null;
  return /\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//i.exec(procPath)?.[1] ?? null;
}

function describeFrame(frame: CrashFrame): string | null {
  if (frame.symbol) return `${frame.image} ${frame.symbol}`;
  if (frame.imageOffset === null) return null;
  return `${frame.image} +${frame.imageOffset}`;
}

function selectFaultingThread(body: Record<string, unknown>): Record<string, unknown> | null {
  const threads = asArray(body.threads);
  const index = readNumber(body, "faultingThread");
  const byIndex = index === null ? null : asObject(threads[index]);
  if (byIndex) return byIndex;
  const triggered = threads.find((candidate) => asObject(candidate)?.triggered === true);
  return asObject(triggered) ?? asObject(threads[0]);
}

function readFrames(body: Record<string, unknown>): CrashFrame[] {
  const images = asArray(body.usedImages);
  const bundleRoot = bundleRootOf(readString(body, "procPath"));
  const frames: CrashFrame[] = [];

  for (const raw of asArray(selectFaultingThread(body)?.frames)) {
    const frame = asObject(raw);
    if (!frame) continue;
    const imageIndex = readNumber(frame, "imageIndex");
    const image = imageIndex === null ? null : asObject(images[imageIndex]);
    const imagePath = readString(image, "path");
    frames.push({
      image: readString(image, "name") ?? "unknown",
      symbol: readString(frame, "symbol"),
      imageOffset: readNumber(frame, "imageOffset"),
      imageUuid: readString(image, "uuid"),
      appOwned: Boolean(bundleRoot && imagePath?.startsWith(bundleRoot)),
    });
  }
  return frames;
}

export function parseCrashReport(raw: string): CrashReport | null {
  const split = splitIps(raw);
  if (!split) return null;

  const header = parseHeaderLine(split.headerLine);
  if (!header) return null;

  let body: Record<string, unknown> | null;
  try {
    body = asObject(JSON.parse(split.bodyText));
  } catch {
    return null;
  }
  if (!body) return null;

  const exception = asObject(body.exception);
  const termination = asObject(body.termination);
  const threadTriggered = asObject(asObject(body.legacyInfo)?.threadTriggered);

  const allFrames = readFrames(body);
  const appFrame = allFrames.findIndex((frame) => frame.appOwned);
  const culprit = allFrames[appFrame] ?? allFrames[0];
  const culpritFrame = culprit ? describeFrame(culprit) : null;
  const culpritKey = !culprit
    ? ""
    : culprit.symbol
      ? `${culprit.image} ${culprit.symbol}`
      : `${culprit.image} ${culprit.imageUuid ?? ""}+${culprit.imageOffset ?? ""}`;

  const exceptionType = readString(exception, "type");
  const signal = readString(exception, "signal");
  const capturedAt = readString(body, "captureTime") ?? header.timestamp;
  const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;

  return {
    incidentId: header.incidentId,
    deviceUdid: deviceUdidOf(readString(body, "procPath")),
    bundleId: header.bundleId,
    appName: header.appName ?? readString(body, "procName"),
    procName: readString(body, "procName"),
    appVersion: header.appVersion,
    buildVersion: header.buildVersion,
    pid: readNumber(body, "pid"),
    capturedAt,
    capturedAtMs: Number.isNaN(capturedAtMs) ? null : capturedAtMs,
    exceptionType,
    signal,
    terminationIndicator: readString(termination, "indicator"),
    faultingQueue: readString(threadTriggered, "queue"),
    culpritFrame,
    frames: allFrames.slice(0, Math.max(MAX_FRAMES, appFrame + 1)),
    signature: [
      header.bundleId ?? "",
      exceptionType ?? "",
      signal ?? "",
      readString(termination, "indicator") ?? "",
      culpritKey,
    ].join("|"),
  };
}
