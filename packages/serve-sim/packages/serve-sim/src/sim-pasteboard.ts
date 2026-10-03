import { execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { dirnameOf } from "./runtime";
import { simctlRaw, type SimctlOptions } from "./simctl";
import { withStateLock } from "./state-lock";

const __dirname = dirnameOf(import.meta.url);
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

export function buildSimpbArtifact(source: string, artifact: string): string {
  const buildScript = join(__dirname, "..", "Sources", source, "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error(`${source} source not found. Reinstall from a build that includes clipboard support.`);
  }
  execFileSync("bash", [buildScript], { stdio: "inherit" });
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

export function writeSimPasteboardUnlocked(udid: string, text: string): Promise<void> {
  const tool = locatePasteboardTool() ?? buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard");
  return new Promise((resolveWrite, rejectWrite) => {
    const child = spawn("xcrun", ["simctl", "spawn", udid, tool], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let pendingError: Error | null = null;
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      pendingError = new Error("simctl pasteboard write timed out");
      child.kill("SIGKILL");
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timeout); rejectWrite(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (pendingError) rejectWrite(pendingError);
      else if (code === 0) resolveWrite();
      else rejectWrite(new Error(stderr.trim() || `simctl pasteboard write exited ${code}`));
    });
    child.stdin.once("error", (error) => {
      pendingError = error;
      child.kill("SIGKILL");
    });
    child.stdin.end(text, "utf-8");
  });
}

export interface PasteboardReadResult {
  text: string;
  relaunchedApp: string | null;
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

export async function readSimPasteboardResult(udid: string): Promise<PasteboardReadResult> {
  const text = await readPasteboardText(["pbpaste", udid], {
    env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
  });
  return { text, relaunchedApp: null };
}
