import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run an SDK command-line tool and resolve with its output.
 *
 * On Windows `avdmanager` and `sdkmanager` are `.bat` wrappers, which Node
 * refuses to spawn directly (`spawn EINVAL` since 18.20 / 20.12). Those run
 * through `cmd.exe` as one pre-quoted command line; native binaries such as
 * `adb` spawn as-is.
 */
export async function execSdkTool(
  toolPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!isBatchFile(toolPath)) return execFileAsync(toolPath, args);
  return execFileAsync(buildBatchCommand(toolPath, args), [], { shell: true });
}

/** Whether `toolPath` is a Windows batch wrapper rather than a native binary. */
export function isBatchFile(toolPath: string): boolean {
  return /\.(bat|cmd)$/i.test(toolPath);
}

/**
 * Join a `.bat` path and its arguments into a single `cmd.exe` command line.
 *
 * Anything beyond path-safe characters is double-quoted so `cmd.exe` passes it
 * through whole: the `;` in system image packages and spaces in `Program Files`
 * would otherwise be split. Quotes don't stop `cmd.exe` (or the SDK wrappers,
 * which re-expand their arguments with delayed expansion on) from acting on
 * `%`, `!`, `^`, `"` and line breaks, and no package, device profile or AVD
 * name contains them, so arguments with those are rejected instead of escaped.
 */
export function buildBatchCommand(toolPath: string, args: string[]): string {
  for (const arg of args) {
    if (/[%!^"\r\n]/.test(arg)) {
      throw new Error(`[android-utils] Refusing to pass ${JSON.stringify(arg)} to cmd.exe.`);
    }
  }
  return [toolPath, ...args].map(quoteBatchArg).join(" ");
}

function quoteBatchArg(arg: string): string {
  if (/^[\w./:\\-]+$/.test(arg)) return arg;
  return `"${arg}"`;
}
