import {
  type KeychainFormat,
  type KeychainOptions,
  type KeychainWriteResult,
} from "@expo/hub-client";
import { type SelectOption } from "../primitives";

/** The field beside the key: an option of the format, such as the service the app passes. */
interface KeychainField {
  option: Exclude<keyof KeychainOptions, "format">;
  label: string;
  description: string;
  placeholder: string;
  required: boolean;
}

/** How the section names each layout, its field, and an empty list. */
export const KEYCHAIN_FORMAT_UI: Record<
  KeychainFormat,
  { label: string; keyPlaceholder?: string; field: KeychainField; empty: string }
> = {
  "expo-secure-store": {
    label: "Expo SecureStore",
    field: {
      option: "service",
      label: "Service",
      description: "SecureStore keychainService",
      placeholder: "app",
      required: false,
    },
    empty: "This app stored no SecureStore values.",
  },
  "generic-password": {
    label: "Generic password",
    field: {
      option: "service",
      label: "Service",
      description: "The item service",
      placeholder: "com.example.app",
      required: true,
    },
    empty: "This service has no items.",
  },
};

export const KEYCHAIN_FORMAT_OPTIONS: SelectOption<KeychainFormat>[] = Object.entries(
  KEYCHAIN_FORMAT_UI,
).map(([value, { label }]) => ({ value: value as KeychainFormat, label }));

/** The required field's name, lowercase, when `options` leave it empty. */
export function missingKeychainField(options: KeychainOptions): string | null {
  const { field } = KEYCHAIN_FORMAT_UI[options.format ?? "expo-secure-store"];
  return field.required && !options[field.option] ? field.label.toLowerCase() : null;
}

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
