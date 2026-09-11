import { spawn } from "node:child_process";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { execBuffer, execText } from "./exec.ts";
import type { AppIcon, AppIconMimeType } from "./shared/api-contracts.ts";

const PULL_TIMEOUT_MS = 60_000;
const PM_PATH_TIMEOUT_MS = 10_000;
const AAPT2_TIMEOUT_MS = 20_000;
const RESOURCE_STREAM_TIMEOUT_MS = 60_000;
const UNZIP_TIMEOUT_MS = 20_000;
const MAX_ICON_BYTES = 4 * 1024 * 1024;

const DENSITY_BY_QUALIFIER: Record<string, number> = {
  ldpi: 120,
  mdpi: 160,
  tvdpi: 213,
  hdpi: 240,
  xhdpi: 320,
  xxhdpi: 480,
  xxxhdpi: 640,
};

/** The densest real screen bucket; `aapt2` also emits 65534/65535 sentinels. */
const MAX_REAL_DENSITY = 640;

/** `<item>` and `<inset>` carry `drawable`; a bare `<bitmap>` carries `src`. */
const FOREGROUND_DRAWABLE = /(?:drawable\(0x01010199\)|src\(0x01010119\))=@(0x[0-9a-f]+)/;

/**
 * Resource ids in the `0x01` package belong to the framework, so the APK's own
 * table cannot resolve them. Clock's foreground layers one over its own bitmap.
 */
const FRAMEWORK_RESOURCE_PREFIX = "0x01";

const MIME_SIGNATURES: readonly {
  mimeType: AppIconMimeType;
  prefix: readonly number[];
  at8?: readonly number[];
}[] = [
  { mimeType: "image/png", prefix: [0x89, 0x50, 0x4e, 0x47] },
  {
    mimeType: "image/webp",
    prefix: [0x52, 0x49, 0x46, 0x46],
    at8: [0x57, 0x45, 0x42, 0x50],
  },
  { mimeType: "image/jpeg", prefix: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", prefix: [0x47, 0x49, 0x46, 0x38] },
];

export function selectBaseApkPath(pmPathOutput: string): string | null {
  const paths = pmPathOutput
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^package:/, "")
        .trim(),
    )
    .filter((line) => line.endsWith(".apk"));
  return paths.find((path) => path.endsWith("/base.apk")) ?? paths[0] ?? null;
}

export function selectIconEntry(badging: string): string | null {
  let best: { density: number; entry: string } | null = null;
  let anyEntry: string | null = null;
  for (const line of badging.split("\n")) {
    const icon = /^application-icon-(\d+):'(.*)'$/.exec(line.trim());
    if (icon) {
      const density = Number(icon[1]);
      const entry = icon[2]!;
      anyEntry ??= entry;
      if (density <= MAX_REAL_DENSITY && (!best || density > best.density)) {
        best = { density, entry };
      }
      continue;
    }
    if (!best && !anyEntry) {
      const fallback = /^application:.*\bicon='([^']*)'/.exec(line.trim());
      if (fallback?.[1]) anyEntry = fallback[1];
    }
  }
  return best?.entry ?? anyEntry;
}

export function parseAdaptiveForegroundId(xmltree: string): string | null {
  let foregroundIndent = -1;
  for (const line of xmltree.split("\n")) {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();
    if (foregroundIndent < 0) {
      if (/^E: foreground\b/.test(trimmed)) foregroundIndent = indent;
      continue;
    }
    if (indent <= foregroundIndent) return null;
    const id = FOREGROUND_DRAWABLE.exec(trimmed)?.[1];
    if (id && !id.startsWith(FRAMEWORK_RESOURCE_PREFIX)) return id;
  }
  return null;
}

export function selectResourceFilePath(block: string): string | null {
  let best: { density: number; path: string } | null = null;
  let defaultConfig: string | null = null;
  for (const line of block.split("\n")) {
    const match = /^\((.*?)\)\s+\(file\)\s+(\S+)(?:\s+type=(\S+))?/.exec(line.trim());
    if (!match) continue;
    const [, qualifier = "", path = "", type] = match;
    if (type === "XML" || path.endsWith(".xml")) continue;
    const density = DENSITY_BY_QUALIFIER[qualifier];
    if (density === undefined) {
      if (qualifier === "") defaultConfig ??= path;
      continue;
    }
    if (!best || density > best.density) best = { density, path };
  }
  return best?.path ?? defaultConfig;
}

export function iconMimeType(bytes: Uint8Array): AppIconMimeType | null {
  const matches = (offset: number, signature: readonly number[]) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  for (const { mimeType, prefix, at8 } of MIME_SIGNATURES) {
    if (matches(0, prefix) && (!at8 || matches(8, at8))) return mimeType;
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number(part) || 0);
  const right = b.split(".").map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

let aapt2Path: Promise<string> | null = null;

async function findAapt2(): Promise<string> {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (root): root is string => !!root,
  );
  for (const root of roots) {
    const buildTools = join(root, "build-tools");
    const versions = (await readdir(buildTools).catch(() => [])).sort(compareVersions);
    for (const version of versions.reverse()) {
      const candidate = join(buildTools, version, "aapt2");
      if (await access(candidate).then(() => true, () => false)) return candidate;
    }
  }
  const probe = await execText("aapt2", ["version"], {
    timeout: AAPT2_TIMEOUT_MS,
    lane: "background",
  });
  if (probe.status === 0) return "aapt2";
  throw new Error("aapt2 not found; install Android SDK build-tools");
}

function resolveAapt2(): Promise<string> {
  aapt2Path ??= findAapt2().catch((error) => {
    aapt2Path = null;
    throw error;
  });
  return aapt2Path;
}

/**
 * `aapt2 dump resources` prints 60 MB for `com.android.settings`, against the
 * executor's 8 MB output budget, so stream it and stop at the end of one block.
 */
async function readResourceBlock(apkPath: string, resourceId: string): Promise<string | null> {
  const aapt2 = await resolveAapt2();
  return new Promise((resolve, reject) => {
    const child = spawn(aapt2, ["dump", "resources", apkPath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("aapt2 dump resources timed out"));
    }, RESOURCE_STREAM_TIMEOUT_MS);
    const collected: string[] = [];
    let indent = -1;

    const finish = (value: string | null) => {
      clearTimeout(timer);
      lines.close();
      child.kill("SIGKILL");
      resolve(value);
    };

    lines.on("line", (line) => {
      const lineIndent = line.length - line.trimStart().length;
      if (indent < 0) {
        if (line.trimStart().startsWith(`resource ${resourceId} `)) indent = lineIndent;
        return;
      }
      if (lineIndent <= indent) {
        finish(collected.join("\n"));
        return;
      }
      collected.push(line);
    });
    lines.on("close", () => finish(indent < 0 ? null : collected.join("\n")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`aapt2 dump resources failed: ${error.message}`, { cause: error }));
    });
  });
}

/** The executor reports queue and deadline failures through `error`, not stderr. */
function execDetail(stderr: string, result: { error: Error | null }): string {
  return stderr.trim() || result.error?.message || "no output";
}

async function adbText(serial: string, args: string[], timeout: number): Promise<string> {
  const result = await execText("adb", ["-s", serial, ...args], {
    timeout,
    lane: "background",
  });
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${execDetail(result.stderr, result)}`);
  }
  return result.stdout;
}

async function aapt2Text(args: string[]): Promise<string> {
  const aapt2 = await resolveAapt2();
  const result = await execText(aapt2, args, {
    timeout: AAPT2_TIMEOUT_MS,
    lane: "background",
  });
  if (result.status !== 0) {
    throw new Error(`aapt2 ${args[0]} failed: ${execDetail(result.stderr, result)}`);
  }
  return result.stdout;
}

async function extractIcon(apkPath: string, entry: string): Promise<AppIcon | null> {
  const unzipped = await execBuffer("unzip", ["-p", apkPath, entry], {
    timeout: UNZIP_TIMEOUT_MS,
    maxBuffer: MAX_ICON_BYTES,
    lane: "background",
  });
  if (unzipped.status !== 0) {
    throw new Error(`unzip ${entry} failed: ${execDetail(unzipped.stderr, unzipped)}`);
  }
  const mimeType = iconMimeType(unzipped.stdout);
  return mimeType ? { mimeType, data: unzipped.stdout.toString("base64") } : null;
}

async function pullAndExtract(serial: string, baseApkPath: string): Promise<AppIcon | null> {
  const workDir = await mkdtemp(join(tmpdir(), "serve-emu-icon-"));
  try {
    const apkPath = join(workDir, "base.apk");
    await adbText(serial, ["pull", baseApkPath, apkPath], PULL_TIMEOUT_MS);

    const badgingEntry = selectIconEntry(await aapt2Text(["dump", "badging", apkPath]));
    if (!badgingEntry) return null;
    if (!badgingEntry.endsWith(".xml")) return await extractIcon(apkPath, badgingEntry);

    const foregroundId = parseAdaptiveForegroundId(
      await aapt2Text(["dump", "xmltree", apkPath, "--file", badgingEntry]),
    );
    if (!foregroundId) return null;
    const block = await readResourceBlock(apkPath, foregroundId);
    if (!block) return null;
    const bitmapEntry = selectResourceFilePath(block);
    return bitmapEntry ? await extractIcon(apkPath, bitmapEntry) : null;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * One extraction at a time. Each holds a full APK copy on disk, and the
 * streamed `aapt2` dump runs outside the adb executor's four slots.
 */
let extractions: Promise<unknown> = Promise.resolve();

function queueExtraction(serial: string, baseApkPath: string): Promise<AppIcon | null> {
  const next = extractions.then(
    () => pullAndExtract(serial, baseApkPath),
    () => pullAndExtract(serial, baseApkPath),
  );
  extractions = next.catch(() => {});
  return next;
}

const iconCache = new Map<string, Promise<AppIcon | null>>();

export async function readAppIcon(serial: string, packageName: string): Promise<AppIcon | null> {
  const baseApkPath = selectBaseApkPath(
    await adbText(serial, ["shell", "pm", "path", packageName], PM_PATH_TIMEOUT_MS),
  );
  if (!baseApkPath) throw new Error(`${packageName} is not installed`);

  const key = `${serial}:${packageName}:${baseApkPath}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const pending = queueExtraction(serial, baseApkPath).catch((error: unknown) => {
    iconCache.delete(key);
    throw error;
  });
  iconCache.set(key, pending);
  return pending;
}
