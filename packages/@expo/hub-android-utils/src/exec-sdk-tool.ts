import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecSdkToolOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Run an SDK command-line tool and resolve with its output.
 *
 * On Windows `avdmanager` and `sdkmanager` are `.bat` wrappers, which Node
 * refuses to spawn directly (`spawn EINVAL` since 18.20 / 20.12). Those run
 * through `cmd.exe` as one pre-quoted command line; native binaries such as
 * `adb` spawn as-is. `timeout` and `signal` apply either way.
 */
export function execSdkTool(
  toolPath: string,
  args: string[],
  options: ExecSdkToolOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!isBatchFile(toolPath)) return execFileAsync(toolPath, args, options);
  return execFileAsync(buildBatchCommand(toolPath, args), [], { ...options, shell: true });
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
 * would otherwise be split.
 */
export function buildBatchCommand(toolPath: string, args: string[]): string {
  return [toolPath, ...args].map(quoteBatchArg).join(" ");
}

function quoteBatchArg(arg: string): string {
  if (/^[\w./:\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
