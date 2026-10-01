import { readFile, realpath, stat } from "fs/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { join, sep } from "path";

import { type HostActionResult, runInvocation } from "./host-actions-utils";

// `GET /api/apps/icon?bundleId=<id>`: the installed app's icon in one plain request, so a remote
// client behind a tunnel needs neither the exec-ws socket nor its Origin check. The response
// mirrors serve-emu's `/api/apps/icon`, with `bundleId` in place of `packageName`.

export type AppIcon = { mimeType: "image/png"; data: string };

export interface AppIconDeps {
  /** The installed `.app` directory, or null when simctl confirms the app is not installed. */
  appContainer: (udid: string, bundleId: string) => Promise<string | null>;
  readInfoPlist: (path: string) => Promise<unknown>;
  /** The named file's bytes, or null when it is missing, too large, or resolves outside the bundle. */
  readIconFile: (appPath: string, name: string) => Promise<Buffer | null>;
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
// The icon name comes from the app's own Info.plist, so it must not climb out of the bundle.
const ICON_NAME = /^(?!\.)[^/\\\n]{1,200}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ICON_BYTES = 2 * 1024 * 1024;
// What `simctl get_app_container` prints for a bundle id the device does not have (ENOENT).
const NOT_INSTALLED = "domain=NSPOSIXErrorDomain, code=2";

/**
 * Map a `simctl get_app_container` result to the app path, or null for an app that is not
 * installed. Any other failure throws, so a busy simulator is never reported as a missing app.
 */
export function appContainerFromResult(result: HostActionResult): string | null {
  if (result.exitCode === 0) {
    const appPath = result.stdout.trim();
    if (appPath) return appPath;
    throw new Error("simctl returned no app path");
  }
  if (!result.timedOut && result.stderr.includes(NOT_INSTALLED)) return null;
  throw new Error(result.stderr.trim() || "simctl could not look up the app");
}

const defaultDeps: AppIconDeps = {
  appContainer: async (udid, bundleId) =>
    appContainerFromResult(
      await runInvocation({ file: "xcrun", args: ["simctl", "get_app_container", udid, bundleId, "app"] }),
    ),
  readInfoPlist: async (path) => {
    const result = await runInvocation({ file: "plutil", args: ["-convert", "json", "-o", "-", path] });
    try {
      return result.exitCode === 0 ? JSON.parse(result.stdout) : null;
    } catch {
      return null;
    }
  },
  readIconFile: async (appPath, name) => {
    try {
      // Resolve links first: an app can ship an icon that is a symlink to any file on the host.
      const [bundle, file] = await Promise.all([realpath(appPath), realpath(join(appPath, name))]);
      if (!file.startsWith(bundle + sep)) return null;
      const info = await stat(file);
      return info.isFile() && info.size <= MAX_ICON_BYTES ? await readFile(file) : null;
    } catch {
      return null;
    }
  },
};

/**
 * Loose PNG names to try, largest variant first. The same lookup as the preview client's
 * `fetchAppDetails` and hub-client's `fetchIosAppDetails`, so moving a caller here keeps its icon.
 */
export function appIconCandidates(info: unknown): string[] {
  const plist = (info ?? {}) as Record<string, any>;
  const primary = plist.CFBundleIcons?.CFBundlePrimaryIcon ?? plist["CFBundleIcons~ipad"]?.CFBundlePrimaryIcon;
  const iconFiles: unknown = primary?.CFBundleIconFiles ?? plist.CFBundleIconFiles;
  const name = Array.isArray(iconFiles) && iconFiles.length > 0
    ? iconFiles[iconFiles.length - 1]
    : plist.CFBundleIconFile;
  if (typeof name !== "string" || !ICON_NAME.test(name)) return [];
  return [`${name}@3x.png`, `${name}@2x.png`, `${name}.png`, `${name}60x60@3x.png`, `${name}60x60@2x.png`];
}

/**
 * The app's icon, null when it has no loose PNG (an icon compiled only into Assets.car), or
 * undefined when the app is not installed. Throws when simctl cannot answer.
 */
export async function readAppIcon(
  udid: string,
  bundleId: string,
  overrides: Partial<AppIconDeps> = {},
): Promise<AppIcon | null | undefined> {
  const deps = { ...defaultDeps, ...overrides };
  const appPath = await deps.appContainer(udid, bundleId);
  if (!appPath) return undefined;
  for (const candidate of appIconCandidates(await deps.readInfoPlist(join(appPath, "Info.plist")))) {
    const bytes = await deps.readIconFile(appPath, candidate);
    if (bytes && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { mimeType: "image/png", data: bytes.toString("base64") };
    }
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * `resolveUdid` selects the serve-sim device, or null when the server has none. It runs only for a
 * valid request, so a malformed one never reads device state.
 */
export async function handleAppIconRequest(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  resolveUdid: () => Promise<string | null>,
  deps: Partial<AppIconDeps> = {},
): Promise<void> {
  // GET only, like serve-emu: a HEAD answer through the Fetch adapter would keep the JSON body.
  if ((req.method ?? "GET").toUpperCase() !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" }, { Allow: "GET" });
    return;
  }
  const bundleId = new URL(rawUrl, "http://127.0.0.1").searchParams.get("bundleId") ?? "";
  if (!BUNDLE_ID.test(bundleId)) {
    sendJson(res, 400, { ok: false, error: "bundleId must look like com.example.app" });
    return;
  }
  const udid = await resolveUdid();
  if (!udid) {
    sendJson(res, 404, { ok: false, error: "No serve-sim device" });
    return;
  }
  let icon: AppIcon | null | undefined;
  try {
    icon = await readAppIcon(udid, bundleId, deps);
  } catch (err) {
    sendJson(res, 503, { ok: false, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (icon === undefined) {
    sendJson(res, 404, { ok: false, error: `App ${bundleId} is not installed on the simulator` });
    return;
  }
  sendJson(res, 200, { ok: true, bundleId, icon });
}
