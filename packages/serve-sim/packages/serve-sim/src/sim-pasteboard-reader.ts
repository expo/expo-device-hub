import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import type { CapabilityDefinition } from "./capabilities";
import { debugPasteboard } from "./debug";
import { frontmostAppOf } from "./foreground-tracker";
import { isCapabilityEnabled } from "./launch-manager";
import { readLaunchState } from "./launch-state";
import { simctl } from "./simctl";
import { withStateLock } from "./state-lock";
import { buildSimpbArtifact, locateSimpbArtifact, MAX_PASTEBOARD_TEXT_BYTES, PasteboardTooLargeError, readPasteboardViaSimctl, type PasteboardReadResult } from "./sim-pasteboard";

export const CLIPBOARD_CAPABILITY = "clipboard";

const SPRINGBOARD_BUNDLE = "com.apple.springboard";
const INJECTED_TIMEOUT_MS = 1200;
const INJECTED_POLL_MS = 25;

export class PasteboardUnavailableError extends Error {}

export function locatePasteboardReaderDylib(): string | null {
  return locateSimpbArtifact("libSimPasteboardReader.dylib");
}

function buildPasteboardReaderDylib(): Promise<string> {
  return buildSimpbArtifact("SimPasteboardReader", "libSimPasteboardReader.dylib");
}

export const clipboardCapability: CapabilityDefinition = {
  name: CLIPBOARD_CAPABILITY,
  defaultEnabled: true,
  scope: "allApps",
  loadDelayMs: 0,
  async setEnabled({ enabled }) {
    if (!enabled) return null;
    return {
      dylib: locatePasteboardReaderDylib() ?? await buildPasteboardReaderDylib(),
    };
  },
};

const readsInFlight = new Map<string, Promise<PasteboardReadResult>>();

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
  if (process.env.SERVE_SIM_SKIP_PBPASTE !== "1") {
    try {
      return await readPasteboardViaSimctl(udid);
    } catch (error) {
      if (error instanceof PasteboardTooLargeError) throw error;
      debugPasteboard("simctl pbpaste failed on %s: %s", udid, error);
    }
  }
  try {
    return await readViaInjectedReader(udid);
  } catch (error) {
    if (error instanceof PasteboardTooLargeError || error instanceof PasteboardUnavailableError) throw error;
    console.error(`[serve-sim] Could not read the simulator clipboard through the app reader on ${udid}:`, error);
    throw new PasteboardUnavailableError("Could not read the simulator clipboard. Open the app you copied from and retry.");
  }
}

export function pasteboardTarget(frontmost: { bundleId: string } | null, launched: string | null): string | null {
  const bundleId = frontmost && frontmost.bundleId !== SPRINGBOARD_BUNDLE ? frontmost.bundleId : launched;
  return bundleId && bundleId !== SPRINGBOARD_BUNDLE ? bundleId : null;
}

async function readViaInjectedReader(udid: string): Promise<PasteboardReadResult> {
  const frontmost = await frontmostAppOf(udid);
  const bundleId = pasteboardTarget(frontmost, readLaunchState(udid)?.bundleId ?? null);
  if (!bundleId) {
    throw new PasteboardUnavailableError("Could not read the simulator clipboard. Open the app you copied from and retry.");
  }
  if (!isCapabilityEnabled(udid, CLIPBOARD_CAPABILITY)) {
    throw new PasteboardUnavailableError("Clipboard reader is unavailable. Start a session with clipboard enabled and retry.");
  }
  const container = await simctl(["get_app_container", udid, bundleId, "data"]);
  if (!isContainerPath(container)) {
    throw new PasteboardUnavailableError("Clipboard is unavailable in this app. Open another app and retry.");
  }
  // A denied read and an empty pasteboard both produce an empty string.
  await simctl(["privacy", udid, "grant", "pasteboard", bundleId]);
  const text = await requestInjectedPasteboard(container);
  if (text === null) {
    // @ref LLP 0010#reads-never-restart-apps — why the error asks for a restart instead of restarting
    throw new PasteboardUnavailableError(frontmost?.bundleId === SPRINGBOARD_BUNDLE
      ? "Could not read the simulator clipboard. Open the app you copied from and retry."
      : "Could not read this app's clipboard. Restart the app and retry.");
  }
  return { text };
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
