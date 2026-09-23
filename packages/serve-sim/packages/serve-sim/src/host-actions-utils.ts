import { execFile } from "child_process";
import { chmod, lstat, mkdir, readdir, rm } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";

export interface HostActionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the deadline killed the child; the remedy differs from an ordinary non-zero exit. */
  timedOut?: true;
}

export interface Invocation {
  file: string;
  args: string[];
  timeoutMs?: number;
}

/**
 * `simctl` wedges on a busy or unwarmed simulator and never returns. Without a deadline a stuck
 * child holds its slot for the life of the process, so eight of them silence the channel for good.
 * Read per call so a slow host can raise it without a rebuild.
 */
const DEFAULT_ACTION_TIMEOUT_MS = 120_000;

function actionTimeoutMs(): number {
  const configured = Number(process.env.SERVE_SIM_ACTION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ACTION_TIMEOUT_MS;
}

export function createSerialQueue(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (work) => {
    const result = tail.then(work, work);
    tail = result.catch(() => {});
    return result;
  };
}

/** mkdir's mode only applies on creation, so a directory from an earlier run keeps its mode. */
export async function ensurePrivateDirAsync(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

/** Drops entries older than maxAgeMs, then reports the bytes the rest still hold. */
export async function pruneStaleEntriesAsync(dir: string, maxAgeMs: number): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const info = await lstat(full);
      if (info.mtimeMs < cutoff) await rm(full, { force: true, recursive: true });
      else total += info.size;
    } catch {}
  }
  return total;
}

/** Child output is useful, but a stack trace prints the operator's checkout. Keep the message. */
function redactHostPaths(text: string): string {
  if (!text) return text;
  return text.split(homedir()).join("~").replace(/\/(?:private\/)?var\/folders\/\S+/g, "<tmp>");
}

export function runInvocation({ file, args, timeoutMs }: Invocation): Promise<HostActionResult> {
  const deadlineMs = timeoutMs ?? actionTimeoutMs();
  return new Promise<HostActionResult>((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: deadlineMs, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        // `killed` distinguishes the deadline's own kill from a SIGKILL the operator or the OOM
        // killer sent, which must not be reported as "the command did not finish in time".
        const spawned = err as (NodeJS.ErrnoException & { signal?: string; killed?: boolean }) | null;
        if (spawned?.killed === true && spawned.signal === "SIGKILL") {
          resolve({
            stdout: stdout.toString(),
            stderr:
              `The ${basename(file)} command did not finish within ${deadlineMs / 1000}s and was ` +
              "stopped. The simulator or the host may be busy; try again, and restart the " +
              "simulator if this repeats.",
            exitCode: 1,
            timedOut: true,
          });
          return;
        }
        resolve({
          stdout: stdout.toString(),
          // Never `err.message`: it embeds the absolute binary path and the full argv.
          stderr:
            redactHostPaths(stderr.toString()) ||
            (typeof code === "string" ? `spawn failed (${code})` : ""),
          exitCode: err ? (typeof code === "number" ? code : 1) : 0,
        });
      },
    );
  });
}

export function ok(stdout = ""): HostActionResult {
  return { stdout, stderr: "", exitCode: 0 };
}
