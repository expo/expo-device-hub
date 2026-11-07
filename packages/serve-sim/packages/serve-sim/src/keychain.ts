import {
  runKeychainOperations,
  type KeychainAccessible,
  type KeychainItemAttributes,
  type KeychainItemQuery,
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

export const KEYCHAIN_FORMATS = [
  "expo-secure-store",
  "generic-password",
  "react-native-keychain",
  "keychain-access",
  "keychain-swift",
] as const;
export type KeychainFormatName = (typeof KEYCHAIN_FORMATS)[number];

export interface KeychainFormatOptions {
  /**
   * expo-secure-store: its `keychainService` option. generic-password: the item's service.
   * keychain-access: `Keychain(service:)`, the bundle ID when omitted.
   */
  service?: string;
  /** react-native-keychain: the username stored with each password; empty when omitted. */
  username?: string;
  /** keychain-swift: `KeychainSwift(keyPrefix:)`, which the library puts before each key. */
  keyPrefix?: string;
  /** The app, from the target: keychain-access uses it when no service is given. */
  bundleId?: string;
  accessGroup?: string;
  accessible?: KeychainAccessible;
}

/** How one library lays out a string key/value pair as keychain attributes. */
interface KeychainFormat {
  /** Whether the format takes a service, and whether it needs one. */
  service: "required" | "optional" | "none";
  /** The one option only some formats take, if this format takes it. */
  option?: "username" | "keyPrefix";
  /**
   * Every place the library may store `key`. `set` writes the first and, once that succeeds,
   * removes the others, as the library's own write does; `delete` removes all of them.
   */
  places(key: string, options: KeychainFormatOptions): KeychainItemAttributes[];
  /**
   * Everything `key` covers, in a library whose write first deletes more than the key's own item:
   * `set` deletes it before the write, and `delete` deletes it in place of `places`.
   */
  clears?(key: string, options: KeychainFormatOptions): KeychainItemQuery[];
  /** The key a listed item holds, or null when the item is not this format's. */
  keyOf(item: KeychainListedItem, options: KeychainFormatOptions): string | null;
  defaultAccessible: KeychainAccessible;
  checkKey(key: string): string | null;
}

const b64 = (text: string) => Buffer.from(text, "utf-8").toString("base64");
const fromB64 = (value: string) => Buffer.from(value, "base64").toString("utf-8");
const nonEmpty = (key: string) => (key.length > 0 ? null : "Keys cannot be empty.");

function withGroup<T extends KeychainItemQuery>(attributes: T, options: KeychainFormatOptions): T {
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

/** The key as a string account in one service, as most Swift and Objective-C wrappers store it. */
function accountInService(
  serviceOf: (options: KeychainFormatOptions) => string,
): Pick<KeychainFormat, "places" | "keyOf"> {
  return {
    places: (key, options) => [
      withGroup({ service: serviceOf(options), account: b64(key) }, options),
    ],
    keyOf: (item, options) => (item.service === serviceOf(options) ? fromB64(item.account) : null),
  };
}

const genericPassword: KeychainFormat = {
  service: "required",
  ...accountInService((options) => options.service!),
  defaultAccessible: "afterFirstUnlock",
  checkKey: nonEmpty,
};

// Mirrors KeychainAccess's Keychain.swift (v4.2.2): `Keychain(service:)` stores the key as a string
// account in the service, and `Keychain()` uses the bundle ID. A set updates an existing item or
// adds one, and `allKeys()` lists the accounts in the service.
const keychainAccess: KeychainFormat = {
  service: "optional",
  ...accountInService((options) => {
    const service = options.service ?? options.bundleId;
    if (!service)
      throw new Error("The keychain-access format needs a service or the app's bundle ID.");
    return service;
  }),
  defaultAccessible: "afterFirstUnlock",
  checkKey: nonEmpty,
};

// Mirrors react-native-keychain's RNKeychainManager.m (v10) generic passwords: one credential per
// service, the username as a string account and the password as data. `setGenericPassword` deletes
// every item in the service before it adds, and `getAllGenericPasswordServices` lists services.
const reactNativeKeychain: KeychainFormat = {
  service: "none",
  option: "username",
  places: (key, options) => [
    withGroup({ service: key, account: b64(options.username ?? "") }, options),
  ],
  clears: (key, options) => [withGroup({ service: key }, options)],
  // A key names a service, so an item without one, such as KeychainSwift's, is not listed.
  keyOf: (item) => item.service || null,
  defaultAccessible: "afterFirstUnlock",
  checkKey: nonEmpty,
};

// Mirrors KeychainSwift's KeychainSwift.swift (24.0.0): the key, after `keyPrefix`, as a string
// account with no service, and `whenUnlocked`. Reads match the account alone, and a set first
// deletes every item with that account, in any service. `allKeys` lists accounts.
const keychainSwift: KeychainFormat = {
  service: "none",
  option: "keyPrefix",
  places: (key, options) => [
    withGroup({ account: b64(`${options.keyPrefix ?? ""}${key}`) }, options),
  ],
  clears: (key, options) => keychainSwift.places(key, options),
  // Its own items have no service; other libraries' items with a matching account are left out.
  keyOf: (item, { keyPrefix = "" }) => {
    const account = fromB64(item.account);
    return item.service === "" && account.startsWith(keyPrefix)
      ? account.slice(keyPrefix.length)
      : null;
  },
  defaultAccessible: "whenUnlocked",
  checkKey: nonEmpty,
};

const FORMATS: Record<KeychainFormatName, KeychainFormat> = {
  "expo-secure-store": expoSecureStore,
  "generic-password": genericPassword,
  "react-native-keychain": reactNativeKeychain,
  "keychain-access": keychainAccess,
  "keychain-swift": keychainSwift,
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
  if (definition.service === "none" && options.service !== undefined) {
    throw new Error(`The ${format} format takes no service.`);
  }
  for (const [option, label] of [
    ["username", "username"],
    ["keyPrefix", "key prefix"],
  ] as const) {
    if (options[option] !== undefined && definition.option !== option) {
      throw new Error(`The ${format} format takes no ${label}.`);
    }
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
      ...(definition.clears ? { clears: definition.clears(key, options) } : {}),
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
  const covered = FORMATS[format].clears ?? FORMATS[format].places;
  return keys.map((key) => covered(key, options).map((place) => ({ op: "delete", ...place })));
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
  /** The format's options; the bundle ID comes from the target. */
  options: Omit<KeychainFormatOptions, "bundleId">;
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

const formatOptions = (target: KeychainTarget): KeychainFormatOptions => ({
  ...target.options,
  bundleId: target.bundleId,
});

function keyResult(verb: "set" | "delete", key: string, status: number): KeychainKeyResult {
  const ok = status === SUCCESS || (verb === "delete" && status === NOT_FOUND);
  return { key, status, ok, message: describeKeychainStatus(status) };
}

export async function setKeychainValues(
  target: KeychainTarget,
  entries: [key: string, value: string][],
  { relaunch = false }: { relaunch?: boolean } = {},
): Promise<KeychainWriteSummary> {
  const operations = keychainSetOperations(target.format, entries, formatOptions(target));
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
  const groups = keychainDeleteOperations(target.format, keys, formatOptions(target));
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
  assertKeychainRequest(target.format, [], formatOptions(target));
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
  return keychainKeys(target.format, result.items ?? [], formatOptions(target));
}
