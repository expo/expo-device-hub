import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";
import { asString, isRecord, safeJsonParse } from "./json";
import { type ScreenCornerRadii } from "./types";

const execFileAsync = promisify(execFile);

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const DEVICE_TYPE_ID_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";
const BUNDLE_SUFFIX = ".simdevicetype";

/** What scanning every bundle's Info.plist found: names by device type identifier. */
interface BundleScan {
  names: Map<string, string>;
  /** Bundles whose Info.plist could not be read. Their identifiers are unknown, not missing. */
  failures: unknown[];
}

/** One scan per root, kept only while it is complete. A scan with failures is rerun next time. */
const scansByRoot = new Map<string, Promise<BundleScan>>();

/**
 * Parse the primary display's corner radii from a DeviceKit `capabilities.plist`
 * payload (converted to JSON). Apple stores radii in points and the display size
 * in pixels, so each radius is divided by `width / scale` to give a fraction of
 * the portrait screen width. Returns `null` when no usable integrated display exists.
 *
 * It uses the first integrated display. Some models have more than one: iPhone Duo's
 * folded screen (screen ID 1) and unfolded screen (screen ID 3) have different radii.
 * Hub does not know which screen a session streams, so an unfolded Duo shows the
 * folded screen's radii. serve-sim picks the variant by screen ID.
 */
export function parseCornerRadii(capabilities: unknown): ScreenCornerRadii | null {
  const displays = isRecord(capabilities) ? capabilities.capabilities : null;
  const list = isRecord(displays) ? displays.displays : null;
  if (!Array.isArray(list)) return null;

  for (const entry of list) {
    if (!isRecord(entry) || entry.displayType !== "integrated") continue;
    const { width, scale, cornerRadiusUL, cornerRadiusUR, cornerRadiusLR, cornerRadiusLL } = entry;
    if (typeof width !== "number" || typeof scale !== "number") continue;
    const widthPoints = width / scale;
    if (!Number.isFinite(widthPoints) || widthPoints <= 0) continue;

    const radii = [cornerRadiusUL, cornerRadiusUR, cornerRadiusLR, cornerRadiusLL];
    if (!radii.every((radius) => typeof radius === "number" && radius >= 0)) continue;
    const fraction = (radius: unknown) => (radius as number) / widthPoints;
    return {
      topLeft: fraction(cornerRadiusUL),
      topRight: fraction(cornerRadiusUR),
      bottomRight: fraction(cornerRadiusLR),
      bottomLeft: fraction(cornerRadiusLL),
    };
  }
  return null;
}

/**
 * Read a simulator model's physical screen corner radii from the DeviceKit
 * profile that ships with Xcode. Never throws.
 *
 * `value` is `null` with no `error` when the model has no profile (for example an
 * Apple Watch or an unknown identifier). It is `null` with an `error` when the
 * profile could not be read, which a caller may retry.
 */
export async function readCornerRadii(
  deviceTypeIdentifier: string | null,
  root: string = DEVICE_TYPES_ROOT,
): Promise<AppleUtilsResult<ScreenCornerRadii | null>> {
  if (!deviceTypeIdentifier) return result(null);

  try {
    const bundle = await bundleNameForIdentifier(root, deviceTypeIdentifier);
    if (!bundle) return result(null);

    const capabilitiesPath = join(
      root,
      `${bundle}${BUNDLE_SUFFIX}`,
      "Contents",
      "Resources",
      "capabilities.plist",
    );
    if (!(await fileExists(capabilitiesPath))) return result(null);

    return result(parseCornerRadii(await readPlistAsJson(capabilitiesPath)));
  } catch (error) {
    return result(
      null,
      reportError(`[apple-utils] Failed to read corner radii for ${deviceTypeIdentifier}:`, error),
    );
  }
}

async function bundleNameForIdentifier(root: string, identifier: string): Promise<string | null> {
  // Most bundles are named after the identifier ("iPhone-17-Pro" → "iPhone 17 Pro"),
  // so check that one first instead of reading every Info.plist.
  const guess = identifier.startsWith(DEVICE_TYPE_ID_PREFIX)
    ? identifier.slice(DEVICE_TYPE_ID_PREFIX.length).replaceAll("-", " ")
    : null;
  if (guess && (await bundleIdentifier(root, guess)) === identifier) return guess;

  let scan = scansByRoot.get(root);
  if (!scan) {
    const started = scanBundleNames(root);
    scan = started;
    scansByRoot.set(root, started);
    const forget = () => {
      if (scansByRoot.get(root) === started) scansByRoot.delete(root);
    };
    started.then(({ failures }) => failures.length > 0 && forget(), forget);
  }

  const { names, failures } = await scan;
  const name = names.get(identifier);
  if (name) return name;
  // An unreadable Info.plist might have been this model's, so it is not proven missing.
  if (failures.length > 0) throw failures[0];
  return null;
}

async function scanBundleNames(root: string): Promise<BundleScan> {
  const scan: BundleScan = { names: new Map(), failures: [] };
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    // No Profiles folder at all means no DeviceKit profiles. Anything else may pass.
    if (isMissing(error)) return scan;
    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(BUNDLE_SUFFIX))
      .map(async (entry) => {
        const name = entry.slice(0, -BUNDLE_SUFFIX.length);
        try {
          const identifier = await bundleIdentifier(root, name);
          if (identifier) scan.names.set(identifier, name);
        } catch (error) {
          scan.failures.push(error);
        }
      }),
  );
  return scan;
}

/** The bundle's identifier, `null` when it has no Info.plist. Throws when the plist cannot be read. */
async function bundleIdentifier(root: string, name: string): Promise<string | null> {
  const path = join(root, `${name}${BUNDLE_SUFFIX}`, "Contents", "Info.plist");
  if (!(await fileExists(path))) return null;

  const info = await readPlistAsJson(path);
  return isRecord(info) ? (asString(info.CFBundleIdentifier) ?? null) : null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** DeviceKit plists are binary, which `@expo/plist` cannot read, so convert with `plutil`. */
async function readPlistAsJson(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", path], {
    timeout: 5_000,
  });
  const parsed = safeJsonParse(stdout);
  if (parsed.error) throw parsed.error.error;
  return parsed.value;
}
