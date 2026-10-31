import { type KeychainWriteResult } from "@expo/hub-client";

export type KeychainDraft =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/** One key and its value, or, with no key, a pasted JSON object of string keys and values. */
export function parseKeychainDraft(key: string, value: string): KeychainDraft {
  const name = key.trim();
  if (name) return { ok: true, values: { [name]: value } };
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    payload = null;
  }
  const entries =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.entries(payload)
      : [];
  if (entries.length === 0 || !entries.every(([, item]) => typeof item === "string")) {
    return { ok: false, error: "Enter a key, or paste a JSON object of keys and values." };
  }
  return { ok: true, values: Object.fromEntries(entries) as Record<string, string> };
}

function keysLabel(keys: string[]): string {
  return keys.length === 1 ? keys[0]! : `${keys.length} keys`;
}

/** What a write did, as one note and, for keys that failed, one error. */
export function describeKeychainWrite(
  kind: "set" | "delete",
  result: KeychainWriteResult,
  relaunched: boolean,
  appId: string,
): { note: string | null; error: string | null } {
  if (!result.applied) {
    // serve-sim cannot tell a closed app from one opened before the session started.
    const queued = `${appId} did not answer. It applies the change if it starts within the next hour.`;
    return {
      note: kind === "set" ? `${queued} If it is open, use Set and relaunch.` : queued,
      error: null,
    };
  }
  const done = result.keys.filter(({ ok }) => ok);
  const failed = result.keys.filter(({ ok }) => !ok);
  const verb = kind === "set" ? "Set" : "Deleted";
  return {
    note:
      done.length > 0
        ? `${verb} ${keysLabel(done.map(({ key }) => key))} in ${appId}.${relaunched ? " The app restarted." : ""}`
        : null,
    error:
      failed.length > 0 ? failed.map(({ key, message }) => `${key}: ${message}`).join("; ") : null,
  };
}
