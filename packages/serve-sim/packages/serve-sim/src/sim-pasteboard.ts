import { randomUUID } from "crypto";
import { execFileSync, spawn } from "child_process";
import { existsSync, promises as fs } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";
import { capabilityIsDisabled, type CapabilityDefinition } from "./capabilities";
import { debugPasteboard } from "./debug";
import { frontmostAppOf } from "./foreground-tracker";
import { devicesArmedHere, releaseSessionSync, setCapabilityEnabled } from "./launch-manager";
import { readLaunchState } from "./launch-state";
import { dirnameOf } from "./runtime";
import { simctl, simctlRaw } from "./simctl";
import { withStateLock } from "./state-lock";

// Resolve this path at runtime, not during the Bun build.
const __dirname = dirnameOf(import.meta.url);

export const CLIPBOARD_CAPABILITY = "clipboard";
export const MAX_PASTEBOARD_TEXT_BYTES = 4 * 1024 * 1024;

const SPRINGBOARD_BUNDLE = "com.apple.springboard";
const INJECTED_TIMEOUT_MS = 1200;
const INJECTED_POLL_MS = 25;
const RELAUNCH_TIMEOUT_MS = 8000;
const PASTEBOARD_LOCK_TIMEOUT_MS = 90_000;

export function locatePasteboardTool(): string | null {
  return locateSimpbArtifact("serve-sim-pasteboard");
}

function buildPasteboardTool(): string {
  return buildSimpbArtifact("SimPasteboard", "serve-sim-pasteboard");
}

export function locatePasteboardReaderDylib(): string | null {
  return locateSimpbArtifact("libSimPasteboardReader.dylib");
}

function buildPasteboardReaderDylib(): string {
  return buildSimpbArtifact("SimPasteboardReader", "libSimPasteboardReader.dylib");
}

function buildSimpbArtifact(source: string, artifact: string): string {
  const buildScript = join(__dirname, "..", "Sources", source, "build.sh");
  if (!existsSync(buildScript)) {
    throw new Error(`${source} source not found. Reinstall from a build that includes clipboard support.`);
  }
  execFileSync("bash", [buildScript], { stdio: "inherit" });
  const output = locateSimpbArtifact(artifact);
  if (!output) throw new Error(`${source} build succeeded but ${artifact} was not found.`);
  return output;
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

export const clipboardCapability: CapabilityDefinition = {
  name: CLIPBOARD_CAPABILITY,
  defaultEnabled: true,
  scope: "allApps",
  loadDelayMs: 0,
  async setEnabled({ udid, bundleId, enabled }) {
    if (!enabled) return null;
    if (bundleId) await simctl(["privacy", udid, "grant", "pasteboard", bundleId]);
    return { dylib: locatePasteboardReaderDylib() ?? buildPasteboardReaderDylib() };
  },
};

function withSimPasteboardLock<T>(udid: string, run: () => Promise<T>): Promise<T> {
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

export function pasteTextIntoSim(
  udid: string,
  text: string,
  sendPasteShortcut: () => Promise<void>,
): Promise<void> {
  return withSimPasteboardLock(udid, async () => {
    await writeSimPasteboardUnlocked(udid, text);
    await sendPasteShortcut();
  });
}

function writeSimPasteboardUnlocked(udid: string, text: string): Promise<void> {
  const tool = locatePasteboardTool() ?? buildPasteboardTool();
  return new Promise((resolveWrite, rejectWrite) => {
    const child = spawn("xcrun", ["simctl", "spawn", udid, tool], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let pendingError: Error | null = null;
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      pendingError = new Error("simctl pasteboard write timed out");
      child.kill("SIGKILL");
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectWrite(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (pendingError) rejectWrite(pendingError);
      else if (code === 0) resolveWrite();
      else rejectWrite(new Error(stderr.trim() || `simctl pasteboard write exited ${code}`));
    });
    // Node throws an unhandled EPIPE if simctl exits before reading the text.
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

const readsInFlight = new Map<string, Promise<PasteboardReadResult>>();

export async function readSimPasteboard(udid: string): Promise<string> {
  return (await readSimPasteboardResult(udid)).text;
}

export function readSimPasteboardResult(udid: string): Promise<PasteboardReadResult> {
  const queued = (readsInFlight.get(udid) ?? Promise.resolve())
    .catch(() => {})
    .then(() => readPasteboardOnce(udid));
  readsInFlight.set(udid, queued);
  void queued.catch(() => {}).finally(() => {
    if (readsInFlight.get(udid) === queued) readsInFlight.delete(udid);
  });
  return queued;
}

async function readPasteboardOnce(udid: string): Promise<PasteboardReadResult> {
  let pbpasteError: unknown;
  if (process.env.SERVE_SIM_SKIP_PBPASTE !== "1") {
    try {
      return {
        text: await simctlRaw(["pbpaste", udid], {
          env: { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
        }),
        relaunchedApp: null,
      };
    } catch (error: unknown) {
      pbpasteError = error;
    }
  }
  let injectedError: unknown;
  const injected = await readViaInjectedReader(udid).catch((error: unknown) => {
    injectedError = error;
    return null;
  });
  if (injected !== null) return injected;
  const reasons = [
    injectedError instanceof Error
      ? injectedError.message
      : "no frontmost app answered the injected reader",
  ];
  if (pbpasteError instanceof Error) reasons.push(`simctl pbpaste: ${pbpasteError.message}`);
  throw new Error(
    `Could not read the simulator pasteboard on ${udid}. Open the app you copied from and retry. (${reasons.join("; ")})`,
  );
}

let releaseHookInstalled = false;

// An embedded simMiddleware has no session lifecycle, so disarm what a clipboard read armed on exit.
function releaseArmedDevicesOnExit(): void {
  if (releaseHookInstalled) return;
  releaseHookInstalled = true;
  process.once("exit", () => {
    for (const udid of devicesArmedHere()) {
      try {
        releaseSessionSync(udid, process.pid, () => {});
      } catch (error) {
        console.error(
          `Could not disarm the capability loader on ${udid}; clear it with: xcrun simctl spawn ` +
            `${udid} launchctl unsetenv DYLD_INSERT_LIBRARIES ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  });
}

// A headless host often has no frontmost app, so fall back to the one this session launched.
// Relaunching it over the Home screen would move the user off Home.
export function pasteboardTarget(
  frontmost: { bundleId: string } | null,
  launched: string | null,
): { bundleId: string; relaunch: boolean } | null {
  if (frontmost && frontmost.bundleId !== SPRINGBOARD_BUNDLE) {
    return { bundleId: frontmost.bundleId, relaunch: true };
  }
  if (!launched || launched === SPRINGBOARD_BUNDLE) return null;
  return { bundleId: launched, relaunch: frontmost === null };
}

async function readViaInjectedReader(udid: string): Promise<PasteboardReadResult | null> {
  if (capabilityIsDisabled(udid, CLIPBOARD_CAPABILITY)) {
    throw new Error(
      "the clipboard capability is disabled for this session, so its reader cannot be loaded. " +
        "Restart serve-sim without `--disable clipboard` to read the simulator pasteboard.",
    );
  }
  const frontmost = await frontmostAppOf(udid);
  const target = pasteboardTarget(frontmost, readLaunchState(udid)?.bundleId ?? null);
  if (!target) return null;
  const { bundleId } = target;

  // System apps like Settings have no data container: get_app_container exits 0
  // and prints "(null)". There is nowhere to exchange files, so relaunching the
  // app would not help.
  const container = await simctl(["get_app_container", udid, bundleId, "data"]);
  if (!isContainerPath(container)) return null;
  // A denied read and an empty pasteboard both produce an empty string, so grant first.
  releaseArmedDevicesOnExit();
  await setCapabilityEnabled(udid, clipboardCapability, {
    bundleId,
    enabled: true,
    relaunch: false,
    reuseIfEnabled: true,
  });
  const afterArming = await requestInjectedPasteboard(container);
  if (afterArming !== null) return { text: afterArming, relaunchedApp: null };
  if (!target.relaunch) return null;

  debugPasteboard(
    "%s did not answer on %s after arming %s; relaunching as a last resort",
    bundleId,
    udid,
    CLIPBOARD_CAPABILITY,
  );
  await setCapabilityEnabled(udid, clipboardCapability, {
    bundleId,
    enabled: true,
    relaunch: true,
    reuseIfEnabled: true,
  });
  const afterRelaunch = await requestInjectedPasteboard(container, RELAUNCH_TIMEOUT_MS);
  return afterRelaunch === null ? null : { text: afterRelaunch, relaunchedApp: bundleId };
}

/**
 * Read the answer the reader left behind, or null when there isn't one. The
 * reader renames the done file into place, so seeing it means both files are
 * complete.
 */
async function takeInjectedAnswer(
  valuePath: string,
  donePath: string,
): Promise<{ nonce: string; text: string } | null> {
  if (!existsSync(donePath)) return null;
  try {
    const nonce = (await fs.readFile(donePath, "utf-8")).trim();
    const text = await fs.readFile(valuePath, "utf-8");
    return { nonce, text };
  } catch (error: unknown) {
    // A vanished file is the expected race with our own cleanup. Anything else
    // is a real failure that would otherwise surface as "nobody answered".
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") debugPasteboard("could not read the answer in %s: %s", valuePath, error);
    return null;
  } finally {
    await fs.rm(donePath, { force: true });
    await fs.rm(valuePath, { force: true });
  }
}

/** A real data container, not "(null)" and not a relative path we would write into cwd. */
function isContainerPath(container: string): boolean {
  return container.startsWith("/");
}

export async function requestInjectedPasteboard(
  container: string,
  timeoutMs = INJECTED_TIMEOUT_MS,
): Promise<string | null> {
  if (!isContainerPath(container)) return null;
  const tmpDir = join(container, "tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const lockPath = join(tmpDir, "serve-sim-pasteboard.lock");
  return withStateLock(
    lockPath,
    60_000,
    () => new Error(`Timed out waiting to read the simulator pasteboard in ${container}`),
    () => requestInjectedPasteboardUnlocked(tmpDir, timeoutMs),
  );
}

async function requestInjectedPasteboardUnlocked(
  tmpDir: string,
  timeoutMs: number,
): Promise<string | null> {
  const valuePath = join(tmpDir, "serve-sim-pasteboard.txt");
  const donePath = `${valuePath}.done`;
  const requestPath = join(tmpDir, "serve-sim-pasteboard.request");
  // A request that timed out can still be answered afterwards, and answering it
  // consumes the next request. The nonce tells our answer from that one.
  const nonce = randomUUID();
  await fs.rm(donePath, { force: true });
  await fs.rm(valuePath, { force: true });
  await fs.writeFile(requestPath, nonce);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await takeInjectedAnswer(valuePath, donePath);
    if (answer?.nonce === nonce) return answer.text;
    if (answer) await fs.writeFile(requestPath, nonce);
    await sleep(INJECTED_POLL_MS);
  }
  await fs.rm(requestPath, { force: true });
  await fs.rm(valuePath, { force: true });
  await fs.rm(donePath, { force: true });
  return null;
}
