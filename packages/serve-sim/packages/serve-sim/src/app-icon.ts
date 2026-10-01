import { execFile } from "child_process";
import { readFile, stat } from "fs/promises";
import type { IncomingMessage, ServerResponse } from "http";
import { join } from "path";

// `GET /api/apps/icon?bundleId=<id>`: the installed app's icon in one plain request, so a remote
// client behind a tunnel needs neither the exec-ws socket nor its Origin check. The response
// mirrors serve-emu's `/api/apps/icon`, so one parser reads both platforms.

export type AppIcon = { mimeType: "image/png"; data: string };

export interface AppIconDeps {
  /** The installed `.app` directory, or null when the app is not installed. */
  appContainer: (udid: string, bundleId: string) => Promise<string | null>;
  readInfoPlist: (path: string) => Promise<unknown>;
  /** The file's bytes, or null when it is missing, not a file, or too large for an icon. */
  readIconFile: (path: string) => Promise<Buffer | null>;
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
// The icon name comes from the app's own Info.plist, so it must not climb out of the bundle.
const ICON_NAME = /^(?!\.)[^/\\\n]{1,200}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_ICON_BYTES = 2 * 1024 * 1024;

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout));
  });
}

const defaultDeps: AppIconDeps = {
  appContainer: async (udid, bundleId) =>
    (await run("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"]))?.trim() || null,
  readInfoPlist: async (path) => {
    const json = await run("plutil", ["-convert", "json", "-o", "-", path]);
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  },
  readIconFile: async (path) => {
    try {
      const info = await stat(path);
      return info.isFile() && info.size <= MAX_ICON_BYTES ? await readFile(path) : null;
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
 * undefined when the app is not installed.
 */
export async function readAppIcon(
  udid: string,
  bundleId: string,
  deps: AppIconDeps = defaultDeps,
): Promise<AppIcon | null | undefined> {
  const appPath = await deps.appContainer(udid, bundleId);
  if (!appPath) return undefined;
  for (const candidate of appIconCandidates(await deps.readInfoPlist(join(appPath, "Info.plist")))) {
    const bytes = await deps.readIconFile(join(appPath, candidate));
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

/** `udid` is the selected serve-sim device, or null when the server has none. */
export async function handleAppIconRequest(
  req: IncomingMessage,
  res: ServerResponse,
  udid: string | null,
  rawUrl: string,
  deps: AppIconDeps = defaultDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "method not allowed" }, { Allow: "GET, HEAD" });
    return;
  }
  const bundleId = new URL(rawUrl, "http://127.0.0.1").searchParams.get("bundleId") ?? "";
  if (!BUNDLE_ID.test(bundleId)) {
    sendJson(res, 400, { ok: false, error: "bundleId must look like com.example.app" });
    return;
  }
  if (!udid) {
    sendJson(res, 404, { ok: false, error: "No serve-sim device" });
    return;
  }
  try {
    const icon = await readAppIcon(udid, bundleId, deps);
    if (icon === undefined) {
      sendJson(res, 404, { ok: false, error: `App ${bundleId} is not installed on the simulator` });
      return;
    }
    sendJson(res, 200, { ok: true, bundleId, icon });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
