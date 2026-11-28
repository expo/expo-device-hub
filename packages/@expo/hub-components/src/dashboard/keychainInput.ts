import {
  type KeychainFormat,
  type KeychainOptions,
  type KeychainWriteResult,
} from "@expo/hub-client";
import { type SelectOption } from "../primitives";

/** The field beside the key: an option of the format, such as the service the app passes. */
interface KeychainField {
  option: "service" | "username";
  label: string;
  description: string;
  placeholder: string;
  required: boolean;
}

/**
 * How the section names each layout, its field, and an empty list. `note` warns where a write
 * reaches items beyond the listed key, as the library's own does.
 */
export const KEYCHAIN_FORMAT_UI: Record<
  KeychainFormat,
  { label: string; keyPlaceholder?: string; field: KeychainField; empty: string; note?: string }
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
  "react-native-keychain": {
    label: "react-native-keychain",
    keyPlaceholder: "Service, such as the bundle ID",
    field: {
      option: "username",
      label: "Username",
      description: "Stored with each password",
      placeholder: "user@example.com",
      required: false,
    },
    empty: "This app has no generic-password services.",
    note: "Each key is a service. Set and Delete clear its local items in the app’s access group, including items from other libraries.",
  },
};

export const KEYCHAIN_FORMAT_OPTIONS: SelectOption<KeychainFormat>[] = Object.entries(
  KEYCHAIN_FORMAT_UI,
).map(([value, { label }]) => ({ value: value as KeychainFormat, label }));

/** The required field's name, lowercase, when `options` leave it empty. */
export function missingKeychainField(options: KeychainOptions): string | null {
  const { field } = KEYCHAIN_FORMAT_UI[options.format ?? "expo-secure-store"];
  return field.option === "service" && field.required && !options.service ? "service" : null;
}

export type KeychainDraft =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/** One key and its value, or, with no key, a pasted JSON object of string keys and values. */
export function parseKeychainDraft(key: string, value: string): KeychainDraft {
  if (key) return { ok: true, values: { [key]: value } };
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

/** @ref LLP 0020#hub-ui — show significant whitespace while sending the original identifier. */
export function displayKeychainIdentifier(identifier: string): string {
  if (identifier === identifier.trim() && !/ {2,}|[^\S ]|"/.test(identifier)) return identifier;
  return JSON.stringify(identifier).replace(/\s/g, (space) => {
    const codePoint = space.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${codePoint}`;
  });
}

function keysLabel(keys: string[]): string {
  return keys.length === 1 ? displayKeychainIdentifier(keys[0]!) : `${keys.length} keys`;
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
    const queued = `Change queued for ${appId}. The request expires in one hour.`;
    return {
      note: kind === "set" ? `${queued} If the app is open, use Set and relaunch.` : queued,
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
      failed.length > 0
        ? failed
            .map(({ key, message }) => `${displayKeychainIdentifier(key)}: ${message}`)
            .join("; ")
        : null,
  };
}
