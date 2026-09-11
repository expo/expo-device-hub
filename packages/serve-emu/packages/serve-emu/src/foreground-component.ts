export type ForegroundComponent = { packageName: string; activity: string | null };

type Detector = { key: string; pattern: RegExp };

const WINDOW_DETECTORS: Detector[] = [
  {
    key: "mCurrentFocus",
    pattern: /mCurrentFocus=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
  },
  {
    key: "mFocusedApp",
    pattern: /mFocusedApp=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  },
  {
    key: "mInputMethodTarget",
    pattern: /mInputMethodTarget=Window\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\}/,
  },
];

const ACTIVITY_DETECTORS: Detector[] = [
  {
    key: "topResumedActivity",
    pattern: /topResumedActivity=ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  },
  {
    key: "mResumedActivity",
    pattern: /mResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  },
  {
    key: "ResumedActivity",
    pattern: /ResumedActivity: ActivityRecord\{[^}]*\s([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)\s/,
  },
];

export const FOREGROUND_WINDOW_GREP = WINDOW_DETECTORS.map(({ key }) => key).join("|");
export const FOREGROUND_ACTIVITY_GREP = ACTIVITY_DETECTORS.map(({ key }) => key).join("|");

function parseComponent(value: string): ForegroundComponent | null {
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

function detect(dump: string, detectors: Detector[]): ForegroundComponent | null {
  for (const { pattern } of detectors) {
    const captured = pattern.exec(dump)?.[1];
    const parsed = captured ? parseComponent(captured) : null;
    if (parsed) return parsed;
  }
  return null;
}

export function parseForegroundWindowDump(dump: string): ForegroundComponent | null {
  return detect(dump, WINDOW_DETECTORS);
}

export function parseForegroundActivityDump(dump: string): ForegroundComponent | null {
  return detect(dump, ACTIVITY_DETECTORS);
}
