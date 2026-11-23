import { existsSync } from "fs";
import { join } from "path";

import { readAppContainer, readInfoPlist } from "./app-icon";

// What the `/appstate` stream tells a client about the foreground app, besides its bundle id and
// pid. The server reads it from the bundle path that simctl reports, so a client never has to send
// a path back. A client-sent path must pass `ConfinedPath`, and on some hosts Apple's own apps live
// outside its roots, so `app.infoPlist` cannot read Safari's or Settings' name there.

export type ForegroundAppDetails = {
  isReactNative: boolean;
  /** `CFBundleDisplayName`, else `CFBundleName`; null when unknown. */
  label: string | null;
};

export interface ForegroundAppDetailsDeps {
  /** The installed `.app` directory, or null when it is not installed. May throw. */
  appContainer: (udid: string, bundleId: string) => Promise<string | null>;
  readInfoPlist: (path: string) => Promise<unknown>;
  exists: (path: string) => boolean;
}

// Known bundle IDs that are always React Native shells (used as a fallback
// before the app-container path resolves, since simctl can lag after launch).
const RN_BUNDLE_IDS = new Set<string>([
  "host.exp.Exponent", // Expo Go (App Store)
  "dev.expo.Exponent", // Expo Go dev builds
]);

const RN_MARKERS = [
  "Frameworks/React.framework",
  "Frameworks/hermes.framework",
  "Frameworks/Hermes.framework",
  "Frameworks/ExpoModulesCore.framework",
  "main.jsbundle",
];

/** Keeps the `/appstate` event prompt: the lookup runs before each event is written. */
const APP_CONTAINER_TIMEOUT_MS = 2_000;

const defaultDeps: ForegroundAppDetailsDeps = {
  appContainer: (udid, bundleId) => readAppContainer(udid, bundleId, APP_CONTAINER_TIMEOUT_MS),
  readInfoPlist,
  exists: existsSync,
};

/** The name an app shows on the home screen, read the way hub-client's bundle reader does. */
export function appLabelFromInfoPlist(info: unknown): string | null {
  const plist = info && typeof info === "object" ? (info as Record<string, unknown>) : {};
  for (const key of ["CFBundleDisplayName", "CFBundleName"]) {
    const value = plist[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** One `/appstate` event. */
export type ForegroundAppEvent = {
  bundleId: string;
  pid?: number;
  isReactNative: boolean;
  label?: string | null;
};

/**
 * The `/appstate` events for one foreground app, in order. A known React Native shell (Expo Go) is
 * reported at once, as before the label existed, so the preview's reload control does not wait for
 * a lagging simctl; its label follows in a second event for the same bundle id and pid. Any other
 * app needs the simctl lookup for `isReactNative` anyway, so it gets one event with both answers.
 */
export async function* foregroundAppEvents(
  udid: string,
  app: { bundleId: string; pid?: number },
  overrides: Partial<ForegroundAppDetailsDeps> = {},
): AsyncGenerator<ForegroundAppEvent> {
  const { bundleId, pid } = app;
  const knownShell = RN_BUNDLE_IDS.has(bundleId);
  if (knownShell) yield { bundleId, pid, isReactNative: true };
  const { isReactNative, label } = await describeForegroundApp(udid, bundleId, overrides);
  if (!knownShell) yield { bundleId, pid, isReactNative, label };
  else if (label) yield { bundleId, pid, isReactNative, label };
}

/** One simctl lookup serves both answers. A failed lookup gives `{ isReactNative, label: null }`. */
export async function describeForegroundApp(
  udid: string,
  bundleId: string,
  overrides: Partial<ForegroundAppDetailsDeps> = {},
): Promise<ForegroundAppDetails> {
  const deps = { ...defaultDeps, ...overrides };
  let appPath: string | null = null;
  try {
    appPath = await deps.appContainer(udid, bundleId);
  } catch {
    // A busy or lagging simctl: report what the bundle id alone tells.
  }
  const isReactNative =
    RN_BUNDLE_IDS.has(bundleId) ||
    (appPath !== null && RN_MARKERS.some((marker) => deps.exists(join(appPath, marker))));
  const label = appPath
    ? appLabelFromInfoPlist(await deps.readInfoPlist(join(appPath, "Info.plist")))
    : null;
  return { isReactNative, label };
}
