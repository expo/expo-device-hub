import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { promisify } from "util";
import { dirnameOf } from "./runtime";
import { simctlRaw, type SimctlOptions } from "./simctl";
import { withStateLock } from "./state-lock";

const __dirname = dirnameOf(import.meta.url);
const execFileAsync = promisify(execFile);
const PASTEBOARD_LOCK_TIMEOUT_MS = 90_000;
export const MAX_PASTEBOARD_TEXT_BYTES = 4 * 1024 * 1024;

export class PasteboardTooLargeError extends Error {}

export function locatePasteboardTool(): string | null {
  return locateSimpbArtifact("serve-sim-pasteboard");
}

export function locateSimpbArtifact(file: string): string | null {
  const override = process.env.SERVE_SIM_SIMPB_DIR;
  const candidate = [
    ...(override ? [join(override, file)] : []),
    join(__dirname, "..", "dist", "simpb", file),
    join(__dirname, "simpb", file),
  ].find(existsSync);
  return candidate ? resolve(candidate) : null;
}

// Concurrent callers share one build of a source, and the server keeps serving while clang runs.
const buildsInFlight = new Map<string, Promise<unknown>>();

export async function buildSimpbArtifact(source: string, artifact: string): Promise<string> {
  let build = buildsInFlight.get(source);
  if (!build) {
    const buildScript = join(__dirname, "..", "Sources", source, "build.sh");
    if (!existsSync(buildScript)) {
      throw new Error(`${source} source not found. Reinstall from a build that includes clipboard support.`);
    }
    console.error(`[serve-sim] building ${source}…`);
    build = execFileAsync("bash", [buildScript]).finally(() => buildsInFlight.delete(source));
    buildsInFlight.set(source, build);
  }
  await build;
  const output = locateSimpbArtifact(artifact);
  if (!output) throw new Error(`${source} build succeeded but ${artifact} was not found.`);
  return output;
}

export function withSimPasteboardLock<T>(udid: string, run: () => Promise<T>): Promise<T> {
  const path = join(tmpdir(), "serve-sim-pasteboard-locks", `${udid}.lock`);
  return withStateLock(
    path,
    PASTEBOARD_LOCK_TIMEOUT_MS,
    () => new Error(`Timed out waiting for the simulator pasteboard on ${udid}`),
    run,
  );
}

export function writeSimPasteboard(udid: string, text: string): Promise<void> {
  return withSimPasteboardLock(udid, () => writeSimPasteboardUnlocked(udid, text));
}

export async function writeSimPasteboardUnlocked(udid: string, text: string): Promise<void> {
  const tool = locatePasteboardTool() ?? await buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard");
  return new Promise((resolveWrite, rejectWrite) => {
    const child = spawn("xcrun", ["simctl", "spawn", udid, tool], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let pipeError: Error | null = null;
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timeout); rejectWrite(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) rejectWrite(new Error("simctl pasteboard write timed out"));
      else if (code === 0 && !pipeError) resolveWrite();
      // simctl's own reason (such as an unknown device) explains a closed stdin better than EPIPE.
      else rejectWrite(new Error(stderr.trim() || pipeError?.message || `simctl pasteboard write exited ${code}`));
    });
    child.stdin.once("error", (error) => {
      pipeError = error;
      child.kill("SIGKILL");
    });
    child.stdin.end(text, "utf-8");
  });
}

export interface PasteboardReadResult {
  text: string;
  cleanupWarning?: string;
}

export async function readPasteboardText(args: string[], options: SimctlOptions = {}): Promise<string> {
  try {
    return await simctlRaw(args, { ...options, maxBuffer: MAX_PASTEBOARD_TEXT_BYTES });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
      error.message.startsWith("stdout ")) {
      throw new PasteboardTooLargeError("Simulator clipboard text is too large");
    }
    throw error;
  }
}

export async function readPasteboardViaSimctl(udid: string): Promise<PasteboardReadResult> {
  const text = await readPasteboardText(["pbpaste", udid], {
    env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
  });
  return { text };
}
