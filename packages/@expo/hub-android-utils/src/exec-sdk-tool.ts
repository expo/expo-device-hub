import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run an SDK command-line tool and resolve with its output.
 *
 * On Windows `avdmanager` and `sdkmanager` are `.bat` wrappers, which Node
 * refuses to spawn directly (`spawn EINVAL` since 18.20 / 20.12). Those run
 * through `cmd.exe` as one pre-quoted command line; native binaries such as
 * `adb` spawn as-is. `signal` kills the child when the caller aborts.
 */
export async function execSdkTool(
  toolPath: string,
  args: string[],
  { signal }: { signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!isBatchFile(toolPath)) return execFileAsync(toolPath, args, { signal });
  return execBatch(buildBatchCommand(toolPath, args), signal);
}

/**
 * Run a `.bat` command line through `cmd.exe`, and on abort kill its whole
 * process tree. Killing only `cmd.exe` would leave the wrapper's JVM running,
 * and every later device-list poll would start another one. The promise
 * rejects as soon as `signal` aborts, without waiting for the tree to exit.
 */
function execBatch(
  command: string,
  signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const killTree = () => {
      if (child.pid !== undefined) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      }
      reject(signal?.reason);
    };
    const child = execFile(command, [], { shell: true }, (error, stdout, stderr) => {
      signal?.removeEventListener("abort", killTree);
      // Match promisified execFile, which keeps the output on the error.
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    if (signal?.aborted) killTree();
    else signal?.addEventListener("abort", killTree, { once: true });
  });
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
 * A trailing `\` is rejected too: quoted, it becomes `"x\"`, which `cmd.exe`
 * reads as intended but `java.exe` behind the wrapper reads as a literal quote,
 * so the arguments after it would split in the wrong places.
 */
export function buildBatchCommand(toolPath: string, args: string[]): string {
  for (const arg of args) {
    if (/[%!^"\r\n]|\\$/.test(arg)) {
      throw new Error(`[android-utils] Refusing to pass ${JSON.stringify(arg)} to cmd.exe.`);
    }
  }
  return [toolPath, ...args].map(quoteBatchArg).join(" ");
}

function quoteBatchArg(arg: string): string {
  if (/^[\w./:\\-]+$/.test(arg)) return arg;
  return `"${arg}"`;
}
