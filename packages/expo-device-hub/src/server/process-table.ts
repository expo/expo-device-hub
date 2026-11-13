/**
 * This OS account's processes from `ps`, with their parent pid, state, start time and
 * command line. Boot admission uses them to tell a live process from a dead
 * one whose pid was reused, and to see emulators adb does not list.
 *
 * @ref LLP 0018#process-identity — a process is its pid plus its start time
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type SerializableError, toSerializableError } from "./utility-errors";

const execFileAsync = promisify(execFile);

/** A process by its pid and start time, so a reused pid is not mistaken for it. */
export interface ProcessIdentity {
  pid: number;
  /** Start time in whole seconds since the epoch. */
  started: number;
}

export interface HostProcess extends ProcessIdentity {
  /** Parent pid, which ties an emulator launcher to its qemu child. */
  ppid: number;
  /** `ps` state, such as `S`, `R` or `Z` for an exited process its parent has not reaped. */
  state: string;
  /** The command line as `ps` prints it: the arguments joined by spaces. */
  args: string;
}

export interface ProcessTableResult {
  value: HostProcess[] | null;
  error: SerializableError | null;
}

/** Per `ps` call, matching the `adb` and `simctl` listings' limit. */
export const READ_PROCESS_TABLE_TIMEOUT_MS = 30_000;

/**
 * Linux `ps` derives start times from a boot time it rounds to whole seconds
 * from the wall clock on every read, so one process can read a second apart.
 */
const START_TIME_TOLERANCE_S = 2;

/**
 * One `-o` per column: BSD `ps` lets only the last keyword of a list carry `=`.
 * `-ww` keeps the command line whole.
 */
const PS_COLUMNS = [
  "-ww",
  "-o",
  "pid=",
  "-o",
  "ppid=",
  "-o",
  "uid=",
  "-o",
  "state=",
  "-o",
  "lstart=",
  "-o",
  "args=",
];

/** `lstart` in the C locale: `Sun Nov  1 10:00:00 2026`. */
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s?(.*)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * List this OS account's processes. `ps -A` lists every process and the table
 * keeps those whose real user id is this account's: BSD `ps -U` may also need
 * `-x` to keep processes without a terminal, such as a detached emulator. Any
 * failure, a missing `ps` included, is an `error`: without the table, liveness
 * is unknown. Never throws.
 */
export async function readProcessTable(): Promise<ProcessTableResult> {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("This platform has no user ids");
    const { stdout } = await execFileAsync("ps", ["-A", ...PS_COLUMNS], {
      timeout: READ_PROCESS_TABLE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      // A fixed locale and zone, so every Hub parses the same start time.
      env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
    });
    return { value: parseProcessTable(stdout, uid), error: null };
  } catch (error) {
    return {
      value: null,
      error: toSerializableError({
        message: "Failed to list the host's processes with `ps`",
        error,
      }),
    };
  }
}

/**
 * Parse `ps` output in the format of {@link PS_COLUMNS}, keeping the processes
 * of real user id `uid`; throws on a line it cannot read.
 */
export function parseProcessTable(stdout: string, uid: number): HostProcess[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      const match = PS_LINE.exec(line);
      const month = MONTHS.indexOf(match?.[5] ?? "");
      if (!match || month === -1) throw new Error(`Unrecognized \`ps\` line: ${line}`);
      const [, pid, ppid, owner, state, , day, hours, minutes, seconds, year, args] = match;
      if (Number(owner) !== uid) return [];
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        state: state!,
        started:
          Date.UTC(
            Number(year),
            month,
            Number(day),
            Number(hours),
            Number(minutes),
            Number(seconds),
          ) / 1000,
        args: args ?? "",
      };
    });
}

/**
 * Whether `process` runs: the table has its pid, not as a zombie, and, when
 * its start time is known, with that start time.
 */
export function isRunning(
  processes: HostProcess[],
  { pid, started }: Pick<ProcessIdentity, "pid"> & Partial<ProcessIdentity>,
): boolean {
  return processes.some(
    (entry) =>
      entry.pid === pid &&
      !entry.state.startsWith("Z") &&
      (started === undefined || Math.abs(entry.started - started) <= START_TIME_TOLERANCE_S),
  );
}

/** Whether any process has `pid`; a cheap check before reading the table. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another account.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}
