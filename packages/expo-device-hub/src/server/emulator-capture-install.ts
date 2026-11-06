import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
// The release builds the Hub and the agent package from one commit, so the bundle carries the
// agent version that was published with it.
import captureManifest from "../../../expo-emulator-capture/package.json" with { type: "json" };

export const EMULATOR_CAPTURE_PACKAGE = "expo-emulator-capture";
export const EMULATOR_CAPTURE_VERSION: string = captureManifest.version;

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 60 * 1000;
const LOCK_POLL_MS = 500;
const MAX_ERROR_OUTPUT = 2000;

/** The agent library inside the package, by host platform. */
const AGENT_LIBRARIES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "dist/darwin-arm64/libexpo_emulator_capture.dylib",
};

export type InstallCommand = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ status: number | null; output: string; error?: Error }>;

export type EmulatorCaptureInstallOptions = {
  version?: string;
  platform?: NodeJS.Platform;
  /** Where versioned installs live; `~/.cache/expo-device-hub` by default. */
  baseDirectory?: string;
  run?: InstallCommand;
};

/** The default cache folder for the Hub's own tools. */
export function defaultToolsDirectory(): string {
  return join(homedir(), ".cache", "expo-device-hub");
}

// @ref LLP 0017#integration — the Hub installs a pinned agent package into its own cache
/**
 * Installs the pinned `expo-emulator-capture` with npm into a folder of its own and returns the
 * agent library path. A finished install is reused. Like T3 Code's device tools, it installs
 * into a staging folder, writes a completion marker, and renames the folder into place under
 * a lock, so a crash or a second Hub never leaves a half-installed package behind.
 */
export async function installEmulatorCapture({
  version = EMULATOR_CAPTURE_VERSION,
  platform = process.platform,
  baseDirectory = defaultToolsDirectory(),
  run = runInstallCommand,
}: EmulatorCaptureInstallOptions = {}): Promise<string> {
  const relativeLibrary = AGENT_LIBRARIES[platform];
  if (!relativeLibrary) throw new Error(`${EMULATOR_CAPTURE_PACKAGE} has no agent for ${platform}`);
  const installDirectory = join(baseDirectory, "tools", EMULATOR_CAPTURE_PACKAGE, version);
  const library = join(installDirectory, "node_modules", EMULATOR_CAPTURE_PACKAGE, relativeLibrary);
  const marker = join(installDirectory, ".install-complete");
  const complete = async () =>
    existsSync(library) &&
    (await readFile(marker, "utf8").then(
      (text) => text.trim() === version,
      () => false,
    ));
  if (await complete()) return library;

  await mkdir(dirname(installDirectory), { recursive: true });
  const release = await acquireLock(`${installDirectory}.lock`, complete);
  if (!release) return library; // Another Hub finished the install while this one waited.
  let staging: string | null = null;
  try {
    if (await complete()) return library;
    staging = await mkdtemp(join(dirname(installDirectory), ".staging-"));
    const result = await run(
      "npm",
      [
        "install",
        "--prefix",
        staging,
        "--no-fund",
        "--no-audit",
        "--no-save",
        `${EMULATOR_CAPTURE_PACKAGE}@${version}`,
      ],
      { timeoutMs: INSTALL_TIMEOUT_MS },
    );
    if (result.status !== 0) {
      const detail = result.error?.message ?? npmErrorSummary(result.output);
      throw new Error(`npm install ${EMULATOR_CAPTURE_PACKAGE}@${version} failed: ${detail}`);
    }
    if (!existsSync(join(staging, "node_modules", EMULATOR_CAPTURE_PACKAGE, relativeLibrary))) {
      throw new Error(
        `${EMULATOR_CAPTURE_PACKAGE}@${version} has no agent library for ${platform}`,
      );
    }
    await writeFile(join(staging, ".install-complete"), `${version}\n`);
    await rm(installDirectory, { recursive: true, force: true });
    await rename(staging, installDirectory);
    staging = null;
    return library;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    await release();
  }
}

/**
 * Takes a lock directory, or waits until `done` reports that the holder finished. Returns null
 * when it finished, so the caller has nothing left to do. An abandoned lock is taken over.
 */
async function acquireLock(
  path: string,
  done: () => Promise<boolean>,
): Promise<(() => Promise<void>) | null> {
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner"), `${process.pid} ${hostname()}\n`).catch(() => {});
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await done()) return null;
    if (await lockIsAbandoned(path)) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

/**
 * A lock whose owner process on this host is gone, such as a Hub stopped during its first
 * install, or one older than the install timeout, from another host or without an owner.
 */
export async function lockIsAbandoned(
  path: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): Promise<boolean> {
  const owner = await readFile(join(path, "owner"), "utf8").catch(() => "");
  const [pid, host] = owner.trim().split(" ");
  if (pid && host === hostname() && !isAlive(Number(pid))) return true;
  const age = await stat(path).then(
    (info) => Date.now() - info.mtimeMs,
    () => 0,
  );
  return age > LOCK_STALE_MS;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * npm's reason in one short line, for the note in the Hub: the first `npm error` message, without
 * the code lines, the generic advice and the log path.
 */
export function npmErrorSummary(output: string): string {
  const noise = /^(code|syscall|errno|path)\b|^A complete log|^In most cases/;
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^npm (?:error|ERR!)\s*(.*)$/);
    if (!match?.[1] || noise.test(match[1])) continue;
    // npm puts a lowercase category before the message: "notarget No matching version…".
    const message = match[1].replace(/^[a-z]+ (?=[A-Za-z0-9])/, "");
    if (!message || noise.test(message)) continue;
    return message.length > 240 ? `${message.slice(0, 239)}…` : message;
  }
  return output.trim().slice(-MAX_ERROR_OUTPUT);
}

const runInstallCommand: InstallCommand = (command, args, { timeoutMs }) =>
  new Promise((resolve) => {
    let output = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4 * MAX_ERROR_OUTPUT);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, output, error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
