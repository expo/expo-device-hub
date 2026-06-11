import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AppActionResult = {
  ok: true;
  output: string;
};

export type FileImportResult = AppActionResult & {
  path: string;
  kind: "image" | "video" | "file";
};

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PERMISSION_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ACTIVITY_RE = /^([A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+|\.?[A-Za-z][A-Za-z0-9_.$]*)(\/[A-Za-z0-9_.$]+)?$/;

function output(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.trim();
}

function adb(serial: string, args: string[], timeout = 30_000): AppActionResult {
  const result = spawnSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout,
  });
  const text = output(result.stdout, result.stderr);
  if (result.status !== 0) {
    throw new Error(text || `adb ${args.join(" ")} failed`);
  }
  return { ok: true, output: text };
}

function adbHost(serial: string, args: string[], timeout = 30_000): AppActionResult {
  return adb(serial, args, timeout);
}

function validate(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value.trim())) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

export function packageName(value: unknown): string {
  return validate(value, "packageName", PACKAGE_RE);
}

export function activityName(value: unknown): string {
  return validate(value, "activity", ACTIVITY_RE);
}

export function permissionName(value: unknown): string {
  return validate(value, "permission", PERMISSION_RE);
}

export async function installApk(serial: string, file: File): Promise<AppActionResult> {
  if (!file.name.toLowerCase().endsWith(".apk")) throw new Error("APK file must end with .apk");
  const dir = mkdtempSync(join(tmpdir(), "serve-emu-apk-"));
  const path = join(dir, "upload.apk");
  try {
    writeFileSync(path, new Uint8Array(await file.arrayBuffer()));
    return adb(serial, ["install", "-r", path], 120_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function safeFileName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || `upload-${Date.now()}`;
}

function mediaKind(file: File): FileImportResult["kind"] {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  const lower = file.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|heif)$/.test(lower)) return "image";
  if (/\.(mp4|m4v|mov|webm|3gp|mkv)$/.test(lower)) return "video";
  return "file";
}

export async function importMediaFile(serial: string, file: File): Promise<FileImportResult> {
  const dir = mkdtempSync(join(tmpdir(), "serve-emu-media-"));
  const localPath = join(dir, safeFileName(file.name));
  const kind = mediaKind(file);
  const remoteDir =
    kind === "image" ? "/sdcard/Pictures" : kind === "video" ? "/sdcard/Movies" : "/sdcard/Download";
  const remotePath = `${remoteDir}/${safeFileName(file.name)}`;
  try {
    writeFileSync(localPath, new Uint8Array(await file.arrayBuffer()));
    adb(serial, ["shell", "mkdir", "-p", remoteDir]);
    adbHost(serial, ["push", localPath, remotePath], 120_000);
    adb(serial, [
      "shell",
      "am",
      "broadcast",
      "-a",
      "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
      "-d",
      `file://${remotePath}`,
    ]);
    return { ok: true, output: `Imported ${file.name} to ${remotePath}`, path: remotePath, kind };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function launchApp(serial: string, packageNameValue: string, activity?: string): AppActionResult {
  const pkg = packageName(packageNameValue);
  if (activity) {
    const act = activityName(activity);
    const component = act.includes("/") ? act : `${pkg}/${act}`;
    return adb(serial, ["shell", "am", "start", "-n", component]);
  }
  return adb(serial, [
    "shell",
    "monkey",
    "-p",
    pkg,
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ]);
}

export function clearAppData(serial: string, packageNameValue: string): AppActionResult {
  return adb(serial, ["shell", "pm", "clear", packageName(packageNameValue)]);
}

export function forceStopApp(serial: string, packageNameValue: string): AppActionResult {
  return adb(serial, ["shell", "am", "force-stop", packageName(packageNameValue)]);
}

export function grantPermission(
  serial: string,
  packageNameValue: string,
  permissionValue: string,
): AppActionResult {
  return adb(serial, [
    "shell",
    "pm",
    "grant",
    packageName(packageNameValue),
    permissionName(permissionValue),
  ]);
}
