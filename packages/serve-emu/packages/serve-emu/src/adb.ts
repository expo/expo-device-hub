import { spawn } from "node:child_process";
import { execBuffer, execText, type ExecResult } from "./exec.ts";

const ADB_QUERY_TIMEOUT_MS = 2_000;
const ADB_MUTATION_TIMEOUT_MS = 5_000;
const ADB_SCREENSHOT_TIMEOUT_MS = 8_000;
const EMU_CONSOLE_TIMEOUT_MS = 5_000;

export type Device = { serial: string; state: string };
export type OrientationMode = "auto" | "portrait" | "landscape";
export type NightMode = "auto" | "dark" | "light";
export type OrientationStatus = {
  mode: "free" | "lock" | "unknown";
  rotation: number | null;
  orientation: OrientationMode | "unknown";
  raw: string;
};
export type FontScaleStatus = {
  scale: number;
  raw: string;
};
export type NightModeStatus = {
  mode: NightMode | "unknown";
  raw: string;
};
export type NetworkRadioStatus = "enabled" | "disabled" | "unknown";
export type NetworkStatus = {
  enabled: boolean | null;
  wifi: NetworkRadioStatus;
  mobileData: NetworkRadioStatus;
  raw: {
    wifi: string;
    mobileData: string;
  };
};

export type ReduceMotionStatus = {
  enabled: boolean;
  raw: {
    transition: string;
    window: string;
    animator: string;
  };
};
export type HighTextContrastStatus = {
  enabled: boolean;
  raw: string;
};
export type FontWeightStatus = {
  enabled: boolean;
  raw: string;
};
export type DisplayDensityStatus = {
  /** The override density as a ratio of the device's own physical density. */
  scale: number;
  /** The smallest-width dp the override produces, the `swNNNdp` resource qualifier. */
  widthDp: number;
  raw: string;
};

function execFailed(result: ExecResult<string | Buffer>): boolean {
  return result.status !== 0 || result.error !== null;
}

function execFailure(result: ExecResult<string | Buffer>): string {
  const stdout =
    typeof result.stdout === "string" ? result.stdout.trim() : "";
  return (
    result.stderr.trim() ||
    result.error?.message ||
    stdout ||
    "unknown error"
  );
}

export async function listAllDevices(
  runExec: typeof execText = execText,
): Promise<Device[]> {
  const r = await runExec("adb", ["devices"], { timeout: ADB_QUERY_TIMEOUT_MS });
  if (execFailed(r)) throw new Error(`adb devices failed: ${execFailure(r)}`);
  return r.stdout
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
}

export async function listDevices(
  runExec: typeof execText = execText,
): Promise<Device[]> {
  return (await listAllDevices(runExec)).filter((d) => d.state === "device");
}

export async function pickDevice(
  explicit?: string,
  runExec: typeof execText = execText,
): Promise<string> {
  if (explicit) return explicit;
  const devices = await listDevices(runExec);
  if (devices.length === 0) throw new Error("No booted Android device found. Start an emulator or attach a device.");
  if (devices.length > 1)
    throw new Error(
      `Multiple devices online (${devices.map((d) => d.serial).join(", ")}). Pass -s <serial>.`,
    );
  return devices[0].serial;
}

export async function screencapPng(
  serial: string,
  runExec: typeof execBuffer = execBuffer,
): Promise<Buffer> {
  const r = await runExec("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: ADB_SCREENSHOT_TIMEOUT_MS,
  });
  if (execFailed(r)) throw new Error(`screencap failed: ${execFailure(r)}`);
  return r.stdout;
}

export async function shell(
  serial: string,
  cmd: string[],
  runExec: typeof execText = execText,
): Promise<void> {
  const r = await runExec("adb", ["-s", serial, "shell", ...cmd], {
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `adb shell ${cmd.join(" ")} failed: ${execFailure(r)}`,
    );
  }
}

export function shellSpawn(
  serial: string,
  cmd: string[],
  runSpawn: typeof spawn = spawn,
) {
  return runSpawn("adb", ["-s", serial, "shell", ...cmd]);
}

/**
 * Run an emulator console command and return the single value it printed. The
 * console echoes the value on its own line and then `OK`, or `KO: <reason>`
 * when it refuses. Returns null when the command fails or prints no value.
 */
export async function readEmuConsoleValue(
  serial: string,
  args: string[],
  runExec: typeof execText = execText,
): Promise<string | null> {
  const r = await runExec("adb", ["-s", serial, "emu", ...args], {
    timeout: EMU_CONSOLE_TIMEOUT_MS,
  });
  if (execFailed(r)) return null;
  return (
    r.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK" && !line.startsWith("KO:")) ?? null
  );
}

export async function getDeviceSize(
  serial: string,
  runExec: typeof execText = execText,
): Promise<{ width: number; height: number }> {
  const r = await runExec("adb", ["-s", serial, "shell", "wm", "size"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) throw new Error(`wm size failed: ${execFailure(r)}`);
  const m = r.stdout.match(/(\d+)x(\d+)/);
  if (!m) throw new Error(`Could not parse wm size output: ${r.stdout}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export type DisplayRotation = 0 | 1 | 2 | 3;

/** Read the active display rotation rather than the user's rotation policy. */
export async function getDisplayRotation(
  serial: string,
  runExec: typeof execText = execText,
  signal?: AbortSignal,
): Promise<DisplayRotation> {
  const r = await runExec(
    "adb",
    ["-s", serial, "shell", "dumpsys", "window", "displays"],
    { timeout: ADB_QUERY_TIMEOUT_MS, signal, lane: "background" },
  );
  if (execFailed(r)) {
    throw new Error(`dumpsys window displays failed: ${execFailure(r)}`);
  }

  const defaultDisplayMarker = r.stdout.match(
    /(?:^|\n)[ \t]*Display:\s+mDisplayId=0\b/,
  );
  let displayState = r.stdout;
  if (defaultDisplayMarker?.index !== undefined) {
    const start = defaultDisplayMarker.index + defaultDisplayMarker[0].length;
    const remainder = r.stdout.slice(start);
    const nextDisplay = remainder.search(/\n[ \t]*Display:\s+mDisplayId=/);
    displayState = nextDisplay === -1
      ? remainder
      : remainder.slice(0, nextDisplay);
  }

  const match = displayState.match(
    /\bm(?:Current|Display)?Rotation=(?:ROTATION_)?(0|1|2|3|90|180|270)\b/,
  );
  if (!match) {
    throw new Error("Could not parse active display rotation");
  }
  const value = Number(match[1]);
  return (value > 3 ? value / 90 : value) as DisplayRotation;
}

function orientationFromRotation(mode: "free" | "lock" | "unknown", rotation: number | null): OrientationStatus["orientation"] {
  if (mode === "free") return "auto";
  if (rotation === 0 || rotation === 2) return "portrait";
  if (rotation === 1 || rotation === 3) return "landscape";
  return "unknown";
}

export async function getUserRotation(
  serial: string,
  runExec: typeof execText = execText,
): Promise<OrientationStatus> {
  const r = await runExec("adb", ["-s", serial, "shell", "cmd", "window", "user-rotation"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `cmd window user-rotation failed: ${execFailure(r)}`,
    );
  }
  const raw = r.stdout.trim();
  const match = raw.match(/^(free|lock)(?:\s+(\d+))?$/);
  if (!match) {
    return { mode: "unknown", rotation: null, orientation: "unknown", raw };
  }
  const mode = match[1] as "free" | "lock";
  const rotation = match[2] === undefined ? null : Number(match[2]);
  return { mode, rotation, orientation: orientationFromRotation(mode, rotation), raw };
}

export async function setUserRotation(
  serial: string,
  orientation: OrientationMode,
  runExec: typeof execText = execText,
): Promise<OrientationStatus> {
  const args =
    orientation === "auto"
      ? ["cmd", "window", "user-rotation", "free"]
      : ["cmd", "window", "user-rotation", "lock", orientation === "portrait" ? "0" : "1"];
  const r = await runExec("adb", ["-s", serial, "shell", ...args], {
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `adb shell ${args.join(" ")} failed: ${execFailure(r)}`,
    );
  }
  return getUserRotation(serial, runExec);
}

export async function getFontScale(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FontScaleStatus> {
  const r = await runExec("adb", ["-s", serial, "shell", "settings", "get", "system", "font_scale"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `settings get system font_scale failed: ${execFailure(r)}`,
    );
  }
  const raw = r.stdout.trim();
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`Could not parse font_scale output: ${r.stdout}`);
  }
  return { scale, raw };
}

export async function setFontScale(
  serial: string,
  scale: number,
  runExec: typeof execText = execText,
): Promise<FontScaleStatus> {
  if (!Number.isFinite(scale) || scale < 0.7 || scale > 2) {
    throw new Error("font scale must be between 0.7 and 2.0");
  }
  const normalized = scale.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const args = ["settings", "put", "system", "font_scale", normalized];
  const r = await runExec("adb", ["-s", serial, "shell", ...args], {
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `adb shell ${args.join(" ")} failed: ${execFailure(r)}`,
    );
  }
  return getFontScale(serial, runExec);
}

function nightModeFromRaw(raw: string): NightMode | "unknown" {
  const match = raw.match(/Night mode:\s*(\S+)/i);
  const value = (match?.[1] ?? raw).trim().toLowerCase();
  if (value === "yes") return "dark";
  if (value === "no") return "light";
  if (value === "auto") return "auto";
  return "unknown";
}

export async function getNightMode(
  serial: string,
  runExec: typeof execText = execText,
): Promise<NightModeStatus> {
  const r = await runExec("adb", ["-s", serial, "shell", "cmd", "uimode", "night"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(`cmd uimode night failed: ${execFailure(r)}`);
  }
  const raw = r.stdout.trim();
  return { mode: nightModeFromRaw(raw), raw };
}

export async function setNightMode(
  serial: string,
  mode: NightMode,
  runExec: typeof execText = execText,
): Promise<NightModeStatus> {
  const value = mode === "dark" ? "yes" : mode === "light" ? "no" : "auto";
  const args = ["cmd", "uimode", "night", value];
  const r = await runExec("adb", ["-s", serial, "shell", ...args], {
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `adb shell ${args.join(" ")} failed: ${execFailure(r)}`,
    );
  }
  return getNightMode(serial, runExec);
}

async function globalSetting(
  serial: string,
  name: string,
  runExec: typeof execText = execText,
): Promise<string> {
  const r = await runExec(
    "adb",
    ["-s", serial, "shell", "settings", "get", "global", name],
    {
      timeout: ADB_QUERY_TIMEOUT_MS,
    },
  );
  if (execFailed(r)) {
    throw new Error(
      `settings get global ${name} failed: ${execFailure(r)}`,
      { cause: r.error ?? undefined },
    );
  }
  return r.stdout.trim();
}

function radioStatusFromSetting(raw: string): NetworkRadioStatus {
  if (raw === "1") return "enabled";
  if (raw === "0") return "disabled";
  return "unknown";
}

export async function getNetworkStatus(
  serial: string,
  runExec: typeof execText = execText,
): Promise<NetworkStatus> {
  const [wifiRaw, mobileDataRaw] = await Promise.all([
    globalSetting(serial, "wifi_on", runExec),
    globalSetting(serial, "mobile_data", runExec),
  ]);
  const wifi = radioStatusFromSetting(wifiRaw);
  const mobileData = radioStatusFromSetting(mobileDataRaw);
  const radios = [wifi, mobileData];
  const knownRadios = radios.filter((radio) => radio !== "unknown");
  const enabled = knownRadios.length === 0 ? null : knownRadios.some((radio) => radio === "enabled");
  return {
    enabled,
    wifi,
    mobileData,
    raw: {
      wifi: wifiRaw,
      mobileData: mobileDataRaw,
    },
  };
}

export async function setNetworkEnabled(
  serial: string,
  enabled: boolean,
  runExec: typeof execText = execText,
): Promise<NetworkStatus> {
  const action = enabled ? "enable" : "disable";
  for (const service of ["wifi", "data"]) {
    const args = ["svc", service, action];
    const r = await runExec("adb", ["-s", serial, "shell", ...args], {
      timeout: ADB_MUTATION_TIMEOUT_MS,
    });
    if (execFailed(r)) {
      throw new Error(
        `adb shell ${args.join(" ")} failed: ${execFailure(r)}`,
      );
    }
  }
  return getNetworkStatus(serial, runExec);
}

async function secureSetting(
  serial: string,
  name: string,
  runExec: typeof execText = execText,
): Promise<string> {
  const r = await runExec(
    "adb",
    ["-s", serial, "shell", "settings", "get", "secure", name],
    {
      timeout: ADB_QUERY_TIMEOUT_MS,
    },
  );
  if (execFailed(r)) {
    throw new Error(
      `settings get secure ${name} failed: ${execFailure(r)}`,
      { cause: r.error ?? undefined },
    );
  }
  return r.stdout.trim();
}

async function mutateShell(
  serial: string,
  args: readonly string[],
  runExec: typeof execText = execText,
): Promise<void> {
  const r = await runExec("adb", ["-s", serial, "shell", ...args], {
    timeout: ADB_MUTATION_TIMEOUT_MS,
  });
  if (execFailed(r)) {
    throw new Error(
      `adb shell ${args.join(" ")} failed: ${execFailure(r)}`,
    );
  }
}

/** Android's "Remove animations" toggle moves all three scales, so read and write them as one. */
const ANIMATION_SCALE_KEYS = [
  "transition_animation_scale",
  "window_animation_scale",
  "animator_duration_scale",
] as const;

/** Mirrors React Native's `AccessibilityInfoModule`, which is on only at exactly zero. */
function reduceMotionFromScale(raw: string): boolean {
  return raw !== "" && Number(raw.replace(",", ".")) === 0;
}

/** An unset key reads back as the literal `null`, so anything but an int is off. */
function enabledFromIntSetting(raw: string): boolean {
  return /^[+-]?\d+$/.test(raw) && Number(raw) !== 0;
}

/** Read the animation scales, with `transition_animation_scale` as the authority. */
export async function getReduceMotion(
  serial: string,
  runExec: typeof execText = execText,
): Promise<ReduceMotionStatus> {
  const [transition, window, animator] = await Promise.all([
    globalSetting(serial, ANIMATION_SCALE_KEYS[0], runExec),
    globalSetting(serial, ANIMATION_SCALE_KEYS[1], runExec),
    globalSetting(serial, ANIMATION_SCALE_KEYS[2], runExec),
  ]);
  return {
    enabled: reduceMotionFromScale(transition),
    raw: { transition, window, animator },
  };
}

/** Write `0` to disable animations and `1` to restore the Android defaults. */
export async function setReduceMotion(
  serial: string,
  enabled: boolean,
  runExec: typeof execText = execText,
): Promise<ReduceMotionStatus> {
  const value = enabled ? "0" : "1";
  for (const key of ANIMATION_SCALE_KEYS) {
    await mutateShell(serial, ["settings", "put", "global", key, value], runExec);
  }
  return getReduceMotion(serial, runExec);
}

export async function getHighTextContrast(
  serial: string,
  runExec: typeof execText = execText,
): Promise<HighTextContrastStatus> {
  const raw = await secureSetting(serial, "high_text_contrast_enabled", runExec);
  return { enabled: enabledFromIntSetting(raw), raw };
}

/** Write the flag as the `1` or `0` int Android's `Settings.Secure` stores. */
export async function setHighTextContrast(
  serial: string,
  enabled: boolean,
  runExec: typeof execText = execText,
): Promise<HighTextContrastStatus> {
  await mutateShell(
    serial,
    ["settings", "put", "secure", "high_text_contrast_enabled", enabled ? "1" : "0"],
    runExec,
  );
  return getHighTextContrast(serial, runExec);
}

/** The adjustment Android's own Bold text toggle writes. */
const FONT_WEIGHT_BOLD_ADJUSTMENT = 300;

export async function getFontWeight(
  serial: string,
  runExec: typeof execText = execText,
): Promise<FontWeightStatus> {
  const raw = await secureSetting(serial, "font_weight_adjustment", runExec);
  return { enabled: enabledFromIntSetting(raw), raw };
}

/** `Configuration.fontWeightAdjustment` reads this key, so native and Compose text bold too. */
export async function setFontWeight(
  serial: string,
  enabled: boolean,
  runExec: typeof execText = execText,
): Promise<FontWeightStatus> {
  await mutateShell(
    serial,
    [
      "settings",
      "put",
      "secure",
      "font_weight_adjustment",
      String(enabled ? FONT_WEIGHT_BOLD_ADJUSTMENT : 0),
    ],
    runExec,
  );
  return getFontWeight(serial, runExec);
}

const DISPLAY_DENSITY_MIN_DPI = 72;

/** `wm density` reports the physical density and, only when set, the override. */
async function readDisplayDensity(
  serial: string,
  runExec: typeof execText = execText,
): Promise<{ physical: number; override: number | null; raw: string }> {
  const r = await runExec("adb", ["-s", serial, "shell", "wm", "density"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) throw new Error(`wm density failed: ${execFailure(r)}`);
  const raw = r.stdout.trim();
  const physical = Number(/Physical density:\s*(\d+)/.exec(raw)?.[1]);
  if (!Number.isFinite(physical) || physical <= 0) {
    throw new Error(`Could not parse wm density output: ${raw}`);
  }
  const override = /Override density:\s*(\d+)/.exec(raw)?.[1];
  return { physical, override: override === undefined ? null : Number(override), raw };
}

/**
 * `wm size` with the override preferred, unlike {@link getDeviceSize}, which
 * reports the panel the stream is encoded from.
 */
async function readEffectiveDisplaySize(
  serial: string,
  runExec: typeof execText = execText,
): Promise<{ widthPx: number; heightPx: number }> {
  const r = await runExec("adb", ["-s", serial, "shell", "wm", "size"], {
    timeout: ADB_QUERY_TIMEOUT_MS,
  });
  if (execFailed(r)) throw new Error(`wm size failed: ${execFailure(r)}`);
  const raw = r.stdout.trim();
  const size = /Override size:\s*(\d+)x(\d+)/.exec(raw) ??
    /Physical size:\s*(\d+)x(\d+)/.exec(raw);
  const widthPx = Number(size?.[1]);
  const heightPx = Number(size?.[2]);
  if (
    !Number.isFinite(widthPx) || widthPx <= 0 ||
    !Number.isFinite(heightPx) || heightPx <= 0
  ) {
    throw new Error(`Could not parse wm size output: ${raw}`);
  }
  return { widthPx, heightPx };
}

/** Report the override as a ratio of the device's own physical density. */
export async function getDisplayDensity(
  serial: string,
  runExec: typeof execText = execText,
): Promise<DisplayDensityStatus> {
  const [{ physical, override, raw }, { widthPx, heightPx }] = await Promise.all([
    readDisplayDensity(serial, runExec),
    readEffectiveDisplaySize(serial, runExec),
  ]);
  const density = override ?? physical;
  return {
    scale: Math.round((density / physical) * 1000) / 1000,
    // `swNNNdp` keys off the smallest dimension, so this survives rotation.
    widthDp: Math.round((Math.min(widthPx, heightPx) * 160) / density),
    raw,
  };
}

/** The default step must clear the override, not pin it to the physical density. */
export async function setDisplayDensity(
  serial: string,
  scale: number,
  runExec: typeof execText = execText,
): Promise<DisplayDensityStatus> {
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) {
    throw new Error("display size scale must be between 0.5 and 2.0");
  }
  const { physical } = await readDisplayDensity(serial, runExec);
  const density = Math.round(physical * scale);
  if (density < DISPLAY_DENSITY_MIN_DPI) {
    throw new Error(
      `display density ${density} is below the Android minimum of ${DISPLAY_DENSITY_MIN_DPI}`,
    );
  }
  await mutateShell(
    serial,
    ["wm", "density", density === physical ? "reset" : String(density)],
    runExec,
  );
  return getDisplayDensity(serial, runExec);
}
