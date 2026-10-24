import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { dirnameOf } from "./runtime";

const __dirname = dirnameOf(import.meta.url);
import { findBootedDevice, resolveDevice } from "./device";

// ─── Permission catalogue ───

type PermissionKind = "tcc" | "notifications" | "location";

interface PermissionSpec {
  kind: PermissionKind;
  /** TCC service identifier, for `kind === "tcc"`. */
  tccService?: string;
  /** TCC `auth_version` column — photos uses 2, everything else 1. */
  tccAuthVersion?: number;
  /** Whether `--value` is meaningful for this permission. */
  values?: string[];
}

const TCC_SERVICES: Record<string, string> = {
  camera: "kTCCServiceCamera",
  microphone: "kTCCServiceMicrophone",
  photos: "kTCCServicePhotos",
  "photos-add": "kTCCServicePhotosAdd",
  contacts: "kTCCServiceAddressBook",
  calendar: "kTCCServiceCalendar",
  reminders: "kTCCServiceReminders",
  motion: "kTCCServiceMotion",
  "media-library": "kTCCServiceMediaLibrary",
  siri: "kTCCServiceSiri",
  speech: "kTCCServiceSpeechRecognition",
  faceid: "kTCCServiceFaceID",
  "user-tracking": "kTCCServiceUserTracking",
  homekit: "kTCCServiceWillow",
};

// Names that map onto a canonical permission, sometimes pinning a `--value`.
const ALIASES: Record<string, { permission: string; value?: string }> = {
  push: { permission: "notifications" },
  notification: { permission: "notifications" },
  "photo-library": { permission: "photos" },
  photo: { permission: "photos" },
  "location-always": { permission: "location", value: "always" },
  "location-in-use": { permission: "location", value: "inuse" },
  "location-inuse": { permission: "location", value: "inuse" },
  mic: { permission: "microphone" },
};

export function resolvePermission(name: string): PermissionSpec | null {
  if (name === "notifications") return { kind: "notifications", values: ["critical"] };
  if (name === "location") return { kind: "location", values: ["always", "inuse", "never"] };
  const service = TCC_SERVICES[name];
  if (service) {
    return {
      kind: "tcc",
      tccService: service,
      tccAuthVersion: name === "photos" ? 2 : 1,
      values: name === "photos" ? ["limited"] : undefined,
    };
  }
  return null;
}

/** Every canonical permission name, used by `reset all` and `--help`. */
export function allPermissionNames(): string[] {
  return ["notifications", "location", ...Object.keys(TCC_SERVICES)];
}

// ─── Argument parsing ───

export type Verb = "grant" | "revoke" | "reset" | "list";

export interface ParsedArgs {
  verb: Verb;
  /** Canonical permission name, or "all" for `reset all`. Absent for `list`. */
  permission?: string;
  value?: string;
  bundleId?: string;
  device?: string;
}

const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function parsePermissionsArgs(args: string[]): ParsedArgs | { error: string } {
  let device: string | undefined;
  let value: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "-d" || a === "--device") {
      device = args[++i];
      if (!device) return { error: "Missing value for -d/--device" };
    } else if (a === "--value") {
      value = args[++i];
      if (value === undefined) return { error: "Missing value for --value" };
    } else if (a.startsWith("--value=")) {
      value = a.slice("--value=".length);
    } else if (a.startsWith("-")) {
      return { error: `Unknown flag: ${a}` };
    } else {
      positional.push(a);
    }
  }

  const verbRaw = positional[0];
  if (!verbRaw) return { error: "Missing subcommand: grant | revoke | reset | list" };
  const verb: Verb | undefined = (
    { grant: "grant", revoke: "revoke", deny: "revoke", reset: "reset", list: "list" } as const
  )[verbRaw];
  if (!verb) return { error: `Unknown subcommand: ${verbRaw}` };

  if (verb === "list") {
    // permissions list [bundle-id] [-d udid]
    const bundleId = positional[1];
    if (bundleId && !BUNDLE_ID_RE.test(bundleId)) {
      return { error: `Invalid bundle id: ${bundleId}` };
    }
    return { verb, bundleId, device };
  }

  let permission = positional[1];
  if (!permission) return { error: `Missing permission name for "${verb}"` };

  // `reset all` is a special case — no bundle-scoped permission lookup.
  if (verb === "reset" && permission === "all") {
    const bundleId = positional[2];
    if (!bundleId) return { error: "Missing bundle id for `reset all`" };
    if (!BUNDLE_ID_RE.test(bundleId)) return { error: `Invalid bundle id: ${bundleId}` };
    return { verb, permission: "all", bundleId, device };
  }

  // Resolve aliases (may pin a value).
  const alias = ALIASES[permission];
  if (alias) {
    permission = alias.permission;
    if (alias.value && !value) value = alias.value;
  }

  const spec = resolvePermission(permission);
  if (!spec) {
    return {
      error: `Unknown permission: ${positional[1]}\nSupported: ${allPermissionNames().join(", ")}`,
    };
  }

  const bundleId = positional[2];
  if (!bundleId) return { error: `Missing bundle id for "${verb} ${permission}"` };
  if (!BUNDLE_ID_RE.test(bundleId)) return { error: `Invalid bundle id: ${bundleId}` };

  // A trailing positional (4th arg) is also accepted as the value, matching
  // applesimutils' `permission grant photos limited` shape.
  if (!value && positional[3]) value = positional[3];

  if (value !== undefined) {
    if (!spec.values || !spec.values.includes(value)) {
      const allowed = spec.values ? spec.values.join(", ") : "(none)";
      return {
        error: `Invalid --value "${value}" for ${permission}. Allowed: ${allowed}`,
      };
    }
  }

  return { verb, permission, value, bundleId, device };
}

// ─── Simulator paths ───

function simLibraryDir(udid: string): string {
  return join(homedir(), "Library/Developer/CoreSimulator/Devices", udid, "data/Library");
}

export function tccDbPath(udid: string): string {
  return join(simLibraryDir(udid), "TCC/TCC.db");
}

// @ref LLP 0003#app-permissions — service writes preserve running app processes
function nativePermission<T = unknown>(udid: string, ...args: string[]): T {
  const candidates = [
    join(dirname(process.execPath), "simperm/serve-sim-permissions"),
    join(__dirname, "simperm/serve-sim-permissions"),
    join(__dirname, "../dist/simperm/serve-sim-permissions"),
  ];
  const tool = candidates.find(existsSync);
  if (!tool)
    throw new Error("Simulator permissions helper not found. Rebuild or reinstall serve-sim.");
  try {
    return JSON.parse(
      execFileSync("xcrun", ["simctl", "spawn", udid, resolve(tool), ...args], {
        encoding: "utf-8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error: any) {
    const detail = String(error?.stderr ?? "")
      .trim()
      .replace(/\s+/g, " ");
    throw new Error(
      detail ||
        (error?.killed
          ? "Simulator permissions helper timed out"
          : "Simulator permissions helper failed"),
    );
  }
}

// @ref LLP 0003#app-permissions — wait through tccd writer locks within the read budget
export function readPermissionDatabase(dbPath: string, sql: string): string {
  // Leave startup/exit time inside the five-second subprocess deadline.
  return execFileSync("sqlite3", ["-readonly", "-cmd", ".timeout 4500", dbPath, sql], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

// Reverse of TCC_SERVICES, so `list` reports the same permission names that
// grant/revoke/reset accept rather than raw kTCCService* database keys.
const TCC_NAME_BY_SERVICE: Record<string, string> = Object.fromEntries(
  Object.entries(TCC_SERVICES).map(([name, service]) => [service, name]),
);

function readTcc(udid: string, bundleId?: string): Record<string, number> {
  const db = tccDbPath(udid);
  if (!existsSync(db)) return {};
  const where = bundleId ? ` WHERE client='${bundleId}'` : "";
  const out = readPermissionDatabase(db, `SELECT service, auth_value FROM access${where};`);
  const result: Record<string, number> = {};
  for (const line of out.split("\n")) {
    const [service, authValue] = line.split("|");
    if (service) result[TCC_NAME_BY_SERVICE[service] ?? service] = Number(authValue);
  }
  return result;
}

// ─── Location writer ───

// locationd owns clients.plist and keys app entries with an `i<bundleId>:`
// scheme — the trailing colon is part of the key, so neither plutil (dot
// paths) nor PlistBuddy (colon paths) can address it, and a hand-written
// plain-bundle-id entry is ignored. `simctl privacy` understands the format
// and is reliable specifically for location, so delegate to it here.
function readLocation(udid: string, bundleId: string): { Authorization: number } | null {
  return nativePermission(
    udid,
    "location",
    "get",
    bundleId,
    join(simLibraryDir(udid), "Caches/locationd/clients.plist"),
  );
}

function setLocation(
  udid: string,
  bundleId: string,
  mode: "grant" | "revoke" | "reset",
  value: string | undefined,
): void {
  let action = "grant";
  let service = "location";
  if (mode === "reset") {
    action = "reset";
  } else if (mode === "revoke" || value === "never") {
    action = "revoke";
  } else if (value === "always") {
    service = "location-always";
  }
  try {
    execFileSync("xcrun", ["simctl", "privacy", udid, action, service, bundleId], {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e: any) {
    throw new Error(
      `simctl privacy ${action} ${service} failed: ` + String(e?.stderr ?? e?.message ?? e).trim(),
    );
  }
  // locationd persists asynchronously. Confirm the requested value before ACK.
  const expected =
    action === "reset" ? 0 : action === "revoke" ? 1 : service === "location-always" ? 4 : 2;
  const deadline = Date.now() + 5000;
  while ((readLocation(udid, bundleId)?.Authorization ?? 0) !== expected) {
    if (Date.now() >= deadline)
      throw new Error("locationd did not confirm the requested state (is the app installed?)");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

// ─── Dispatch ───

function applyOne(
  udid: string,
  verb: Exclude<Verb, "list">,
  permission: string,
  value: string | undefined,
  bundleId: string,
): void {
  const spec = resolvePermission(permission)!;
  if (spec.kind === "tcc") {
    nativePermission(udid, "tcc", verb, bundleId, value ?? "", spec.tccService!);
  } else if (spec.kind === "notifications") {
    nativePermission(udid, "notifications", verb, bundleId, value ?? "");
  } else {
    setLocation(udid, bundleId, verb, value);
  }
}

export function permissionStates(
  tcc: Record<string, number>,
  location: { Authorization: number } | null,
  notifications: { allowsNotifications: boolean; authorizationStatus: number } | null,
) {
  const labels: Record<string, string> = {
    "photos-add": "Add to Photos",
    "media-library": "Media Library",
    "user-tracking": "App tracking",
    faceid: "Face ID",
    homekit: "HomeKit",
  };
  return allPermissionNames().map((id) => {
    let state: "granted" | "denied" | "limited" | "undetermined" = "undetermined";
    if (id === "notifications") {
      state =
        notifications?.authorizationStatus === 1
          ? "denied"
          : notifications?.authorizationStatus && notifications.allowsNotifications
            ? "granted"
            : "undetermined";
    } else if (id === "location") {
      state =
        location?.Authorization === 1
          ? "denied"
          : location && location.Authorization > 1
            ? "granted"
            : "undetermined";
    } else {
      const value = tcc[id];
      state =
        value === 0 ? "denied" : value === 2 ? "granted" : value === 3 ? "limited" : "undetermined";
    }
    return { id, label: labels[id] ?? id.charAt(0).toUpperCase() + id.slice(1), state };
  });
}

export async function permissions(args: string[]): Promise<void> {
  const quiet = args.includes("-q") || args.includes("--quiet");
  const rest = args.filter((a) => a !== "-q" && a !== "--quiet");
  const parsed = parsePermissionsArgs(rest);

  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(
      "\nUsage:\n" +
        "  serve-sim permissions grant  <permission> <bundle-id> [--value <v>] [-d <udid|name>]\n" +
        "  serve-sim permissions revoke <permission> <bundle-id> [-d <udid|name>]\n" +
        "  serve-sim permissions reset  <permission|all> <bundle-id> [-d <udid|name>]\n" +
        "  serve-sim permissions list   [bundle-id] [-d <udid|name>]\n" +
        `\nPermissions: ${allPermissionNames().join(", ")}`,
    );
    process.exit(1);
  }

  const udid = parsed.device ? resolveDevice(parsed.device) : findBootedDevice();
  if (!udid) {
    console.error("No booted simulator. Boot one or pass -d <udid|name>.");
    process.exit(1);
  }

  const bundleId = parsed.bundleId!;
  try {
    if (parsed.verb === "list") {
      const result = {
        udid,
        bundleId: parsed.bundleId ?? null,
        tcc: readTcc(udid, parsed.bundleId),
        location: parsed.bundleId ? readLocation(udid, parsed.bundleId) : null,
        notifications: parsed.bundleId
          ? nativePermission<{ allowsNotifications: boolean; authorizationStatus: number } | null>(
              udid,
              "notifications",
              "get",
              parsed.bundleId,
            )
          : null,
      };
      console.log(
        JSON.stringify(
          {
            ...result,
            ...(parsed.bundleId
              ? { permissions: permissionStates(result.tcc, result.location, result.notifications) }
              : {}),
          },
          null,
          quiet ? 0 : 2,
        ),
      );
      return;
    }

    if (parsed.permission === "all") {
      for (const name of allPermissionNames()) {
        applyOne(udid, "reset", name, undefined, bundleId);
      }
    } else {
      applyOne(udid, parsed.verb, parsed.permission!, parsed.value, bundleId);
    }
  } catch (e: any) {
    console.error(e?.message ?? String(e));
    process.exit(1);
  }

  if (quiet) {
    console.log(
      JSON.stringify({
        udid,
        verb: parsed.verb,
        permission: parsed.permission,
        value: parsed.value ?? null,
        bundleId,
      }),
    );
  } else {
    const valueStr = parsed.value ? ` (${parsed.value})` : "";
    console.log(`🔐 ${parsed.verb} ${parsed.permission}${valueStr} for ${bundleId} on ${udid}`);
  }
}
