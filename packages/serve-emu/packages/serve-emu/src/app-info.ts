import { spawnSync } from "node:child_process";

export type ForegroundApp = {
  packageName: string | null;
  activity: string | null;
  pid: number | null;
  label: string | null;
  versionName: string | null;
  versionCode: string | null;
  debuggable: boolean | null;
};

function adbShell(serial: string, args: string[], timeout = 4_000): string {
  const result = spawnSync("adb", ["-s", serial, "shell", ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `adb shell ${args.join(" ")} failed`).trim());
  }
  return result.stdout;
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  return null;
}

function parseComponent(value: string): { packageName: string; activity: string | null } | null {
  const clean = value.trim().replace(/^\{|\}$/g, "");
  const component = clean.split(/\s+/).find((part) => part.includes("/")) ?? clean;
  const [packageName, activityRaw] = component.split("/", 2);
  if (!packageName || !/^[A-Za-z0-9_.]+$/.test(packageName)) return null;
  const activity = activityRaw
    ? activityRaw.startsWith(".")
      ? `${packageName}${activityRaw}`
      : activityRaw
    : null;
  return { packageName, activity };
}

function foregroundComponent(serial: string): { packageName: string; activity: string | null } | null {
  const windowDump = adbShell(serial, ["dumpsys", "window"], 5_000);
  const windowMatch = firstMatch(windowDump, [
    /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
    /mFocusedApp=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /mInputMethodTarget=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
  ]);
  if (windowMatch?.[1]) {
    const parsed = parseComponent(windowMatch[1]);
    if (parsed) return parsed;
  }

  const activityDump = adbShell(serial, ["dumpsys", "activity", "activities"], 5_000);
  const activityMatch = firstMatch(activityDump, [
    /topResumedActivity=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /mResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
    /ResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  ]);
  return activityMatch?.[1] ? parseComponent(activityMatch[1]) : null;
}

function packagePid(serial: string, packageName: string): number | null {
  try {
    const out = adbShell(serial, ["pidof", packageName], 2_000).trim();
    const first = out.split(/\s+/)[0];
    const pid = first ? Number(first) : NaN;
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function packageDetails(serial: string, packageName: string) {
  try {
    const dump = adbShell(serial, ["dumpsys", "package", packageName], 5_000);
    const versionName = dump.match(/versionName=([^\s]+)/)?.[1] ?? null;
    const versionCode = dump.match(/versionCode=(\d+)/)?.[1] ?? null;
    const label =
      dump.match(/application-label(?:-[a-zA-Z]+)?:'([^']+)'/)?.[1] ??
      dump.match(/labelRes=0x[0-9a-fA-F]+ nonLocalizedLabel=([^\n]+)/)?.[1]?.trim() ??
      null;
    const debuggable = /pkgFlags=\[[^\]]*\bDEBUGGABLE\b/.test(dump) || /\bDEBUGGABLE\b/.test(dump);
    return { label, versionName, versionCode, debuggable };
  } catch {
    return { label: null, versionName: null, versionCode: null, debuggable: null };
  }
}

export function getForegroundApp(serial: string): ForegroundApp {
  const component = foregroundComponent(serial);
  if (!component) {
    return {
      packageName: null,
      activity: null,
      pid: null,
      label: null,
      versionName: null,
      versionCode: null,
      debuggable: null,
    };
  }
  const details = packageDetails(serial, component.packageName);
  return {
    packageName: component.packageName,
    activity: component.activity,
    pid: packagePid(serial, component.packageName),
    ...details,
  };
}
