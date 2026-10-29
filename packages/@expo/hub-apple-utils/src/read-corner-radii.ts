import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AppleUtilsResult, reportError, result } from "./errors";
import { asString, isRecord, safeJsonParse } from "./json";
import { type ScreenCornerRadii } from "./types";

const execFileAsync = promisify(execFile);

const DEVICE_TYPES_ROOT = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes";
const DEVICE_TYPE_ID_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";
const BUNDLE_SUFFIX = ".simdevicetype";

/** Bundle directory names by device type identifier, built once per root by scanning Info.plist. */
const bundleNamesByRoot = new Map<string, Promise<Map<string, string>>>();

/**
 * Parse the primary display's corner radii from a DeviceKit `capabilities.plist`
 * payload (converted to JSON). Apple stores radii in points and the display size
 * in pixels, so each radius is divided by `width / scale` to give a fraction of
 * the portrait screen width. Returns `null` when no usable integrated display exists.
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
 * profile that ships with Xcode. Never throws; `value` is `null` when the model
 * has no profile (for example an Apple Watch or an unknown identifier).
 */
export async function readCornerRadii(
  deviceTypeIdentifier: string | null,
  root: string = DEVICE_TYPES_ROOT,
): Promise<AppleUtilsResult<ScreenCornerRadii | null>> {
  if (!deviceTypeIdentifier) return result(null);

  try {
    const bundle = await bundleNameForIdentifier(root, deviceTypeIdentifier);
    if (!bundle) return result(null);

    const capabilities = await readPlistAsJson(
      join(root, `${bundle}${BUNDLE_SUFFIX}`, "Contents", "Resources", "capabilities.plist"),
    );
    return result(parseCornerRadii(capabilities));
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

  let names = bundleNamesByRoot.get(root);
  if (!names) {
    names = scanBundleNames(root);
    bundleNamesByRoot.set(root, names);
  }
  return (await names).get(identifier) ?? null;
}

async function scanBundleNames(root: string): Promise<Map<string, string>> {
  const byIdentifier = new Map<string, string>();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return byIdentifier;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(BUNDLE_SUFFIX))
      .map(async (entry) => {
        const name = entry.slice(0, -BUNDLE_SUFFIX.length);
        const identifier = await bundleIdentifier(root, name);
        if (identifier) byIdentifier.set(identifier, name);
      }),
  );
  return byIdentifier;
}

async function bundleIdentifier(root: string, name: string): Promise<string | null> {
  const info = await readPlistAsJson(
    join(root, `${name}${BUNDLE_SUFFIX}`, "Contents", "Info.plist"),
  ).catch(() => null);
  return isRecord(info) ? (asString(info.CFBundleIdentifier) ?? null) : null;
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
