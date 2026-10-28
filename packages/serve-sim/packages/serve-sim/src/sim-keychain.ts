import { randomUUID } from "crypto";
import { existsSync, promises as fs } from "fs";
import { join, resolve } from "path";
import { setTimeout as sleep } from "timers/promises";
import { z } from "zod";
import type { CapabilityDefinition } from "./capabilities";
import { debugKeychain } from "./debug";
import { isCapabilityEnabled } from "./launch-manager";
import { dirnameOf } from "./runtime";
import { APP_NOT_INSTALLED, isContainerPath, simctl } from "./simctl";
import { withStateLock } from "./state-lock";

const __dirname = dirnameOf(import.meta.url);

export const KEYCHAIN_CAPABILITY = "keychain";

const ANSWER_TIMEOUT_MS = 3000;
const ANSWER_POLL_MS = 25;
// A request the app claimed right at the deadline is running; its answer follows shortly.
const CLAIMED_ANSWER_GRACE_MS = 5000;
// A queued request expires, so a value seeded for a closed app cannot overwrite what the app
// stored itself long after; the app drops it unread.
export const QUEUED_REQUEST_TTL_MS = 60 * 60 * 1000;
// Answers to queued requests arrive when no one waits; they hold attribute names, not values.
const STALE_ANSWER_MS = 60 * 60 * 1000;
// Same value as kMaxRequestBytes in Sources/SimKeychain/sim-keychain.m.
export const MAX_KEYCHAIN_REQUEST_BYTES = 1024 * 1024;

export function locateKeychainDylib(): string | null {
  const candidate = [
    join(__dirname, "..", "dist", "simkc", "libSimKeychain.dylib"),
    join(__dirname, "simkc", "libSimKeychain.dylib"),
  ].find(existsSync);
  return candidate ? resolve(candidate) : null;
}

// @ref LLP 0017#why-the-write-runs-inside-the-app — the dylib carries the app's entitlements
export const keychainCapability: CapabilityDefinition = {
  name: KEYCHAIN_CAPABILITY,
  defaultEnabled: true,
  scope: "userApps",
  loadDelayMs: 0,
  prebuiltDylib: locateKeychainDylib,
  async setEnabled({ enabled }) {
    if (!enabled) return null;
    // Declined rather than thrown: a checkout without native artifacts still starts, and a keychain
    // command then reports the capability as unavailable.
    const dylib = locateKeychainDylib();
    if (!dylib) debugKeychain("libSimKeychain.dylib is missing; keychain access stays off");
    return dylib ? { dylib } : null;
  },
};

export const KEYCHAIN_ACCESSIBLE = [
  "afterFirstUnlock",
  "afterFirstUnlockThisDeviceOnly",
  "whenUnlocked",
  "whenUnlockedThisDeviceOnly",
  "whenPasscodeSetThisDeviceOnly",
] as const;
export type KeychainAccessible = (typeof KEYCHAIN_ACCESSIBLE)[number];

/** One generic password. Attribute bytes travel as base64 because some libraries store them as data. */
export interface KeychainItemAttributes {
  service: string;
  account: string;
  generic?: string;
  accessGroup?: string;
  /** Store account and generic as data rather than strings; the keychain matches the stored type. */
  attributesAsData?: boolean;
}

export type KeychainOperation =
  | ({
      op: "set";
      data: string;
      accessible?: KeychainAccessible;
      /** Deleted once the set succeeds: other places the same library reads this key. */
      replaces?: KeychainItemAttributes[];
    } & KeychainItemAttributes)
  | ({ op: "delete" } & KeychainItemAttributes)
  | { op: "list"; service?: string; accessGroup?: string };

const KeychainListedItem = z.object({
  service: z.string(),
  account: z.string(),
  accessGroup: z.string().optional(),
});
export type KeychainListedItem = z.infer<typeof KeychainListedItem>;

const KeychainResult = z.object({
  status: z.number().int(),
  error: z.string().optional(),
  items: z.array(KeychainListedItem).optional(),
});
export type KeychainResult = z.infer<typeof KeychainResult>;

const KeychainAnswer = z.object({ nonce: z.string(), results: z.array(KeychainResult) });

function mailboxOf(container: string): string {
  return join(container, "tmp", "serve-sim-keychain");
}

let requestSequence = 0;

/**
 * Sends operations to the keychain dylib inside the app that owns `container`. Resolves the
 * results, or null when nothing answered in time. With `keepQueued`, an unanswered request stays
 * for the app to apply when it next starts; otherwise it is withdrawn.
 */
export async function requestKeychain(
  container: string,
  operations: KeychainOperation[],
  {
    timeoutMs = ANSWER_TIMEOUT_MS,
    keepQueued = false,
  }: { timeoutMs?: number; keepQueued?: boolean } = {},
): Promise<KeychainResult[] | null> {
  if (!isContainerPath(container)) throw new Error(`Not an app data container: ${container}`);
  const mailbox = mailboxOf(container);
  await fs.mkdir(join(mailbox, "requests"), { recursive: true, mode: 0o700 });
  await fs.mkdir(join(mailbox, "responses"), { recursive: true, mode: 0o700 });
  // Serialized so requests reach the app in the order they were made, also across processes.
  return withStateLock(
    join(mailbox, "lock"),
    60_000,
    () => new Error(`Timed out waiting for another keychain request in ${container}`),
    () => requestKeychainUnlocked(mailbox, operations, timeoutMs, keepQueued),
  );
}

async function requestKeychainUnlocked(
  mailbox: string,
  operations: KeychainOperation[],
  timeoutMs: number,
  keepQueued: boolean,
): Promise<KeychainResult[] | null> {
  const nonce = randomUUID();
  const body = JSON.stringify({ nonce, expiresAt: Date.now() + QUEUED_REQUEST_TTL_MS, operations });
  if (Buffer.byteLength(body) > MAX_KEYCHAIN_REQUEST_BYTES) {
    throw new Error(
      `Keychain request is over ${MAX_KEYCHAIN_REQUEST_BYTES} bytes. Send fewer or smaller items.`,
    );
  }
  // Expired requests still hold values; the app would drop them unread at its next start.
  await removeOlderThan(join(mailbox, "requests"), QUEUED_REQUEST_TTL_MS);
  await removeOlderThan(join(mailbox, "responses"), STALE_ANSWER_MS);
  // @ref LLP 0017#the-mailbox — the app handles requests in name order
  // The time keeps that order across server restarts.
  const name = `${Date.now().toString().padStart(15, "0")}-${String(++requestSequence).padStart(6, "0")}-${nonce}.json`;
  const request = join(mailbox, "requests", name);
  const pending = join(mailbox, "requests", `.${name}.pending`);
  const answer = join(mailbox, "responses", `${nonce}.json`);
  // The request can carry secrets: private to this user, and the app deletes it once claimed.
  try {
    await fs.writeFile(pending, body, { mode: 0o600 });
    await fs.rename(pending, request);
  } catch (error) {
    await fs.rm(pending, { force: true });
    throw error;
  }

  const results = await waitForAnswer(answer, nonce, operations.length, timeoutMs);
  if (results) return results;
  // The app claims a request by renaming it, so a missing file means it is running now.
  const stillWaiting = keepQueued
    ? await fs.access(request).then(
        () => true,
        () => false,
      )
    : await fs.unlink(request).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
  if (stillWaiting) {
    debugKeychain("no answer for %s within %dms (keepQueued=%s)", name, timeoutMs, keepQueued);
    return null;
  }
  const late = await waitForAnswer(answer, nonce, operations.length, CLAIMED_ANSWER_GRACE_MS);
  if (late) return late;
  throw new Error(
    "The app took the keychain request but did not answer. It may have quit; check the result with " +
      "`serve-sim keychain list` and retry.",
  );
}

async function waitForAnswer(
  answer: string,
  nonce: string,
  operationCount: number,
  timeoutMs: number,
): Promise<KeychainResult[] | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await fs.readFile(answer, "utf-8").catch(() => null);
    if (text !== null) {
      await fs.rm(answer, { force: true });
      let payload: unknown = null;
      try {
        payload = JSON.parse(text);
      } catch {}
      const parsed = KeychainAnswer.safeParse(payload);
      // One result per operation; none means the app could not read the request.
      if (
        !parsed.success ||
        parsed.data.nonce !== nonce ||
        parsed.data.results.length !== operationCount
      ) {
        throw new Error(
          "The app sent an unreadable keychain answer. Update serve-sim and restart the app.",
        );
      }
      return parsed.data.results;
    }
    await sleep(ANSWER_POLL_MS);
  }
  return null;
}

async function removeOlderThan(dir: string, ageMs: number): Promise<void> {
  const cutoff = Date.now() - ageMs;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name);
    const stat = await fs.stat(path).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(path, { force: true });
  }
}

export type KeychainOutcome = { applied: true; results: KeychainResult[] } | { applied: false };

/**
 * Runs operations in an installed app's keychain. An app that is not running, or that started before
 * the session armed the capability loader, does not answer; with `keepQueued` its request waits for
 * the app's next launch.
 */
export async function runKeychainOperations(
  udid: string,
  bundleId: string,
  operations: KeychainOperation[],
  options: { timeoutMs?: number; keepQueued?: boolean } = {},
): Promise<KeychainOutcome> {
  // The loader injects into user apps only, so a system app would never answer.
  if (bundleId.startsWith("com.apple.")) {
    throw new Error(
      `${bundleId} is a system app. serve-sim reaches the keychain of user apps only.`,
    );
  }
  if (!isCapabilityEnabled(udid, KEYCHAIN_CAPABILITY)) {
    throw new Error(
      "Keychain access is unavailable. Start a serve-sim session with the keychain capability for this simulator and retry.",
    );
  }
  const container = await simctl(["get_app_container", udid, bundleId, "data"]).catch(
    (error: unknown) => {
      if (error instanceof Error && error.message.includes(APP_NOT_INSTALLED)) return "";
      throw error;
    },
  );
  if (!isContainerPath(container)) {
    throw new Error(`${bundleId} is not installed on ${udid}. Install the app and retry.`);
  }
  const results = await requestKeychain(container, operations, options);
  return results ? { applied: true, results } : { applied: false };
}
