import { execFile, type ExecFileException } from "node:child_process";

/** The `sysctl` names that {@link isBareMetalAppleSilicon} reads, in one call. */
export const HOST_GPU_SYSCTL_NAMES = [
  "hw.optional.arm64",
  "sysctl.proc_translated",
  "kern.hv_vmm_present",
] as const;

const SYSCTL_PATH = "/usr/sbin/sysctl";
const SYSCTL_TIMEOUT_MS = 2_000;

/**
 * Whether the host is an Apple silicon Mac that is not a virtual machine, from
 * the `name: value` lines that `sysctl` prints for {@link HOST_GPU_SYSCTL_NAMES}.
 *
 * - Apple silicon: `hw.optional.arm64` is `1`, or `sysctl.proc_translated` is
 *   `1` (the `sysctl` process runs under Rosetta, which exists only on Apple
 *   silicon). An Intel Mac does not know these names.
 * - Not a virtual machine: `kern.hv_vmm_present` is exactly `0`. A missing or
 *   empty value counts as a virtual machine, so an unknown host keeps `-gpu auto`.
 */
// @ref LLP 0024#detection — only bare-metal Apple silicon gets -gpu host; unknown counts as no
export function isBareMetalAppleSilicon(platform: NodeJS.Platform, sysctlOutput: string): boolean {
  if (platform !== "darwin") return false;
  const values = new Map<string, string>();
  for (const line of sysctlOutput.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0)
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const appleSilicon =
    values.get("hw.optional.arm64") === "1" || values.get("sysctl.proc_translated") === "1";
  return appleSilicon && values.get("kern.hv_vmm_present") === "0";
}

/**
 * Run `sysctl` for {@link HOST_GPU_SYSCTL_NAMES} and resolve with its stdout.
 * `sysctl` exits non-zero when it does not know one of the names, but still
 * prints the others on exit 1. Other failures discard partial output. Never rejects.
 */
export function readHostSysctl(
  run: (
    path: string,
    args: string[],
    options: { timeout: number },
    callback: (error: ExecFileException | null, stdout: string) => void,
  ) => unknown = execFile,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      run(
        SYSCTL_PATH,
        [...HOST_GPU_SYSCTL_NAMES],
        { timeout: SYSCTL_TIMEOUT_MS },
        (error, stdout) => {
          // Exit 1 can mean one unknown key, with the other answers still valid.
          // A timeout, signal or spawn/buffer failure must keep the conservative default,
          // even when sysctl printed enough values before it failed.
          if (error && (error.killed || error.signal || error.code !== 1)) return resolve("");
          resolve(typeof stdout === "string" ? stdout : "");
        },
      );
    } catch {
      resolve("");
    }
  });
}

let detected: Promise<boolean> | null = null;

/**
 * Whether this process runs on an Apple silicon Mac that is not a virtual
 * machine: the host where an emulator renders on the GPU with `-gpu host`, and
 * where a headless `-gpu auto` picks a software renderer. Reads `sysctl` once
 * per process; any failure counts as `false`.
 */
export function detectBareMetalAppleSilicon(): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(false);
  detected ??= readHostSysctl().then((output) => isBareMetalAppleSilicon("darwin", output));
  return detected;
}

/**
 * The `-gpu` mode for an emulator boot that names none: `host` on an Apple
 * silicon Mac that is not a virtual machine, `auto` everywhere else.
 */
// @ref LLP 0024#boot-default — host only where it is known to work; auto stays the default elsewhere
export async function defaultEmulatorGpu(
  detect: () => Promise<boolean> = detectBareMetalAppleSilicon,
): Promise<"host" | "auto"> {
  return (await detect()) ? "host" : "auto";
}
