import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { findBootedDevice, resolveDevice } from "./device";
import { setHardwareKeyboard } from "./native";
import { dirnameOf } from "./runtime";
import { stateDir } from "./state";
import { withStateLock } from "./state-lock";

// Bun's bundler inlines a bare `__dirname` as the build machine's source
// directory; shadow it with the runtime location so the published bundle
// finds dist/simax next to itself (same pattern as index.ts).
const __dirname = dirnameOf(import.meta.url);

// ─── Option catalogue ───
//
// Simulator-wide options surfaced in the sidebar, mirroring the Xcode Devices
// app. Three (`appearance`, `increase-contrast`, `text-size`) ride on
// `simctl ui`; the rest have no simctl verb, so they go through the
// sim-ax-settings helper spawned inside the simulator (see
// Sources/SimAXSettings), which drives the same private libAccessibility /
// MediaAccessibility setters the Devices app uses.

export const CONTENT_SIZE_CATEGORIES = [
  "extra-small",
  "small",
  "medium",
  "large",
  "extra-large",
  "extra-extra-large",
  "extra-extra-extra-large",
  "accessibility-medium",
  "accessibility-large",
  "accessibility-extra-large",
  "accessibility-extra-extra-large",
  "accessibility-extra-extra-extra-large",
] as const;

export const COLOR_FILTERS = [
  "none",
  "grayscale",
  "red-green",
  "green-red",
  "blue-yellow",
] as const;

const COLOR_FILTER_ALIASES: Record<string, string> = {
  protanopia: "red-green",
  deuteranopia: "green-red",
  tritanopia: "blue-yellow",
};

const TOGGLE_VALUES = ["on", "off"] as const;

const ON_SYNONYMS = new Set(["on", "true", "enabled", "1", "yes"]);
const OFF_SYNONYMS = new Set(["off", "false", "disabled", "0", "no"]);

interface UiOptionSpec {
  /**
   * `simctl ui` subcommand, "ax" for the in-sim helper, or "device" for a
   * host-side CoreSimulator device setting driven through the native addon.
   */
  via: "appearance" | "increase_contrast" | "content_size" | "ax" | "device";
  values: readonly string[];
  /** Extra accepted set-values that aren't reported by `get` (text-size). */
  extraValues?: readonly string[];
  aliases?: Record<string, string>;
  toggle?: boolean;
  /** Reported value before anything is set (device-backed options only). */
  default?: string;
}

export const UI_OPTIONS: Record<string, UiOptionSpec> = {
  appearance: { via: "appearance", values: ["light", "dark"] },
  "liquid-glass": { via: "ax", values: ["clear", "tinted"] },
  "color-filter": { via: "ax", values: COLOR_FILTERS, aliases: COLOR_FILTER_ALIASES },
  "text-size": {
    via: "content_size",
    values: CONTENT_SIZE_CATEGORIES,
    extraValues: ["increment", "decrement"],
  },
  "reduce-motion": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  "increase-contrast": { via: "increase_contrast", values: TOGGLE_VALUES, toggle: true },
  "show-borders": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  "reduce-transparency": { via: "ax", values: TOGGLE_VALUES, toggle: true },
  voiceover: { via: "ax", values: TOGGLE_VALUES, toggle: true },
  "hardware-keyboard": { via: "device", values: TOGGLE_VALUES, toggle: true, default: "on" },
};

function deviceOptionStateFile(udid: string): string {
  return join(stateDir(), `ui-${encodeURIComponent(udid)}.json`);
}

interface DeviceOptionState {
  bootSession: string;
  revision: string;
  values: Record<string, string>;
}

const deviceBootSessions = new Map<string, string>();

function readDeviceOptionState(udid: string): DeviceOptionState | null {
  try {
    const state = JSON.parse(readFileSync(deviceOptionStateFile(udid), "utf8")) as Partial<DeviceOptionState>;
    if (typeof state.bootSession !== "string" || typeof state.revision !== "string" ||
      !state.values || typeof state.values !== "object") return null;
    return { bootSession: state.bootSession, revision: state.revision, values: state.values };
  } catch {
    return null;
  }
}

function writeDeviceOptionState(udid: string, bootSession: string, option: string, value: string): string {
  mkdirSync(stateDir(), { recursive: true });
  const file = deviceOptionStateFile(udid);
  const temporary = `${file}.${process.pid}.tmp`;
  const current = readDeviceOptionState(udid);
  const values = current?.bootSession === bootSession ? current.values : {};
  const revision = randomUUID();
  writeFileSync(temporary, JSON.stringify({ bootSession, revision, values: { ...values, [option]: value } }), { mode: 0o600 });
  renameSync(temporary, file);
  return revision;
}

function deviceOptionStateLockFile(udid: string): string {
  return join(stateDir(), `ui-${encodeURIComponent(udid)}.lock`);
}

function withDeviceOptionStateLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  const path = deviceOptionStateLockFile(udid);
  return withStateLock(
    path,
    10_000,
    () => new Error(
      `Timed out waiting to update simulator UI settings for ${udid}. Another serve-sim command is holding ${path}. ` +
        "Wait for it to finish, or remove that file if nothing is running.",
    ),
    fn,
  );
}

async function deviceBootSession(udid: string, refresh = false): Promise<string> {
  if (!refresh) {
    const cached = deviceBootSessions.get(udid);
    if (cached) return cached;
  }
  const bootSession = await run("xcrun", ["simctl", "spawn", udid, "launchctl", "managerpid"]);
  if (!/^\d+$/.test(bootSession)) {
    throw new Error(`Could not identify the boot session for simulator ${udid}. Make sure it is booted and try again.`);
  }
  deviceBootSessions.set(udid, bootSession);
  return bootSession;
}

async function currentDeviceOptionState(udid: string, refresh = false): Promise<DeviceOptionState | null> {
  const state = readDeviceOptionState(udid);
  if (!state) return null;
  const bootSession = await deviceBootSession(udid, refresh).catch(() => null);
  if (!bootSession) return null;
  if (state.bootSession === bootSession) return state;
  return null;
}

export async function refreshDeviceOptionState(udid: string): Promise<void> {
  await currentDeviceOptionState(udid, true);
}

/**
 * Map a user-supplied value onto its canonical form for the option, or null
 * when the value isn't valid. Toggles accept the usual on/off synonyms.
 */
export function normalizeUiValue(option: string, value: string): string | null {
  const spec = Object.hasOwn(UI_OPTIONS, option) ? UI_OPTIONS[option] : undefined;
  if (!spec) return null;
  const v = value.toLowerCase();
  if (spec.toggle) {
    if (ON_SYNONYMS.has(v)) return "on";
    if (OFF_SYNONYMS.has(v)) return "off";
    return null;
  }
  const aliased = spec.aliases?.[v] ?? v;
  if (spec.values.includes(aliased)) return aliased;
  if (spec.extraValues?.includes(aliased)) return aliased;
  return null;
}

export interface UiArgs {
  command: "status" | "get" | "set";
  option?: string;
  value?: string;
  device?: string;
  json: boolean;
  error?: string;
}

export function parseUiArgs(args: string[]): UiArgs {
  const rest: string[] = [];
  let device: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-d" || a === "--device") {
      if (i + 1 >= args.length) {
        return { command: "get", json, error: `${a} requires a value` };
      }
      device = args[++i];
    } else if (a === "--json") json = true;
    else rest.push(a);
  }

  if (rest.length === 0 || rest[0] === "status") {
    return { command: "status", json, ...(device ? { device } : {}) };
  }

  const option = rest[0]!.toLowerCase();
  if (!Object.hasOwn(UI_OPTIONS, option)) {
    return { command: "get", json, error: `unknown option: ${option}` };
  }
  if (rest.length === 1) {
    return { command: "get", option, json, ...(device ? { device } : {}) };
  }
  const value = normalizeUiValue(option, rest[1]!);
  if (value === null) {
    const spec = UI_OPTIONS[option]!;
    const accepted = [...spec.values, ...(spec.extraValues ?? [])].join("|");
    return {
      command: "set",
      option,
      json,
      error: `invalid value for ${option}: ${rest[1]} (accepted: ${accepted})`,
    };
  }
  return { command: "set", option, value, json, ...(device ? { device } : {}) };
}

// ─── In-sim helper binary ───

export function locateAxSettingsTool(): string | null {
  const candidates = [
    join(__dirname, "..", "dist", "simax", "serve-sim-ax-settings"),
    join(__dirname, "simax", "serve-sim-ax-settings"),
  ];
  for (const p of candidates) if (existsSync(p)) return resolve(p);
  return null;
}

// One-time build is memoized as a promise so concurrent in-server callers
// share a single clang invocation instead of racing.
let axToolPromise: Promise<string> | null = null;

function axSettingsTool(): Promise<string> {
  axToolPromise ??= (async () => {
    const located = locateAxSettingsTool();
    if (located) return located;
    const buildScript = join(__dirname, "..", "Sources", "SimAXSettings", "build.sh");
    if (!existsSync(buildScript)) {
      throw new Error(
        "sim-ax-settings binary not found — this build of serve-sim does not " +
          "include the simulator settings helper. Reinstall from a recent release.",
      );
    }
    console.error("[serve-sim] building sim-ax-settings (one-time)…");
    await run("bash", [buildScript]);
    const out = locateAxSettingsTool();
    if (!out) throw new Error("Build succeeded but sim-ax-settings not found.");
    return out;
  })();
  axToolPromise.catch(() => {
    axToolPromise = null;
  });
  return axToolPromise;
}

// ─── Backends ───
// Async throughout: these also run inside the preview server's event loop
// (the sidebar drives them through the control socket), where a blocking
// execFileSync would stall every stream the server is carrying.

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message));
      else resolve(String(stdout).trim());
    });
  });
}

function simctlUi(udid: string, subcommand: string, value?: string): Promise<string> {
  const args = ["simctl", "ui", udid, subcommand];
  if (value !== undefined) args.push(value);
  return run("xcrun", args);
}

async function axRun(udid: string, ...args: string[]): Promise<string> {
  const tool = await axSettingsTool();
  return run("xcrun", ["simctl", "spawn", udid, tool, ...args]);
}

function toToggle(simctlValue: string): string {
  return simctlValue === "enabled" ? "on" : "off";
}

function fromToggle(value: string): string {
  return value === "on" ? "enabled" : "disabled";
}

export async function getUiOption(udid: string, option: string): Promise<string> {
  const spec = Object.hasOwn(UI_OPTIONS, option) ? UI_OPTIONS[option] : undefined;
  if (!spec) throw new Error(`unknown option: ${option}`);
  if (spec.via === "device") {
    return (await currentDeviceOptionState(udid))?.values[option] ?? spec.default ?? "off";
  }
  if (spec.via === "ax") return axRun(udid, "get", option);
  // simctl's casing is inconsistent (`content_size` prints "Small" but
  // "large") — values are canonically lowercase everywhere here.
  const raw = (await simctlUi(udid, spec.via)).toLowerCase();
  return spec.toggle ? toToggle(raw) : raw;
}

async function applyDeviceUiOption(udid: string, option: string, value: string): Promise<void> {
  if (option === "hardware-keyboard" && !await setHardwareKeyboard(udid, value === "on")) {
    throw new Error(
      `Could not turn the hardware keyboard ${value} because CoreSimulator rejected the change. ` +
        "Make sure the simulator is booted, then try again.",
    );
  }
}

export async function setUiOption(udid: string, option: string, value: string): Promise<string | undefined> {
  const spec = Object.hasOwn(UI_OPTIONS, option) ? UI_OPTIONS[option] : undefined;
  if (!spec) throw new Error(`unknown option: ${option}`);
  if (spec.via === "device") {
    return withDeviceOptionStateLock(udid, async () => {
      const bootSession = await deviceBootSession(udid, true);
      return applyAndSaveDeviceUiOption(udid, bootSession, option, value);
    });
  }
  if (spec.via === "ax") {
    await axRun(udid, "set", option, value);
    return;
  }
  await simctlUi(udid, spec.via, spec.toggle ? fromToggle(value) : value);
}

async function applyAndSaveDeviceUiOption(
  udid: string, bootSession: string, option: string, value: string,
): Promise<string> {
  const current = readDeviceOptionState(udid);
  const previous = current?.bootSession === bootSession ? current.values[option] : undefined;
  await applyDeviceUiOption(udid, option, value);
  try {
    return writeDeviceOptionState(udid, bootSession, option, value);
  } catch (error) {
    if (previous === undefined) {
      throw new Error(`Could not save ${option} for simulator ${udid}; its previous value is unknown and cannot be restored. ` +
        "Check that the state directory is writable, then explicitly set the option again.", { cause: error });
    }
    try {
      await applyDeviceUiOption(udid, option, previous);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `Could not save or restore ${option} for simulator ${udid}. ` +
        "Check that the state directory is writable, then explicitly set the option again.");
    }
    throw error;
  }
}

export async function setUiOptionIfRevision(
  udid: string,
  option: string,
  value: string,
  expectedRevision: string,
): Promise<string | null> {
  const spec = Object.hasOwn(UI_OPTIONS, option) ? UI_OPTIONS[option] : undefined;
  if (!spec) throw new Error(`unknown option: ${option}`);
  if (spec.via !== "device") throw new Error(`${option} does not support conditional updates`);
  return withDeviceOptionStateLock(udid, async () => {
    const bootSession = await deviceBootSession(udid, true);
    const current = readDeviceOptionState(udid);
    if (current?.bootSession !== bootSession || current.revision !== expectedRevision) return null;
    return applyAndSaveDeviceUiOption(udid, bootSession, option, value);
  });
}

export async function getUiStatus(udid: string): Promise<Record<string, string>> {
  // One ax-tool spawn covers all its settings; the non-ax reads (simctl- and
  // device-backed) fan out in parallel alongside it. The ax helper is an
  // iOS-simulator Mach-O, so on watchOS / tvOS / visionOS the spawn aborts in
  // dyld — degrade those options to "unsupported" instead of failing the whole
  // panel. (The web UI also gates the panel on the device runtime, so this is
  // the backstop for direct callers.)
  const nonAxOptions = Object.entries(UI_OPTIONS).filter(([, spec]) => spec.via !== "ax");
  const [axStatus, ...nonAxValues] = await Promise.all([
    axRun(udid, "status")
      .then((out) => JSON.parse(out) as Record<string, string>)
      .catch(() => ({}) as Record<string, string>),
    ...nonAxOptions.map(([option]) => getUiOption(udid, option).catch(() => "unsupported")),
  ]);
  const status: Record<string, string> = {};
  for (const [option, spec] of Object.entries(UI_OPTIONS)) {
    if (spec.via === "ax") status[option] = axStatus[option] ?? "unsupported";
  }
  nonAxOptions.forEach(([option], i) => {
    status[option] = nonAxValues[i]!;
  });
  return status;
}

// ─── CLI entry (`serve-sim ui …`) ───

const USAGE = `Usage: serve-sim ui [status] [--json] [-d udid]
       serve-sim ui <option> [-d udid]            Print the current value
       serve-sim ui <option> <value> [-d udid]    Change the value

Simulator-wide UI options:
  appearance           light | dark
  liquid-glass         clear | tinted
  color-filter         none | grayscale | red-green | green-red | blue-yellow
                       (protanopia/deuteranopia/tritanopia aliases accepted)
  text-size            ${CONTENT_SIZE_CATEGORIES.slice(0, 4).join(" | ")} | …
                       (12 content-size categories, or increment | decrement)
  reduce-motion        on | off
  increase-contrast    on | off
  show-borders         on | off
  reduce-transparency  on | off
  voiceover            on | off
  hardware-keyboard    on | off`;

export async function uiSettings(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const parsed = parseUiArgs(args);
  if (parsed.error) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }

  const udid = parsed.device ? resolveDevice(parsed.device) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator found. Boot one or pass -d <udid>.");
    process.exit(1);
  }

  if (parsed.command === "status") {
    const status = await getUiStatus(udid);
    if (parsed.json) {
      console.log(JSON.stringify(status));
    } else {
      for (const [option, value] of Object.entries(status)) {
        console.log(`${option.padEnd(20)} ${value}`);
      }
    }
    return;
  }

  if (parsed.command === "get") {
    console.log(await getUiOption(udid, parsed.option!));
    return;
  }

  await setUiOption(udid, parsed.option!, parsed.value!);
}
