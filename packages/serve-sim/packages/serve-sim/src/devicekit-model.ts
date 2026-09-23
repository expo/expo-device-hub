import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import { homedir } from "os";
import { dirname, join } from "path";

const MODEL_RESOURCE = "SharedFrameworks/DeviceKit.framework/Versions/A/PlugIns/CoreDevicePopDeviceKitExtension.devicekitplugin/Contents/Resources/V68.usdz";
type XcodeLocations = { developerDir?: string; applicationsDirs?: string[] };

function selectedDeveloperDir(): string {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;
  try { return execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
}

/** Like 2D DeviceKit chrome, Apple's model remains in the host's installation. */
export function resolveDeviceKitModel({
  developerDir = selectedDeveloperDir(),
  applicationsDirs = ["/Applications", join(homedir(), "Applications")],
}: XcodeLocations = {}): string | null {
  const contents = developerDir.endsWith(".app") ? join(developerDir, "Contents") : dirname(developerDir);
  const selected = join(contents, MODEL_RESOURCE);
  if (developerDir && existsSync(selected)) return selected;
  // The selected Xcode may predate Duo while a newer beta supplies its assets.
  for (const directory of applicationsDirs) {
    let apps: string[];
    try { apps = readdirSync(directory).filter((name) => name.endsWith(".app")); }
    catch { continue; }
    apps.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const app of apps) {
      const path = join(directory, app, "Contents", MODEL_RESOURCE);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

let cached: { key: string; bytes: Buffer; etag: string } | undefined;

export function serveDeviceKitModelAsset(req: IncomingMessage, res: ServerResponse, locations?: XcodeLocations): void {
  // This route always serves V68; requests cannot select filesystem paths.
  const path = resolveDeviceKitModel(locations);
  if (!path) {
    res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "iPhone Duo 3D model not found in an installed Xcode." }));
    return;
  }
  try {
    const stat = statSync(path);
    const key = `${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (cached?.key !== key) {
      const bytes = readFileSync(path);
      cached = { key, bytes, etag: `"${createHash("sha256").update(bytes).digest("base64url")}"` };
    }
    const headers = { "Content-Type": "model/vnd.usdz+zip", "Cache-Control": "private, no-cache", ETag: cached.etag };
    if (req.headers["if-none-match"] === cached.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "Content-Length": String(cached.bytes.byteLength) });
    res.end(cached.bytes);
  } catch {
    res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Unable to read the iPhone Duo model from Xcode." }));
  }
}
