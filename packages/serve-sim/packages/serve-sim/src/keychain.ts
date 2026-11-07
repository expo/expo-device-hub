import {
  runKeychainOperations,
  type KeychainAccessible,
  type KeychainItemAttributes,
  type KeychainListedItem,
  type KeychainOperation,
  type KeychainResult,
} from "./sim-keychain";

// errSec* values from Security/SecBase.h.
const SUCCESS = 0;
const NOT_FOUND = -25300;
const STATUS_MESSAGES: Record<number, string> = {
  [-25299]: "an item with these attributes already exists",
  [NOT_FOUND]: "not found",
  [-34018]:
    "the app has no keychain entitlement or may not use this access group; build it with Xcode or EAS",
  [-50]: "invalid attributes",
};

export function describeKeychainStatus(status: number): string {
  return status === SUCCESS ? "ok" : (STATUS_MESSAGES[status] ?? `keychain error ${status}`);
}

export const KEYCHAIN_FORMATS = ["expo-secure-store", "generic-password"] as const;
export type KeychainFormatName = (typeof KEYCHAIN_FORMATS)[number];

export interface KeychainFormatOptions {
  /** expo-secure-store: its `keychainService` option. generic-password: the item's service. */
  service?: string;
  accessGroup?: string;
  accessible?: KeychainAccessible;
}

/** How one library lays out a string key/value pair as keychain attributes. */
interface KeychainFormat {
  /** Whether the format needs a service. */
  service: "required" | "optional";
  /**
   * Every place the library may store `key`. `set` writes the first and, once that succeeds,
   * removes the others, as the library's own write does; `delete` removes all of them.
   */
  places(key: string, options: KeychainFormatOptions): KeychainItemAttributes[];
  /** The key a listed item holds, or null when the item is not this format's. */
  keyOf(item: KeychainListedItem, options: KeychainFormatOptions): string | null;
  defaultAccessible: KeychainAccessible;
  checkKey(key: string): string | null;
}

const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");
const fromB64 = (value: string) => Buffer.from(value, "base64").toString("utf-8");
const nonEmpty = (key: string) => (key.length > 0 ? null : "Keys cannot be empty.");

function withGroup(
  attributes: KeychainItemAttributes,
  options: KeychainFormatOptions,
): KeychainItemAttributes {
  return options.accessGroup ? { ...attributes, accessGroup: options.accessGroup } : attributes;
}

// Mirrors expo-secure-store's SecureStoreModule.swift `query(with:options:requireAuthentication:)`:
// reads try `<service>:no-auth`, then `<service>:auth`, then the legacy `<service>`. Its `set`
// deletes the other two after a successful add.
const expoServices = ({ service = "app" }: KeychainFormatOptions) => [
  `${service}:no-auth`,
  `${service}:auth`,
  service,
];

const expoSecureStore: KeychainFormat = {
  service: "optional",
  places(key, options) {
    const account = b64(key);
    return expoServices(options).map((service) =>
      withGroup({ service, account, generic: account, attributesAsData: true }, options),
    );
  },
  keyOf: (item, options) =>
    expoServices(options).includes(item.service) ? fromB64(item.account) : null,
  defaultAccessible: "whenUnlocked",
  checkKey(key) {
    // expo-secure-store refuses other keys before it reaches the keychain.
    return /^[\w.-]+$/.test(key)
      ? null
      : `expo-secure-store keys contain only letters, digits, ".", "-", and "_": ${JSON.stringify(key)}`;
  },
};

const genericPassword: KeychainFormat = {
  service: "required",
  places: (key, options) => [withGroup({ service: options.service!, account: b64(key) }, options)],
  keyOf: (item, options) => (item.service === options.service ? fromB64(item.account) : null),
  defaultAccessible: "afterFirstUnlock",
  checkKey: nonEmpty,
};

const FORMATS: Record<KeychainFormatName, KeychainFormat> = {
  "expo-secure-store": expoSecureStore,
  "generic-password": genericPassword,
};

/** Refuses keys and options the format cannot store, before any request leaves. */
function assertKeychainRequest(
  format: KeychainFormatName,
  keys: string[],
  options: KeychainFormatOptions,
): void {
  const definition = FORMATS[format];
  if (options.service === "") throw new Error("A service cannot be empty.");
  if (definition.service === "required" && options.service === undefined) {
    throw new Error(`The ${format} format needs a service.`);
  }
  for (const key of keys) {
    const problem = definition.checkKey(key);
    if (problem) throw new Error(problem);
  }
}

export function keychainSetOperations(
  format: KeychainFormatName,
  entries: [key: string, value: string][],
  options: KeychainFormatOptions,
): KeychainOperation[] {
  const definition = FORMATS[format];
  assertKeychainRequest(
    format,
    entries.map(([key]) => key),
    options,
  );
  return entries.map(([key, value]) => {
    const [target, ...others] = definition.places(key, options);
    return {
      op: "set",
      ...target!,
      data: b64(value),
      accessible: options.accessible ?? definition.defaultAccessible,
      ...(others.length > 0 ? { replaces: others } : {}),
    };
  });
}

/** One group of delete operations per key, in key order. */
export function keychainDeleteOperations(
  format: KeychainFormatName,
  keys: string[],
  options: KeychainFormatOptions,
): KeychainOperation[][] {
  assertKeychainRequest(format, keys, options);
  return keys.map((key) =>
    FORMATS[format].places(key, options).map((place) => ({ op: "delete", ...place })),
  );
}

/** The first error, as a copy that stays is still read; else deleted when any copy went away. */
export function deleteStatus(results: KeychainResult[]): number {
  const failure = results.find(({ status }) => status !== SUCCESS && status !== NOT_FOUND);
  if (failure) return failure.status;
  return results.some(({ status }) => status === SUCCESS) ? SUCCESS : NOT_FOUND;
}

/** The keys a format stored, from a `list` result, sorted and without duplicates. */
export function keychainKeys(
  format: KeychainFormatName,
  items: KeychainListedItem[],
  options: KeychainFormatOptions,
): string[] {
  const keys = items.flatMap((item) => FORMATS[format].keyOf(item, options) ?? []);
  return [...new Set(keys)].sort();
}

export interface KeychainTarget {
  udid: string;
  bundleId: string;
  format: KeychainFormatName;
  options: KeychainFormatOptions;
}

export interface KeychainKeyResult {
  key: string;
  status: number;
  /** The key is set, or deleted; a delete of a key that did not exist counts. */
  ok: boolean;
  message: string;
}

/** Not applied: the app did not answer, and applies the request when it next starts. */
export type KeychainWriteSummary =
  | { applied: true; keys: KeychainKeyResult[] }
  | { applied: false };

function keyResult(verb: "set" | "delete", key: string, status: number): KeychainKeyResult {
  const ok = status === SUCCESS || (verb === "delete" && status === NOT_FOUND);
  return { key, status, ok, message: describeKeychainStatus(status) };
}

export async function setKeychainValues(
  target: KeychainTarget,
  entries: [key: string, value: string][],
  { relaunch = false }: { relaunch?: boolean } = {},
): Promise<KeychainWriteSummary> {
  const operations = keychainSetOperations(target.format, entries, target.options);
  const outcome = await runKeychainOperations(target.udid, target.bundleId, operations, {
    keepQueued: true,
    relaunch,
  });
  if (!outcome.applied) return { applied: false };
  return {
    applied: true,
    keys: entries.map(([key], index) => keyResult("set", key, outcome.results[index]!.status)),
  };
}

export async function deleteKeychainValues(
  target: KeychainTarget,
  keys: string[],
  { relaunch = false }: { relaunch?: boolean } = {},
): Promise<KeychainWriteSummary> {
  const groups = keychainDeleteOperations(target.format, keys, target.options);
  const outcome = await runKeychainOperations(target.udid, target.bundleId, groups.flat(), {
    keepQueued: true,
    relaunch,
  });
  if (!outcome.applied) return { applied: false };
  // One result per operation, in order, so each key takes the next group's worth.
  const results = [...outcome.results];
  return {
    applied: true,
    keys: keys.map((key, index) =>
      keyResult("delete", key, deleteStatus(results.splice(0, groups[index]!.length))),
    ),
  };
}

export async function listKeychainKeys(target: KeychainTarget): Promise<string[]> {
  assertKeychainRequest(target.format, [], target.options);
  const { accessGroup } = target.options;
  const outcome = await runKeychainOperations(target.udid, target.bundleId, [
    accessGroup ? { op: "list", accessGroup } : { op: "list" },
  ]);
  if (!outcome.applied) {
    throw new Error(
      `${target.bundleId} did not answer. Open it in a serve-sim session and retry; an app ` +
        "opened before the session started needs a restart.",
    );
  }
  const result = outcome.results[0]!;
  if (result.status !== SUCCESS) {
    throw new Error(`Could not list keychain items: ${describeKeychainStatus(result.status)}.`);
  }
  return keychainKeys(target.format, result.items ?? [], target.options);
}
