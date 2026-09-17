import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveAdbPath } from "./sdk-paths";

const execFileAsync = promisify(execFile);

export interface AndroidGpuInfo {
  /** Short renderer/device name, not an inferred emulator launch mode. */
  name: string;
  /** Unmodified GL_RENDERER value reported by SurfaceFlinger. */
  renderer: string;
  /** Software rendering and translation API, when explicitly identified. */
  description: string | null;
}

/** Renderer strings contain nested comma-separated ANGLE/device descriptions. */
function splitFields(value: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (value[i] === "," && depth === 0) {
      fields.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  fields.push(value.slice(start).trim());
  return fields;
}

/** Parse the GLES vendor/renderer/version line, preserving unfamiliar renderers. */
export function parseGpuInfo(dump: string): AndroidGpuInfo | null {
  const line = /^[\t ]*GLES:[\t ]*([^\r\n]*)/m.exec(dump)?.[1];
  if (!line) return null;
  const fields = splitFields(line);
  if (fields.length !== 3 || !fields[1]) return null;
  const renderer = fields[1];
  const translated = /^Android Emulator OpenGL ES Translator \((.*)\)$/.exec(renderer)?.[1];
  const reported = translated ?? renderer;
  const software = /\bswiftshader\b/i.test(reported)
    ? "SwiftShader"
    : /\blavapipe\b/i.test(reported)
      ? "Lavapipe"
      : /\bllvmpipe\b/i.test(reported)
        ? "LLVMpipe"
        : null;
  const angle = /\bANGLE\b/.test(reported);
  const api = angle ? /\b(Metal|Vulkan|Direct3D11|Direct3D9|OpenGL)\b/.exec(reported)?.[1] : null;
  const angleBody = /^ANGLE \((.*)\)$/.exec(reported)?.[1];
  const angleFields = angleBody ? splitFields(angleBody) : [];
  const device = angleFields.length >= 2 ? angleFields[1] : null;
  const metalDevice = /ANGLE Metal Renderer:\s*(.*)/.exec(device ?? angleBody ?? reported)?.[1];
  const vulkanDevice = device && /^Vulkan [\d.]+ \((.*)\)$/.exec(device)?.[1];
  const name =
    software ??
    metalDevice ??
    (vulkanDevice
      ? vulkanDevice.replace(/\s*\(0x[\da-f]+\)$/i, "")
      : device?.replace(/\s+Direct3D(?:11|9)\b.*$/, "")) ??
    reported;
  const description =
    [
      software ? "Software" : null,
      angle
        ? api
          ? `ANGLE / ${api.replace("Direct3D", "Direct3D ")}`
          : "ANGLE"
        : translated
          ? "Emulator OpenGL ES translator"
          : null,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  return { name, renderer, description };
}

/**
 * Read the active GLES renderer with `adb shell dumpsys SurfaceFlinger`.
 * No configuration or launch-flag fallbacks. Missing output, command failures,
 * timeout, and cancellation return null; command failures also populate error.
 */
export async function readGpuInfo(
  serial: string,
  {
    timeoutMs = 3000,
    signal,
    adbPath,
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Override SDK resolution, e.g. for a custom adb installation. */
    adbPath?: string;
  } = {},
): Promise<AndroidUtilsResult<AndroidGpuInfo | null>> {
  try {
    const { stdout } = await execFileAsync(
      adbPath ?? resolveAdbPath(process.env, homedir()),
      ["-s", serial, "shell", "dumpsys", "SurfaceFlinger"],
      { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 },
    );
    return result(parseGpuInfo(stdout));
  } catch (error) {
    return result(
      null,
      reportError(`[android-utils] Failed to read GPU renderer for ${serial}:`, error),
    );
  }
}
