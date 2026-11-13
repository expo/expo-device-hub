import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { type AndroidUtilsResult, reportError, result } from "./errors";
import { resolveAdbPath } from "./sdk-paths";

const execFileAsync = promisify(execFile);

/** The OpenGL ES renderer that a running emulator draws its frames with. */
export interface EmulatorRenderer {
  /** The `GL_RENDERER` string that SurfaceFlinger reports, unchanged. */
  renderer: string;
  /** A short name: the software renderer, or what the emulator's translator names. */
  name: string;
  /** Whether a software renderer draws the frames on the host's CPU. */
  software: boolean;
}

/** Software renderers that an emulator can pick, directly or under ANGLE. */
const SOFTWARE_RENDERERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bswiftshader\b/i, "SwiftShader"],
  [/\blavapipe\b/i, "lavapipe"],
  [/\bllvmpipe\b/i, "llvmpipe"],
];

/** Split on the commas outside parentheses: renderer strings nest their own commas. */
function splitTopLevel(value: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      fields.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  fields.push(value.slice(start).trim());
  return fields;
}

/**
 * Parse the `GLES: <vendor>, <renderer>, <version>` line of
 * `dumpsys SurfaceFlinger`. Returns `null` when the line is missing or has no
 * renderer.
 */
export function parseEmulatorRenderer(dump: string): EmulatorRenderer | null {
  const line = /^[\t ]*GLES:[\t ]*([^\r\n]*)/m.exec(dump)?.[1];
  if (!line) return null;
  const renderer = splitTopLevel(line)[1];
  if (!renderer) return null;
  const software = SOFTWARE_RENDERERS.find(([pattern]) => pattern.test(renderer))?.[1];
  const translated = /^Android Emulator OpenGL ES Translator \((.*)\)$/.exec(renderer)?.[1];
  return { renderer, name: software ?? translated ?? renderer, software: software !== undefined };
}

/**
 * Read the renderer of a running emulator with `adb shell dumpsys SurfaceFlinger`.
 *
 * The emulator's own output cannot tell whether `-gpu host` would work, so this
 * reads what the guest actually renders with. Bounded by `timeoutMs`; a command
 * failure, a timeout, or a cancellation returns `null` with the failure in
 * `error`, and output without a renderer returns `null`. Never throws.
 */
export async function readEmulatorRenderer(
  serial: string,
  {
    timeoutMs = 3_000,
    signal,
    adbPath,
  }: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Override SDK resolution, e.g. for a custom adb installation. */
    adbPath?: string;
  } = {},
): Promise<AndroidUtilsResult<EmulatorRenderer | null>> {
  try {
    const { stdout } = await execFileAsync(
      adbPath ?? resolveAdbPath(process.env, homedir()),
      ["-s", serial, "shell", "dumpsys", "SurfaceFlinger"],
      { timeout: timeoutMs, signal, maxBuffer: 4 * 1024 * 1024 },
    );
    return result(parseEmulatorRenderer(stdout));
  } catch (error) {
    return result(
      null,
      reportError(`[android-utils] Failed to read the renderer of ${serial}:`, error),
    );
  }
}
