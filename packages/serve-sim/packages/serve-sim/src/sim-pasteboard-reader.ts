import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { capabilityIsDisabled, type CapabilityDefinition } from "./capabilities";
import { debugPasteboard } from "./debug";
import { frontmostAppFromRecentLogs, frontmostAppOf } from "./foreground-tracker";
import { ensureCapabilityProcessCleanup, setCapabilityEnabled } from "./launch-manager";
import { readLaunchState } from "./launch-state";
import { simctl } from "./simctl";
import { withStateLock } from "./state-lock";
import { buildSimpbArtifact, locateSimpbArtifact, MAX_PASTEBOARD_TEXT_BYTES, PasteboardTooLargeError, readSimPasteboardResult as readNativePasteboard, type PasteboardReadResult } from "./sim-pasteboard";

export const CLIPBOARD_CAPABILITY = "clipboard";

const SPRINGBOARD_BUNDLE = "com.apple.springboard";
const INJECTED_TIMEOUT_MS = 1200;
const INJECTED_POLL_MS = 25;
const RELAUNCH_TIMEOUT_MS = 8000;

export function locatePasteboardReaderDylib(): string | null {
  return locateSimpbArtifact("libSimPasteboardReader.dylib");
}

function buildPasteboardReaderDylib(): string {
  return buildSimpbArtifact("SimPasteboardReader", "libSimPasteboardReader.dylib");
}

export const clipboardCapability: CapabilityDefinition = {
  name: CLIPBOARD_CAPABILITY,
  defaultEnabled: true,
  scope: "allApps",
  loadDelayMs: 0,
  async setEnabled({ udid, bundleId, enabled }) {
    if (!enabled) return null;
    ensureCapabilityProcessCleanup();
    if (bundleId) await simctl(["privacy", udid, "grant", "pasteboard", bundleId]);
    return {
      dylib: locatePasteboardReaderDylib() ?? buildPasteboardReaderDylib(),
    };
  },
};

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
      return await readNativePasteboard(udid);
    } catch (error: unknown) {
      if (error instanceof PasteboardTooLargeError) throw error;
      pbpasteError = error;
    }
  }
  let injectedError: unknown;
  const injected = await readViaInjectedReader(udid).catch((error: unknown) => {
    injectedError = error;
    return null;
  });
  if (injectedError instanceof PasteboardTooLargeError) throw injectedError;
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
  await setCapabilityEnabled(udid, clipboardCapability, {
    bundleId,
    enabled: true,
    relaunch: false,
    reuseIfEnabled: true,
    respectDisabledOverrides: true,
  });
  const afterArming = await requestInjectedPasteboard(container);
  if (afterArming !== null) return { text: afterArming, relaunchedApp: null };
  if (!target.relaunch) return null;

  let relaunched = false;
  await setCapabilityEnabled(udid, clipboardCapability, {
    bundleId,
    enabled: true,
    relaunch: true,
    reuseIfEnabled: true,
    respectDisabledOverrides: true,
    async canRelaunch() {
      const current = await frontmostAppFromRecentLogs(udid);
      if (current?.bundleId !== bundleId || (frontmost?.bundleId === bundleId && current.pid !== frontmost.pid)) return false;
      debugPasteboard(
        "%s did not answer on %s after arming %s; relaunching as a last resort",
        bundleId,
        udid,
        CLIPBOARD_CAPABILITY,
      );
      relaunched = true;
      return true;
    },
  });
  if (!relaunched) return null;
  const afterRelaunch = await requestInjectedPasteboard(container, RELAUNCH_TIMEOUT_MS);
  return afterRelaunch === null ? null : { text: afterRelaunch, relaunchedApp: bundleId };
}

// Nonce and text share one atomic record, even when readers finish out of order.
async function takeInjectedAnswer(
  donePath: string,
  expectedNonce: string,
): Promise<{ nonce: string; text: string } | null> {
  const readingPath = `${donePath}.reading`;
  let claimed = false;
  try {
    await fs.rename(donePath, readingPath);
    claimed = true;
    const file = await fs.open(readingPath, "r");
    try {
      const header = Buffer.alloc(128);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      const separator = header.subarray(0, bytesRead).indexOf(10);
      if (separator < 0) return null;
      const nonce = header.subarray(0, separator).toString("utf-8");
      if (nonce !== expectedNonce) return { nonce, text: "" };
      if ((await file.stat()).size - separator - 1 > MAX_PASTEBOARD_TEXT_BYTES) {
        throw new PasteboardTooLargeError("Simulator clipboard text is too large");
      }
      const record = await file.readFile();
      if (record.length - separator - 1 > MAX_PASTEBOARD_TEXT_BYTES) {
        throw new PasteboardTooLargeError("Simulator clipboard text is too large");
      }
      return { nonce, text: record.subarray(separator + 1).toString("utf-8") };
    } finally {
      await file.close();
    }
  } catch (error: unknown) {
    if (error instanceof PasteboardTooLargeError) throw error;
    // A vanished file is the expected race with our own cleanup. Anything else
    // is a real failure that would otherwise surface as "nobody answered".
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT") debugPasteboard("could not read the answer in %s: %s", donePath, error);
    return null;
  } finally {
    if (claimed) await fs.rm(readingPath, { force: true });
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
  const donePath = join(tmpDir, "serve-sim-pasteboard.txt.done");
  const requestPath = join(tmpDir, "serve-sim-pasteboard.request");
  const publishRequest = async (nonce: string) => {
    const pending = `${requestPath}.pending`;
    await fs.writeFile(pending, nonce);
    await fs.rename(pending, requestPath);
  };
  // A timed-out request can still publish a stale answer. The nonce identifies
  // the one we asked for, and the rename gives the reader a complete request.
  const nonce = randomUUID();
  await fs.rm(donePath, { force: true });
  await publishRequest(nonce);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answer = await takeInjectedAnswer(donePath, nonce);
    if (answer?.nonce === nonce) return answer.text;
    if (answer) await publishRequest(nonce);
    await sleep(INJECTED_POLL_MS);
  }
  await fs.rm(requestPath, { force: true });
  await fs.rm(donePath, { force: true });
  return null;
}
